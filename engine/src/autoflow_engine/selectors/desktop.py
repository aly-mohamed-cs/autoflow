"""Find controls in Windows desktop applications through UI Automation.

Elements captured by the desktop picker keep the window they live in (title and
program) and several ways to find the control inside it: its automation id, its
name and type, or its position among similar controls. They are tried in order.
"""

from __future__ import annotations

import ctypes
import time
from typing import Any

from ..errors import ActivityError
from ..flow import Element, Selector

POLL = 0.25


def uia() -> Any:
    try:
        import uiautomation as auto
    except ImportError:  # pragma: no cover - non-Windows
        raise ActivityError("Desktop automation only works on Windows.") from None
    return auto


def control_type_id(name: str) -> int:
    auto = uia()
    value = getattr(auto.ControlType, f"{name}Control", None)
    if value is None:
        raise ActivityError(f"Unknown control type '{name}'.")
    return value


def process_name(pid: int) -> str:
    """Executable name of a process (e.g. 'DemoErp.exe'), without extra packages."""
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ""
    try:
        size = ctypes.c_uint32(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value.rsplit("\\", 1)[-1]
        return ""
    finally:
        kernel32.CloseHandle(handle)


def top_window(control: Any) -> Any:
    auto = uia()
    root = auto.GetRootControl()
    current = control
    while True:
        parent = current.GetParentControl()
        if parent is None or auto.ControlsAreSame(parent, root):
            return current
        current = parent


def find_window(context: dict[str, Any], timeout: float) -> Any:
    """The application window an element belongs to (title contains, and program if known)."""
    auto = uia()
    title = str(context.get("window") or "").strip().casefold()
    program = str(context.get("process") or "").strip().casefold()
    deadline = time.monotonic() + timeout
    while True:
        for window in auto.GetRootControl().GetChildren():
            name = (window.Name or "").casefold()
            if title and title not in name:
                continue
            if program and process_name(window.ProcessId).casefold() != program:
                continue
            if title or program:
                return window
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL)
    what = context.get("window") or context.get("process") or "the application"
    raise ActivityError(
        f"The window '{what}' is not open.",
        "Start the application first (e.g. with 'Open application'), and check it isn't minimized behind a login.",
    )


def _conditions(selector: Selector) -> dict[str, Any]:
    o = selector.options
    conditions: dict[str, Any] = {}
    if o.get("automation_id"):
        conditions["AutomationId"] = o["automation_id"]
    if o.get("name"):
        conditions["Name"] = o["name"]
    if o.get("class_name"):
        conditions["ClassName"] = o["class_name"]
    if o.get("control_type"):
        conditions["ControlType"] = control_type_id(o["control_type"])
    if not conditions:
        raise ActivityError("This desktop selector has nothing to search for.")
    return conditions


def locate_in(window: Any, selector: Selector) -> Any | None:
    """The control matching the selector, or None (also None when ambiguous without an index)."""
    auto = uia()
    conditions = _conditions(selector)
    index = int(selector.options.get("index") or 0)
    if index:
        ctrl = auto.Control(searchFromControl=window, foundIndex=index, **conditions)
        return specific(ctrl) if ctrl.Exists(0, 0) else None
    first = auto.Control(searchFromControl=window, foundIndex=1, **conditions)
    if not first.Exists(0, 0):
        return None
    second = auto.Control(searchFromControl=window, foundIndex=2, **conditions)
    return None if second.Exists(0, 0) else specific(first)


def specific(control: Any) -> Any:
    """A generic search result as its real class (EditControl, ComboBoxControl...), which has
    the value / toggle / expand helpers that the base Control lacks."""
    auto = uia()
    return auto.Control.CreateControlFromControl(control) or control


def find(element: Element, timeout: float, log: Any = None) -> Any:
    """Wait up to `timeout` seconds for the control described by `element`."""
    if element.kind != "desktop":
        raise ActivityError(f"'{element.name}' is a web element, not a desktop one.")
    deadline = time.monotonic() + timeout
    window = find_window(element.context, timeout)
    while True:
        for i, selector in enumerate(element.selectors):
            if selector.strategy != "uia":
                continue
            ctrl = locate_in(window, selector)
            if ctrl is not None:
                if i > 0 and log is not None:
                    log(f"'{element.name}' was found using a backup method. The application may have changed; "
                        "consider picking it again.", "warning")
                return ctrl
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL)
    raise ActivityError(
        f"Couldn't find '{element.name}' in '{window.Name}' after {timeout:g} seconds.",
        "Check that the right screen of the application is showing, or pick the element again.",
    )


def friendly_type(control: Any) -> str:
    return (control.ControlTypeName or "Control").removesuffix("Control")


def selectors_for(control: Any, window: Any) -> list[Selector]:
    """Several verified ways to find this control again inside its window."""
    ctype = friendly_type(control)
    aid = control.AutomationId or ""
    name = (control.Name or "").strip()
    candidates: list[Selector] = []
    if aid and not aid.isdigit():
        candidates.append(Selector(strategy="uia", value=f"{ctype} #{aid}", options={"automation_id": aid, "control_type": ctype}))
    if name:
        candidates.append(Selector(strategy="uia", value=f'{ctype} "{name}"', options={"name": name, "control_type": ctype}))
    if aid:
        candidates.append(Selector(strategy="uia", value=f"#{aid}", options={"automation_id": aid}))
    # Position among controls of the same type and class (last resort).
    index = _index_among(control, window, ctype)
    if index:
        candidates.append(Selector(strategy="uia", value=f"{ctype} number {index}",
                                   options={"control_type": ctype, "class_name": control.ClassName or "", "index": index}))
    target = control.GetRuntimeId()
    verified = []
    for selector in candidates:
        try:
            found = locate_in(window, selector)
        except ActivityError:
            continue
        if found is not None and found.GetRuntimeId() == target:
            verified.append(selector)
    if not verified:
        raise ActivityError("Autoflow could not find a reliable way to locate that control.",
                            "Try clicking a different part of it, or use the image-based step instead.")
    return verified


def _index_among(control: Any, window: Any, ctype: str) -> int:
    auto = uia()
    target = control.GetRuntimeId()
    conditions: dict[str, Any] = {"ControlType": control_type_id(ctype)}
    if control.ClassName:
        conditions["ClassName"] = control.ClassName
    for i in range(1, 200):
        ctrl = auto.Control(searchFromControl=window, foundIndex=i, **conditions)
        if not ctrl.Exists(0, 0):
            return 0
        if ctrl.GetRuntimeId() == target:
            return i
    return 0


def friendly_name(control: Any) -> str:
    ctype = friendly_type(control)
    noun = {"Edit": "box", "Button": "button", "ComboBox": "list", "CheckBox": "checkbox", "RadioButton": "option",
            "Text": "text", "DataGrid": "table", "Table": "table", "List": "list", "MenuItem": "menu item",
            "TabItem": "tab", "Hyperlink": "link"}.get(ctype, ctype.lower())
    base = (control.Name or control.AutomationId or ctype).strip()
    if len(base) > 40:
        base = base[:39] + "…"
    return base if base.lower().endswith(noun) else f"{base} {noun}"


def snapshot(context: dict[str, Any] | None, limit: int = 150) -> dict[str, Any]:
    """The controls of an application window, for the AI assistant (names and ids, never typed values)."""
    auto = uia()
    if context and (context.get("window") or context.get("process")):
        window = find_window(context, 2)
    else:
        window = top_window(auto.GetForegroundControl())
    controls: list[dict[str, Any]] = []
    for control, _depth in auto.WalkControl(window, includeTop=False, maxDepth=12):
        if len(controls) >= limit:
            break
        item = {
            "type": friendly_type(control),
            "name": (control.Name or "").strip()[:80],
            "automation_id": control.AutomationId or "",
            "class_name": control.ClassName or "",
        }
        if item["type"] == "Edit" and item["name"] and item["name"] == (_value(control) or "").strip()[:80]:
            item["name"] = ""  # some programs expose the typed text as the box's name
        if item["name"] or item["automation_id"]:
            controls.append({k: v for k, v in item.items() if v})
    return {
        "kind": "desktop",
        "window": window.Name or "",
        "process": process_name(window.ProcessId),
        "controls": controls,
    }


def _value(control: Any) -> str | None:
    try:
        return specific(control).GetValuePattern().Value
    except Exception:
        return None
