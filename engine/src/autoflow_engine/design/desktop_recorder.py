"""Record what a person does on the PC: clicks, typing, choices and shortcuts in any program.

Two threads do the work:

* the hook thread installs low-level mouse and keyboard hooks. Windows drops hooks that are
  slow to answer, so they only note what happened and return;
* the worker thread turns those notes into recorded actions with UI Automation (which control
  was clicked, what a box contains) and shows a small "Recording - Stop" bar.

Typed text is read from the box when the person leaves it instead of being rebuilt from key
presses, so it works with every keyboard layout (Arabic too), paste and autocomplete. Passwords
are never read. Studio, the Start menu and the taskbar are not recorded.
"""

from __future__ import annotations

import contextlib
import ctypes
import logging
import os
import queue
import threading
import time
import uuid
from collections.abc import Callable
from ctypes import wintypes
from dataclasses import dataclass, field
from typing import Any

from ..flow import Element
from ..selectors.desktop import (
    candidate_selectors,
    friendly_name,
    friendly_type,
    process_name,
    process_path,
    selectors_for,
    specific,
    top_window,
    uia,
)
from .desktop_picker import _thumbnail

log = logging.getLogger("autoflow.design.recorder")

Respond = Callable[..., None]
Notify = Callable[[str, dict[str, Any]], None]

POLL_S = 0.25
MERGE_KEYS_S = 2.0
# Clicking these doesn't do anything a robot needs to repeat.
SKIP_CLICK = {"ScrollBar", "Thumb", "TitleBar", "Separator", "ToolTip", "Window", "MenuBar", "ToolBar", "StatusBar"}
SHELL_PROCESSES = {
    "startmenuexperiencehost.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe",
    "textinputhost.exe", "lockapp.exe", "shellhost.exe",
}
SHELL_CLASSES = {
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
}

# Keys worth recording on their own (outside a text box). Letters and digits only count with Ctrl/Alt/Win.
KEY_NAMES = {
    0x0D: "Enter", 0x09: "Tab", 0x1B: "Escape", 0x2E: "Delete", 0x08: "Backspace", 0x20: "Space",
    0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down", 0x24: "Home", 0x23: "End",
    0x21: "PageUp", 0x22: "PageDown", **{0x70 + i: f"F{i + 1}" for i in range(12)},
}
MODIFIER_KEYS = {0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5}
EDITING_SHORTCUTS = {"A", "C", "V", "X", "Z", "Y"}  # inside a text box these only change its text


@dataclass
class _Field:
    """A box or list the person is in; what they typed or chose is recorded when they leave it."""

    control: Any
    window: Any
    runtime_id: tuple
    kind: str  # "type" | "select"
    element: Element
    initial: str | None
    last: str | None
    password: bool
    typed: bool = False


@dataclass
class _State:
    actions: list[dict[str, Any]] = field(default_factory=list)
    last_window: int | None = None
    last_was_shell: bool = False
    last_click: tuple[tuple, float] | None = None
    last_keys_at: float = 0.0


class DesktopRecorder:
    def __init__(self, notify: Notify, ignore_pids: set[int] | None = None):
        self._notify = notify
        self._ignore = ignore_pids if ignore_pids is not None else {os.getppid(), os.getpid()}
        self._events: queue.Queue[tuple] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = _State()
        self._field: _Field | None = None
        self._pids_at_start: set[int] = set()
        self._launched: set[int] = set()
        self._stopped_from_bar = False

    @property
    def active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # -- RPC ------------------------------------------------------------------------------
    def start(self, respond: Respond) -> None:
        if self.active:
            respond(error=RuntimeError("Already recording."))
            return
        self._stop.clear()
        self._events = queue.Queue()
        self._state = _State()
        self._field = None
        self._stopped_from_bar = False
        self._thread = threading.Thread(target=self._run, args=(respond,), name="desktop-recorder", daemon=True)
        self._thread.start()

    def stop(self, respond: Respond) -> None:
        def finish() -> None:
            self._stop.set()
            if self._thread is not None:
                self._thread.join(30)
            respond(result={"actions": self._state.actions})

        threading.Thread(target=finish, name="desktop-recorder-stop", daemon=True).start()

    def cancel(self) -> None:
        self._stop.set()

    # -- worker ---------------------------------------------------------------------------
    def _run(self, respond: Respond) -> None:
        auto = uia()
        hooks: _Hooks | None = None
        bar: _Bar | None = None
        try:
            with auto.UIAutomationInitializerInThread():
                self._pids_at_start = {w.ProcessId for w in auto.GetRootControl().GetChildren()}
                hooks = _Hooks(self._events)
                hooks.start()
                bar = _Bar(self._stop_from_bar)
                respond(result={"started": True})
                last_poll = 0.0
                while not self._stop.is_set():
                    try:
                        event = self._events.get(timeout=0.05)
                    except queue.Empty:
                        event = None
                    if event is not None:
                        try:
                            self._handle(auto, event)
                        except Exception:
                            log.exception("could not record %s", event[0])
                    if time.monotonic() - last_poll > POLL_S:
                        last_poll = time.monotonic()
                        with contextlib.suppress(Exception):
                            self._poll_focus(auto)
                    bar.update(len(self._state.actions))
                self._finish_field()
        except Exception as exc:
            log.exception("desktop recording failed")
            respond(error=exc)  # ignored if it already answered
        finally:
            if hooks is not None:
                hooks.stop()
            if bar is not None:
                bar.close()
        if self._stopped_from_bar:
            self._notify("recorder.stopped", {"count": len(self._state.actions)})

    def _stop_from_bar(self) -> None:
        self._stopped_from_bar = True
        self._stop.set()

    def _handle(self, auto: Any, event: tuple) -> None:
        if event[0] == "mouse":
            _, button, x, y, at = event
            self._on_click(auto, button, x, y, at)
        elif event[0] == "key":
            _, vk, mods, at = event
            self._on_key(vk, mods, at)

    # -- clicks -----------------------------------------------------------------------------
    def _on_click(self, auto: Any, button: str, x: int, y: int, at: float) -> None:
        control = auto.ControlFromPoint(x, y)
        if control is None:
            return
        window = top_window(control)
        if self._ignored(window):
            return
        runtime_id = tuple(control.GetRuntimeId() or ())
        ctype = friendly_type(control)

        # The second click of a double-click turns the recorded click into a double-click.
        if button == "left" and self._state.last_click and self._state.last_click[0] == runtime_id \
                and at - self._state.last_click[1] < _double_click_s():
            self._state.last_click = None
            last = self._state.actions[-1] if self._state.actions else None
            if last and last.get("action") == "click":
                last["click"] = "double"
                self._notify("recorder.action", {**last, "replace_last": True})
            return

        combo = self._combo_of(control, ctype)
        if combo is not None:  # opening a dropdown or picking from it: recorded as one choice
            if not (self._field and self._field.runtime_id == tuple(combo.GetRuntimeId() or ())):
                self._finish_field()
                self._track(combo, window, "select")
            return
        if button == "left" and _is_text_box(control, ctype):  # typing is recorded when they leave it
            if not (self._field and self._field.runtime_id == runtime_id):
                self._finish_field()
                self._track(control, window, "type")
            return
        if ctype in SKIP_CLICK or tuple(window.GetRuntimeId() or ()) == runtime_id:
            return
        if ctype == "Pane" and not (control.Name or control.AutomationId):
            return

        self._finish_field()
        element = self._element(control, window)
        if element is None:
            return
        if ctype == "CheckBox" and button == "left":
            # Read the box after the program has handled the click (it toggles on release), so the
            # step records how it ended up, whatever the timing.
            time.sleep(0.3)
            self._emit({"action": "check", "element": element.model_dump(), "checked": _toggle_state(control)}, window)
        else:
            self._emit({"action": "click", "element": element.model_dump(), "click": "right" if button == "right" else "single"}, window)
        self._state.last_click = (runtime_id, at) if button == "left" else None

    def _combo_of(self, control: Any, ctype: str) -> Any | None:
        if ctype == "ComboBox":
            return control
        if ctype in ("ListItem", "List", "Button", "Edit"):
            parent = control
            for _ in range(4):
                parent = parent.GetParentControl()
                if parent is None:
                    break
                if parent.ControlTypeName == "ComboBoxControl":
                    return parent
        if ctype == "ListItem" and self._field and self._field.kind == "select":
            return self._field.control  # an item in the open dropdown of the list being used
        return None

    # -- keys -------------------------------------------------------------------------------
    def _on_key(self, vk: int, mods: tuple[bool, bool, bool, bool], at: float) -> None:
        if vk in MODIFIER_KEYS:
            return
        ctrl, alt, shift, win = mods
        name = KEY_NAMES.get(vk) or (chr(vk) if 0x30 <= vk <= 0x39 or 0x41 <= vk <= 0x5A else None)
        current = self._field
        if not (ctrl or alt or win):
            if name == "Enter" and current is not None:
                if not self._finish_field(press_enter=current.kind == "type"):
                    self._emit_keys("Enter", current.window, at)
                return
            if name == "Tab":
                self._finish_field()  # the next step finds its own box; Tab isn't needed
                return
            if current is not None:
                if current.password and name not in KEY_NAMES.values():
                    current.typed = True
                return  # editing inside the box or list: the result is recorded when they leave
            if name in KEY_NAMES.values():
                self._emit_keys(("Shift+" if shift else "") + name, None, at)
            return
        if name is None:
            return
        if current is not None and current.kind == "type" and ctrl and not (alt or win) and name in EDITING_SHORTCUTS:
            return
        combo = "+".join([*(["Control"] if ctrl else []), *(["Alt"] if alt else []), *(["Shift"] if shift else []),
                          *(["Win"] if win else []), name])
        self._finish_field()  # e.g. Ctrl+S saves the form: record what was typed first
        self._emit_keys(combo, None, at)

    def _emit_keys(self, keys: str, window: Any | None, at: float) -> None:
        auto = uia()
        if window is None:
            with contextlib.suppress(Exception):
                window = top_window(auto.GetForegroundControl())
        if window is None or self._ignored(window):
            return
        last = self._state.actions[-1] if self._state.actions else None
        same_window = self._state.last_window == window.NativeWindowHandle
        if last and last.get("action") == "keys" and same_window and at - self._state.last_keys_at < MERGE_KEYS_S:
            last["keys"] = f"{last['keys']}, {keys}"
            self._notify("recorder.action", {**last, "replace_last": True})
        else:
            self._emit({"action": "keys", "keys": keys}, window)
        self._state.last_keys_at = at

    # -- boxes and lists ----------------------------------------------------------------------
    def _poll_focus(self, auto: Any) -> None:
        focused = auto.GetFocusedControl()
        if focused is None:
            return
        runtime_id = tuple(focused.GetRuntimeId() or ())
        current = self._field
        if current is not None and current.runtime_id == runtime_id:
            value = _read(current.control, current.kind)
            if value is not None:
                current.last = value
            return
        if current is not None and current.kind == "select" and focused.ControlTypeName in ("ListItemControl", "ListControl"):
            return  # moving through the open dropdown of that list
        window = top_window(focused)
        if self._ignored(window):
            return
        ctype = friendly_type(focused)
        kind = "select" if ctype == "ComboBox" else "type" if _is_text_box(focused, ctype) else None
        self._finish_field()
        if kind:
            self._track(focused, window, kind)

    def _track(self, control: Any, window: Any, kind: str) -> None:
        control = specific(control)
        element = self._element(control, window)
        if element is None:
            return
        password = bool(_safe(lambda: control.IsPassword))
        value = None if password else _read(control, kind)
        self._field = _Field(control, window, tuple(control.GetRuntimeId() or ()), kind, element, value, value, password)

    def _finish_field(self, press_enter: bool = False) -> bool:
        """Record what was typed or chosen in the box being left. True if something was recorded."""
        current, self._field = self._field, None
        if current is None:
            return False
        if current.password:
            if not current.typed:
                return False
            action = {"action": "type", "element": current.element.model_dump(), "value": None, "password": True}
        else:
            final = _read(current.control, current.kind)
            final = current.last if final is None else final
            if final is None or final == current.initial:
                return False
            if current.kind == "select":
                action = {"action": "select", "element": current.element.model_dump(), "option": final}
            else:
                action = {"action": "type", "element": current.element.model_dump(), "value": final}
        if press_enter:
            action["press_enter"] = True
        self._emit(action, current.window)
        return True

    # -- helpers --------------------------------------------------------------------------------
    def _emit(self, action: dict[str, Any], window: Any) -> None:
        self._switch_to(window)
        self._state.actions.append(action)
        self._notify("recorder.action", action)

    def _switch_to(self, window: Any) -> None:
        """Before the first action in another window: bring it to the front (or start the program)."""
        handle = window.NativeWindowHandle
        if handle == self._state.last_window:
            return
        self._state.last_window = handle
        title = (window.Name or "").strip()
        pid = window.ProcessId
        program = process_name(pid).lower()
        started_here = pid not in self._pids_at_start and pid not in self._launched
        if started_here:
            self._launched.add(pid)
        if started_here and not self._state.last_was_shell and (path := process_path(pid)):
            action = {"action": "launch", "program": path, "window": title}
        else:
            # Opened by an earlier recorded step (e.g. a double-click in File Explorer) or already open.
            action = {"action": "activate", "window": title}
        self._state.last_was_shell = program == "explorer.exe"
        if title or action["action"] == "launch":
            self._state.actions.append(action)
            self._notify("recorder.action", action)

    def _element(self, control: Any, window: Any) -> Element | None:
        control = specific(control)
        ctype = friendly_type(control)
        try:
            selectors = selectors_for(control, window)
        except Exception:
            # e.g. the dialog closed right after the click: keep the best unchecked guesses
            selectors = candidate_selectors(ctype, control.AutomationId or "", control.Name or "")
        if not selectors:
            log.info("skipped a %s nothing identifies", ctype)
            return None
        return Element(
            id=f"el_{uuid.uuid4().hex[:12]}",
            name=friendly_name(control)[:60],
            kind="desktop",
            selectors=selectors,
            screenshot=_thumbnail(control),
            context={"window": window.Name or "", "process": process_name(window.ProcessId)},
        )

    def _ignored(self, window: Any) -> bool:
        try:
            if window.ProcessId in self._ignore or (window.ClassName or "") in SHELL_CLASSES:
                return True
            return process_name(window.ProcessId).lower() in SHELL_PROCESSES
        except Exception:
            return True


def _is_text_box(control: Any, ctype: str) -> bool:
    if ctype not in ("Edit", "Document", "DataItem"):
        return False
    pattern = _safe(lambda: specific(control).GetValuePattern())
    return pattern is not None and not _safe(lambda: pattern.IsReadOnly)


def _read(control: Any, kind: str) -> str | None:
    if kind == "select":
        with contextlib.suppress(Exception):
            selection = control.GetSelectionPattern().GetSelection()
            if selection:
                return selection[0].Name
    return _safe(lambda: control.GetValuePattern().Value)


def _toggle_state(control: Any) -> bool:
    return bool(_safe(lambda: specific(control).GetTogglePattern().ToggleState == 1))


def _safe(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception:
        return None


def _double_click_s() -> float:
    return ctypes.windll.user32.GetDoubleClickTime() / 1000


# -- low-level input hooks ------------------------------------------------------------------------

WH_KEYBOARD_LL, WH_MOUSE_LL = 13, 14
WM_KEYDOWN, WM_SYSKEYDOWN, WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_QUIT = 0x0100, 0x0104, 0x0201, 0x0204, 0x0012
VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN = 0x10, 0x11, 0x12, 0x5B, 0x5C


class _MouseInfo(ctypes.Structure):
    _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _KeyInfo(ctypes.Structure):
    _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


_HOOKPROC = ctypes.WINFUNCTYPE(wintypes.LPARAM, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)


class _Hooks:
    """Mouse and keyboard hooks on their own thread with a message loop (Windows requires both)."""

    def __init__(self, events: queue.Queue):
        self._events = events
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._error: str | None = None
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
        user32.SetWindowsHookExW.restype = ctypes.c_void_p
        user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user32.CallNextHookEx.restype = wintypes.LPARAM
        user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
        user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
        user32.GetAsyncKeyState.restype = ctypes.c_short
        self._user32 = user32
        # Kept on self: ctypes callbacks must stay alive as long as the hooks are installed.
        self._mouse_proc = _HOOKPROC(self._on_mouse)
        self._key_proc = _HOOKPROC(self._on_key)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="input-hooks", daemon=True)
        self._thread.start()
        self._ready.wait(5)
        if self._error:
            raise RuntimeError(self._error)

    def stop(self) -> None:
        if self._thread_id:
            self._user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread is not None:
            self._thread.join(3)

    def _loop(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        self._thread_id = kernel32.GetCurrentThreadId()
        module = kernel32.GetModuleHandleW(None)
        mouse = self._user32.SetWindowsHookExW(WH_MOUSE_LL, self._mouse_proc, module, 0)
        keyboard = self._user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._key_proc, module, 0)
        if not mouse or not keyboard:
            self._error = f"Windows did not allow recording input (error {ctypes.get_last_error()})."
            self._ready.set()
            return
        self._ready.set()
        msg = wintypes.MSG()
        try:
            while self._user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                self._user32.TranslateMessage(ctypes.byref(msg))
                self._user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            self._user32.UnhookWindowsHookEx(mouse)
            self._user32.UnhookWindowsHookEx(keyboard)

    def _on_mouse(self, code: int, wparam: int, lparam: int) -> int:
        if code == 0 and wparam in (WM_LBUTTONDOWN, WM_RBUTTONDOWN):
            info = ctypes.cast(lparam, ctypes.POINTER(_MouseInfo)).contents
            button = "left" if wparam == WM_LBUTTONDOWN else "right"
            self._events.put(("mouse", button, info.pt.x, info.pt.y, time.monotonic()))
        return self._user32.CallNextHookEx(None, code, wparam, lparam)

    def _on_key(self, code: int, wparam: int, lparam: int) -> int:
        if code == 0 and wparam in (WM_KEYDOWN, WM_SYSKEYDOWN):
            info = ctypes.cast(lparam, ctypes.POINTER(_KeyInfo)).contents
            down = lambda vk: bool(self._user32.GetAsyncKeyState(vk) & 0x8000)  # noqa: E731
            mods = (down(VK_CONTROL), down(VK_MENU), down(VK_SHIFT), down(VK_LWIN) or down(VK_RWIN))
            self._events.put(("key", int(info.vkCode), mods, time.monotonic()))
        return self._user32.CallNextHookEx(None, code, wparam, lparam)


class _Bar:
    """Small always-on-top "Recording - Stop" bar at the top of the screen."""

    def __init__(self, on_stop: Callable[[], None]):
        self._root: Any = None
        self._label: Any = None
        self._count = -1
        try:
            import tkinter as tk

            root = tk.Tk()
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.configure(bg="#1f2430")
            frame = tk.Frame(root, bg="#1f2430", padx=12, pady=6)
            frame.pack()
            tk.Label(frame, text="●", fg="#ef4444", bg="#1f2430", font=("Segoe UI", 12)).pack(side="left")
            self._label = tk.Label(frame, text="Recording", fg="#ffffff", bg="#1f2430", font=("Segoe UI", 10))
            self._label.pack(side="left", padx=(6, 14))
            tk.Button(frame, text="Stop recording", command=on_stop, bg="#ef4444", fg="#ffffff", relief="flat",
                      activebackground="#dc2626", activeforeground="#ffffff", font=("Segoe UI", 9, "bold"),
                      padx=10, cursor="hand2").pack(side="left")
            root.update_idletasks()
            width = root.winfo_reqwidth()
            root.geometry(f"+{(root.winfo_screenwidth() - width) // 2}+8")
            self._root = root
        except Exception as exc:  # no Tk: recording still works; stop it from Studio
            log.debug("recording bar unavailable: %s", exc)

    def update(self, count: int) -> None:
        if self._root is None:
            return
        if count != self._count:
            self._count = count
            self._label.configure(text=f"Recording — {count} step{'' if count == 1 else 's'}")
        with contextlib.suppress(Exception):
            self._root.update()

    def close(self) -> None:
        if self._root is not None:
            with contextlib.suppress(Exception):
                self._root.destroy()
            self._root = None
