"""Pick a control in any Windows application: point at it and press Ctrl.

``pick_point`` does the same for a position (X, Y): on the screen, in the window under
the mouse and, when an element is given, inside that element.

Runs on its own thread (UI Automation is COM-based and polling must not block the
JSON-RPC loop). While picking, a red outline follows the control under the mouse
and Studio is told its name, so the user sees what will be picked.
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import io
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from ..flow import Element
from ..selectors.desktop import find, friendly_name, process_name, selectors_for, specific, top_window, uia

log = logging.getLogger("autoflow.design.desktop")

VK_CONTROL, VK_ESCAPE = 0x11, 0x1B
MAX_THUMB = (480, 160)
TIMEOUT_S = 15 * 60

Respond = Callable[..., None]
Notify = Callable[[str, dict[str, Any]], None]


def _pressed(vk: int) -> bool:
    return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)


class DesktopPicker:
    def __init__(self, notify: Notify, ignore_pids: set[int] | None = None):
        self._notify = notify
        # Studio's own windows belong to the process that started the engine.
        self._ignore = ignore_pids if ignore_pids is not None else {os.getppid(), os.getpid()}
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def pick(self, respond: Respond) -> None:
        self.cancel()
        if self._thread:
            self._thread.join(2)
        self._cancel.clear()
        self._thread = threading.Thread(target=self._run, args=(respond,), name="desktop-picker", daemon=True)
        self._thread.start()

    def pick_point(self, respond: Respond, element: dict[str, Any] | None = None) -> None:
        self.cancel()
        if self._thread:
            self._thread.join(2)
        self._cancel.clear()
        self._thread = threading.Thread(
            target=self._run_point, args=(respond, element), name="point-picker", daemon=True
        )
        self._thread.start()

    def cancel(self) -> None:
        self._cancel.set()

    def _run_point(self, respond: Respond, element: dict[str, Any] | None) -> None:
        auto = uia()
        tip = _Tip()
        try:
            with auto.UIAutomationInitializerInThread():
                respond(result=self._point_loop(auto, tip, element))
        except Exception as exc:
            log.exception("position pick failed")
            respond(error=exc)
        finally:
            tip.close()

    def _point_loop(self, auto: Any, tip: _Tip, element: dict[str, Any] | None) -> dict[str, Any] | None:
        box = None
        if element:
            with contextlib.suppress(Exception):  # not on screen: positions are still offered
                r = find(Element.model_validate(element), 3).BoundingRectangle
                box = (r.left, r.top)
        deadline = time.monotonic() + TIMEOUT_S
        was_down = _pressed(VK_CONTROL)
        while not self._cancel.is_set() and time.monotonic() < deadline:
            x, y = auto.GetCursorPos()
            control = auto.ControlFromPoint(x, y)
            window = top_window(control) if control is not None else None
            if window is not None and window.ProcessId in self._ignore:
                window = None
            in_window = None
            parts = [f"Screen {x}, {y}"]
            if window is not None:
                r = window.BoundingRectangle
                in_window = {
                    "x": x - r.left, "y": y - r.top,
                    "title": window.Name or "", "process": process_name(window.ProcessId),
                }
                parts.append(f"Window {in_window['x']}, {in_window['y']}")
            in_element = {"x": x - box[0], "y": y - box[1]} if box else None
            if in_element:
                parts.append(f"Element {in_element['x']}, {in_element['y']}")
            tip.show(x, y, "   ".join(parts) + "\nCtrl: pick this point    Esc: cancel")
            tip.pump()
            down = _pressed(VK_CONTROL)
            if down and not was_down:
                return {"screen": {"x": x, "y": y}, "window": in_window, "element": in_element}
            was_down = down
            if _pressed(VK_ESCAPE):
                return None
            time.sleep(0.03)
        return None

    def _run(self, respond: Respond) -> None:
        auto = uia()
        outline = _Outline()
        try:
            with auto.UIAutomationInitializerInThread():
                respond(result=self._loop(auto, outline))
        except Exception as exc:
            log.exception("desktop pick failed")
            respond(error=exc)
        finally:
            outline.close()

    def _loop(self, auto: Any, outline: _Outline) -> dict[str, Any] | None:
        deadline = time.monotonic() + TIMEOUT_S
        was_down = _pressed(VK_CONTROL)  # ignore a Ctrl already held when picking starts
        hovered_id = None
        current = None
        while not self._cancel.is_set() and time.monotonic() < deadline:
            x, y = auto.GetCursorPos()
            control = auto.ControlFromPoint(x, y)
            if control is not None:
                window = top_window(control)
                if window.ProcessId in self._ignore:
                    control = None
            if control is not None:
                runtime_id = tuple(control.GetRuntimeId() or ())
                if runtime_id != hovered_id:
                    hovered_id = runtime_id
                    current = control
                    rect = control.BoundingRectangle
                    outline.show(rect.left, rect.top, rect.right, rect.bottom)
                    self._notify("picker.hover", {"name": friendly_name(specific(control)), "window": window.Name})
            else:
                outline.hide()
            outline.pump()
            down = _pressed(VK_CONTROL)
            if down and not was_down and current is not None:
                outline.hide()
                return element_from_control(current).model_dump()
            was_down = down
            if _pressed(VK_ESCAPE):
                return None
            time.sleep(0.06)
        return None


def element_from_control(control: Any) -> Element:
    control = specific(control)
    window = top_window(control)
    return Element(
        id=f"el_{uuid.uuid4().hex[:12]}",
        name=friendly_name(control)[:60],
        kind="desktop",
        selectors=selectors_for(control, window),
        screenshot=_thumbnail(control),
        context={"window": window.Name or "", "process": process_name(window.ProcessId)},
    )


def _thumbnail(control: Any) -> str | None:
    try:
        from PIL import ImageGrab

        r = control.BoundingRectangle
        pad = 6
        box = (r.left - pad, r.top - pad, min(r.right + pad, r.left - pad + MAX_THUMB[0]), min(r.bottom + pad, r.top - pad + MAX_THUMB[1]))
        if box[2] <= box[0] or box[3] <= box[1]:
            return None
        image = ImageGrab.grab(bbox=box, all_screens=True)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception as exc:
        log.debug("thumbnail failed: %s", exc)
        return None


class _Outline:
    """Four thin red always-on-top windows around the hovered control (clicks pass between them)."""

    def __init__(self) -> None:
        self._root: Any = None
        self._edges: list[Any] = []
        try:
            import tkinter as tk

            self._root = tk.Tk()
            self._root.withdraw()
            for _ in range(4):
                edge = tk.Toplevel(self._root)
                edge.overrideredirect(True)
                edge.attributes("-topmost", True)
                edge.configure(bg="#e11d48")
                edge.withdraw()
                self._edges.append(edge)
        except Exception as exc:  # no Tk available: picking still works, just without the outline
            log.debug("outline unavailable: %s", exc)
            self._root = None

    def show(self, left: int, top: int, right: int, bottom: int) -> None:
        if self._root is None:
            return
        t = 3
        geometry = [
            (right - left + 2 * t, t, left - t, top - t),
            (right - left + 2 * t, t, left - t, bottom),
            (t, bottom - top, left - t, top),
            (t, bottom - top, right, top),
        ]
        for edge, (w, h, x, y) in zip(self._edges, geometry, strict=True):
            edge.geometry(f"{max(w, 1)}x{max(h, 1)}+{x}+{y}")
            edge.deiconify()

    def hide(self) -> None:
        for edge in self._edges:
            edge.withdraw()

    def pump(self) -> None:
        if self._root is not None:
            self._root.update()

    def close(self) -> None:
        if self._root is not None:
            with contextlib.suppress(Exception):
                self._root.destroy()
            self._root = None


class _Tip:
    """A small dark label next to the mouse showing the position (offset so it never covers the point)."""

    def __init__(self) -> None:
        self._root: Any = None
        self._label: Any = None
        try:
            import tkinter as tk

            self._root = tk.Tk()
            self._root.overrideredirect(True)
            self._root.attributes("-topmost", True)
            self._root.configure(bg="#1f2430")
            self._label = tk.Label(self._root, text="", fg="#ffffff", bg="#1f2430", font=("Segoe UI", 9),
                                   justify="left", padx=8, pady=4)
            self._label.pack()
        except Exception as exc:  # no Tk: picking still works, without the label
            log.debug("position label unavailable: %s", exc)
            self._root = None

    def show(self, x: int, y: int, text: str) -> None:
        if self._root is None:
            return
        self._label.configure(text=text)
        self._root.geometry(f"+{x + 20}+{y + 22}")

    def pump(self) -> None:
        if self._root is not None:
            with contextlib.suppress(Exception):
                self._root.update()

    def close(self) -> None:
        if self._root is not None:
            with contextlib.suppress(Exception):
                self._root.destroy()
            self._root = None
