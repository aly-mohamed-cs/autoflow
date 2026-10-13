"""Element inspector (Brity "Inspector"): browse the controls of a program window as a tree and
use one as an element, for controls that are hard to point at (hidden, tiny, in lists)."""

from __future__ import annotations

import contextlib
import os
import threading
from typing import Any

from ..errors import ActivityError
from ..selectors.desktop import friendly_name, process_name, specific, uia

MAX_CHILDREN = 300


def windows() -> list[dict[str, Any]]:
    """Open program windows (not Studio's own)."""
    auto = uia()
    mine = {os.getpid(), os.getppid()}
    with auto.UIAutomationInitializerInThread():
        out = []
        for window in auto.GetRootControl().GetChildren():
            if window.ProcessId in mine or not window.Name or window.IsOffscreen:
                continue
            out.append({"handle": window.NativeWindowHandle, "title": window.Name,
                        "process": process_name(window.ProcessId)})
        return out


def _resolve(handle: int, path: list[int]) -> Any:
    auto = uia()
    control = auto.ControlFromHandle(int(handle))
    if control is None:
        raise ActivityError("That window is closed.", "Choose the window again.")
    for index in path:
        children = control.GetChildren()
        if not 0 <= int(index) < len(children):
            raise ActivityError("The window changed; that control is gone.", "Open the window's tree again.")
        control = children[int(index)]
    return control


def _describe(control: Any, index: int) -> dict[str, Any]:
    return {
        "index": index,
        "name": control.Name or "",
        "type": control.ControlTypeName.removesuffix("Control"),
        "automation_id": control.AutomationId or "",
        "label": friendly_name(specific(control))[:80],
        "has_children": control.GetFirstChildControl() is not None,
    }


def children(handle: int, path: list[int]) -> list[dict[str, Any]]:
    """The controls directly inside the window (path []) or inside one of its controls."""
    auto = uia()
    with auto.UIAutomationInitializerInThread():
        kids = _resolve(handle, path).GetChildren()[:MAX_CHILDREN]
        return [_describe(child, i) for i, child in enumerate(kids)]


def element(handle: int, path: list[int]) -> dict[str, Any]:
    """The control as an element the flow can use (with its ways to find it and a thumbnail)."""
    from .desktop_picker import element_from_control

    auto = uia()
    with auto.UIAutomationInitializerInThread():
        control = _resolve(handle, path)
        return element_from_control(control).model_dump()


def highlight(handle: int, path: list[int]) -> dict[str, Any]:
    """Show where the control is: a red outline for a moment."""
    from .desktop_picker import _Outline

    auto = uia()
    with auto.UIAutomationInitializerInThread():
        rect = _resolve(handle, path).BoundingRectangle
    box = (rect.left, rect.top, rect.right, rect.bottom)

    def flash() -> None:
        outline = _Outline()
        try:
            outline.show(*box)
            for _ in range(40):  # about 1.5 seconds
                outline.pump()
                threading.Event().wait(0.04)
        finally:
            with contextlib.suppress(Exception):
                outline.close()

    threading.Thread(target=flash, name="highlight", daemon=True).start()
    return {"x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]}
