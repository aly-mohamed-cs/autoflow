"""Windows desktop applications (ERP clients, legacy software) through UI Automation.

Desktop steps need a signed-in, unlocked desktop. On robots that means the robot
account signs in automatically (see ROBOT-SETUP.md).
"""

from __future__ import annotations

import contextlib
import subprocess
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..flow import Element
from ..runtime.context import Deadline, RunContext, wait
from ..selectors.desktop import find, find_window, specific, uia
from ..values import Table, parse_point, to_text

K = "Desktop"


def _init(ctx: RunContext) -> Any:
    """UI Automation is COM-based: initialise it once for the thread running the flow."""
    auto = uia()
    if "uia" not in ctx.resources:
        initializer = auto.UIAutomationInitializerInThread(debug=False)
        ctx.resources["uia"] = initializer
        ctx.add_cleanup("uia", lambda: initializer.__exit__(None, None, None))
        ctx.resources.setdefault("screenshot", _screen_capture)
    return auto


def _screen_capture(path: Path) -> bool:
    from PIL import ImageGrab

    ImageGrab.grab(all_screens=True).save(path)
    return True


class ElementParams(Params):
    element: str = Param("", title="Element", ui="element")
    timeout: float | None = Param(None, title="Wait up to (seconds)", ge=0, le=3600, advanced=True)


def _locate(ctx: RunContext, p: ElementParams) -> Any:
    _init(ctx)
    element: Element | None = ctx.elements.get(p.element) if p.element else None
    if element is None:
        raise ActivityError("No element was chosen." if not p.element else "The chosen element no longer exists.",
                            "Click 'Pick on screen' and point at the control in the application.")
    timeout = p.timeout if p.timeout is not None else ctx.flow.settings.default_timeout
    control = find(element, timeout, log=ctx.log)
    window = control.GetTopLevelControl() if hasattr(control, "GetTopLevelControl") else None
    if window is not None:
        with contextlib.suppress(Exception):
            window.SetActive(waitTime=0.1)
    return control


# -- applications and windows ------------------------------------------------------------------


class LaunchParams(Params):
    program: str = Param(title="Program", ui="file", file_types=["exe", "lnk", "bat", "cmd"])
    arguments: str = Param("", title="Arguments", advanced=True)
    window: str = Param("", title="Wait for a window titled", placeholder="(part of the title, e.g. Invoices)")
    timeout: float = Param(60, title="Wait up to (seconds)", ge=1, le=600, advanced=True)
    close_at_end: bool = Param(True, title="Close it when the automation finishes")


@activity(
    "desktop.launch",
    title="Open application",
    category=K,
    icon="app-window",
    sentence="Open {program}",
    description="Start a Windows program and wait until its window appears.",
    params=LaunchParams,
)
def launch(ctx: RunContext, p: LaunchParams) -> None:
    _init(ctx)
    program = Path(to_text(p.program).strip().strip('"'))
    if not program.exists():
        raise ActivityError(f"The program '{program}' does not exist.", "Check the path on this computer.")
    try:
        process = subprocess.Popen([str(program), *([p.arguments] if p.arguments else [])], cwd=program.parent)
    except OSError as exc:
        raise ActivityError(f"Could not start '{program.name}': {exc}") from None
    if p.close_at_end:
        ctx.add_cleanup(f"app:{program.name}", lambda: _terminate(process))
    if p.window:
        # The program just started: its windows are the ones to look at.
        window = find_window({"window": p.window, "process": program.name}, p.timeout, ctx.log)
        window.SetActive(waitTime=0.1)
    else:
        wait(1)
    ctx.resources["desktop_window"] = p.window


def _terminate(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()


class WindowParams(Params):
    window: str = Param(title="Window title contains", placeholder="Invoices")
    process: str = Param(
        "", title="Program", placeholder="EXCEL.EXE", advanced=True,
        description="The program the window belongs to. Helps find it when its title changes (document names...).",
    )
    timeout: float = Param(30, title="Wait up to (seconds)", ge=0, le=600, advanced=True)


@activity(
    "desktop.activate_window",
    title="Switch to window",
    category=K,
    icon="app-window-mac",
    sentence="Switch to window {window}",
    description="Bring an application window to the front (and wait for it to appear).",
    params=WindowParams,
)
def activate_window(ctx: RunContext, p: WindowParams) -> None:
    _init(ctx)
    window = find_window({"window": p.window, "process": p.process}, p.timeout, ctx.log)
    window.SetActive(waitTime=0.2)


@activity(
    "desktop.close_window",
    title="Close window",
    category=K,
    icon="x",
    sentence="Close window {window}",
    params=WindowParams,
)
def close_window(ctx: RunContext, p: WindowParams) -> None:
    _init(ctx)
    try:
        # Exact title only: closing a look-alike window could close someone's other document.
        window = find_window({"window": p.window, "process": p.process}, p.timeout, close_match=False)
    except ActivityError:
        return
    pattern = window.GetWindowPattern()
    if pattern:
        pattern.Close()
    else:
        window.SendKeys("{Alt}{F4}")


# -- interacting -----------------------------------------------------------------------------------


def _point_param(title: str = "Point inside the element") -> Any:
    return Param(
        "", title=title, ui="point", placeholder="Centre",
        description="X, Y in pixels from the element's top-left corner. Leave empty for its centre.",
    )


class ClickParams(ElementParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")
    point: str = _point_param()


@activity(
    "desktop.click",
    title="Click in application",
    category=K,
    icon="mouse-pointer-click",
    sentence="Click {element}",
    params=ClickParams,
)
def click(ctx: RunContext, p: ClickParams) -> None:
    control = _locate(ctx, p)
    x, y = parse_point(p.point) if p.point else (None, None)
    if x is None and p.click == "single" and _invoke(control):
        return
    if p.click == "double":
        control.DoubleClick(x, y, simulateMove=False)
    elif p.click == "right":
        control.RightClick(x, y, simulateMove=False)
    else:
        control.Click(x, y, simulateMove=False)


# -- the mouse at a position (Brity "MouseEvent") ------------------------------------------------


class PositionParams(Params):
    relative_to: Literal["window", "screen"] = Param(
        "window", title="Position in", labels={"window": "A window", "screen": "The whole screen"},
    )
    window: str = Param(
        "", title="Window title contains", placeholder="(the window in front)",
        show_when={"relative_to": ["window"]},
    )
    process: str = Param(
        "", title="Program", placeholder="EXCEL.EXE", advanced=True, show_when={"relative_to": ["window"]},
        description="The program the window belongs to. Helps find it when its title changes.",
    )
    position: str = Param(
        title="Position (X, Y)", ui="point", placeholder="120, 45",
        description="Pixels from the top-left corner of the window (or of the screen).",
    )
    timeout: float = Param(
        30, title="Wait for the window up to (seconds)", ge=0, le=600, advanced=True,
        show_when={"relative_to": ["window"]},
    )


def _origin(ctx: RunContext, p: PositionParams) -> tuple[int, int]:
    """Top-left corner positions are measured from: the window's (brought to the front) or the screen's."""
    if p.relative_to == "screen":
        return 0, 0
    auto = _init(ctx)
    if p.window or p.process:
        window = find_window({"window": p.window, "process": p.process}, p.timeout, ctx.log)
    else:
        window = auto.GetForegroundControl()
        if window is None:
            raise ActivityError("No window is in front.", "Enter the title of the window to use.")
        window = window.GetTopLevelControl() or window
    with contextlib.suppress(Exception):
        window.SetActive(waitTime=0.1)
    rect = window.BoundingRectangle
    return rect.left, rect.top


def _screen_point(ctx: RunContext, p: PositionParams, position: str) -> tuple[int, int]:
    x, y = parse_point(position)
    left, top = _origin(ctx, p)
    return left + x, top + y


def _mouse_click(x: int, y: int, kind: str) -> None:
    auto = uia()
    if kind == "right":
        auto.RightClick(x, y, waitTime=0.1)
    elif kind == "double":
        auto.Click(x, y, waitTime=0)
        auto.Click(x, y, waitTime=0.1)
    else:
        auto.Click(x, y, waitTime=0.1)


class ClickAtParams(PositionParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")


@activity(
    "desktop.click_at",
    title="Click at position",
    category=K,
    icon="crosshair",
    sentence="Click at {position}",
    description="Click a point given as X, Y - in a window or on the screen. For controls the "
    "recorder can't see (drawings, maps, remote desktops).",
    params=ClickAtParams,
)
def click_at(ctx: RunContext, p: ClickAtParams) -> None:
    x, y = _screen_point(ctx, p, p.position)
    _mouse_click(x, y, p.click)


@activity(
    "desktop.move_mouse",
    title="Move mouse to position",
    category=K,
    icon="move",
    sentence="Move the mouse to {position}",
    description="Move the mouse pointer to a point given as X, Y, e.g. to show a tooltip.",
    params=PositionParams,
)
def move_mouse(ctx: RunContext, p: PositionParams) -> None:
    x, y = _screen_point(ctx, p, p.position)
    uia().MoveTo(x, y, moveSpeed=2, waitTime=0.1)


class HoverParams(ElementParams):
    point: str = _point_param()


@activity(
    "desktop.hover",
    title="Point at element",
    category=K,
    icon="pointer",
    sentence="Point at {element}",
    description="Move the mouse over a control, e.g. to open a menu or show a tooltip.",
    params=HoverParams,
)
def hover(ctx: RunContext, p: HoverParams) -> None:
    x, y = _point_in(_locate(ctx, p), p.point)
    uia().MoveTo(x, y, moveSpeed=2, waitTime=0.1)


def _point_in(control: Any, point: str) -> tuple[int, int]:
    rect = control.BoundingRectangle
    if point:
        dx, dy = parse_point(point)
        return rect.left + dx, rect.top + dy
    return (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2


class ScrollParams(ElementParams):
    direction: Literal["down", "up"] = Param("down", title="Direction")
    times: int = Param(3, title="How far (wheel turns)", ge=1, le=100)


@activity(
    "desktop.scroll",
    title="Scroll",
    category=K,
    icon="mouse",
    sentence="Scroll {direction} {times} times",
    description="Turn the mouse wheel over a control (or wherever the mouse is when no element is chosen).",
    params=ScrollParams,
)
def scroll(ctx: RunContext, p: ScrollParams) -> None:
    auto = uia()
    if p.element:
        x, y = _point_in(_locate(ctx, p), "")
        auto.MoveTo(x, y, moveSpeed=2, waitTime=0.05)
    if p.direction == "up":
        auto.WheelUp(p.times, waitTime=0.1)
    else:
        auto.WheelDown(p.times, waitTime=0.1)


class DragDropParams(ElementParams):
    element: str = Param("", title="Drag", ui="element")
    target: str = Param("", title="Drop on", ui="element")


@activity(
    "desktop.drag_drop",
    title="Drag and drop",
    category=K,
    icon="hand-grab",
    sentence="Drag {element} onto {target}",
    description="Hold the mouse button on one control, move to another and let go.",
    params=DragDropParams,
)
def drag_drop(ctx: RunContext, p: DragDropParams) -> None:
    x1, y1 = _point_in(_locate(ctx, p), "")
    target = ElementParams(element=p.target, timeout=p.timeout)
    x2, y2 = _point_in(_locate(ctx, target), "")
    uia().DragDrop(x1, y1, x2, y2, moveSpeed=1.5, waitTime=0.2)


class DragAtParams(PositionParams):
    to_position: str = Param(title="Drop at (X, Y)", ui="point", placeholder="300, 45")


@activity(
    "desktop.drag_at",
    title="Drag between positions",
    category=K,
    icon="hand-grab",
    sentence="Drag from {position} to {to_position}",
    description="Hold the mouse button at one point, move to another and let go (e.g. sliders, drawings).",
    params=DragAtParams,
)
def drag_at(ctx: RunContext, p: DragAtParams) -> None:
    (x1, y1), (x2, y2) = parse_point(p.position), parse_point(p.to_position)
    left, top = _origin(ctx, p)
    uia().DragDrop(left + x1, top + y1, left + x2, top + y2, moveSpeed=1.5, waitTime=0.2)


def _invoke(control: Any) -> bool:
    """Press buttons through UI Automation when possible (works even if covered)."""
    try:
        pattern = control.GetInvokePattern()
        if pattern:
            pattern.Invoke()
            return True
    except Exception:
        pass
    return False


class TypeParams(ElementParams):
    text: str = Param(title="Text to type")
    clear_first: bool = Param(True, title="Clear the field first")
    press_enter: bool = Param(False, title="Press Enter afterwards")


@activity(
    "desktop.type",
    title="Type into application",
    category=K,
    icon="keyboard",
    sentence="Type {text} into {element}",
    params=TypeParams,
)
def type_text(ctx: RunContext, p: TypeParams) -> None:
    control = _locate(ctx, p)
    text = to_text(p.text)
    pattern = None
    try:
        pattern = control.GetValuePattern()
    except Exception:
        pattern = None
    if pattern and p.clear_first and not p.press_enter:
        pattern.SetValue(text)
        return
    control.SetFocus()
    if p.clear_first:
        control.SendKeys("{Ctrl}a{Delete}", waitTime=0.05)
    control.SendKeys(_escape_keys(text), waitTime=0.05)
    if p.press_enter:
        control.SendKeys("{Enter}", waitTime=0.05)


def _escape_keys(text: str) -> str:
    """uiautomation's SendKeys treats { } as key names; type them literally."""
    return text.replace("{", "{{}").replace("}", "{}}").replace("{{}}", "{{}")


class SelectParams(ElementParams):
    option: str = Param(title="Option")


@activity(
    "desktop.select",
    title="Choose from list in application",
    category=K,
    icon="list-checks",
    sentence="Choose {option} in {element}",
    params=SelectParams,
)
def select(ctx: RunContext, p: SelectParams) -> None:
    control = _locate(ctx, p)
    option = to_text(p.option).strip()
    names = _list_items(control)
    exact = next((n for n in names if n.strip().casefold() == option.casefold()), None)
    if exact is None:
        raise ActivityError(f"The list has no option '{option}'.",
                            f"Options: {', '.join(names)}" if names else "Check the spelling of the option.")
    chosen = False
    if hasattr(control, "Select"):  # ComboBoxControl: expands, clicks the item, like a person
        with contextlib.suppress(Exception):
            chosen = bool(control.Select(exact, simulateMove=False, waitTime=0.2))
    if not chosen:
        item = next((c for c in _descendants(control, 3) if c.ControlTypeName == "ListItemControl" and c.Name == exact), None)
        selector = _pattern(item, "GetSelectionItemPattern") if item is not None else None
        if selector is not None:
            selector.Select()
    # Never report success without checking: some lists ignore programmatic selection.
    shown = _text_of(control).strip()
    if shown.casefold() != exact.strip().casefold():
        raise ActivityError(f"Could not choose '{exact}' - the list still shows '{shown}'.",
                            "Try a click step on the list followed by a click on the option instead.")


def _list_items(control: Any) -> list[str]:
    """Names of the options, opening the list if needed to see them."""
    items = [c.Name for c in _descendants(control, 3) if c.ControlTypeName == "ListItemControl" and c.Name]
    if items:
        return items
    expander = _pattern(control, "GetExpandCollapsePattern")
    if expander is None:
        return []
    try:
        expander.Expand()
        wait(0.2)
        return [c.Name for c in _descendants(control, 3) if c.ControlTypeName == "ListItemControl" and c.Name]
    except Exception:
        return []
    finally:
        with contextlib.suppress(Exception):
            expander.Collapse()


def _pattern(control: Any, getter: str) -> Any:
    try:
        return getattr(control, getter)()
    except Exception:
        return None


def _descendants(control: Any, depth: int) -> list[Any]:
    out: list[Any] = []
    level = [control]
    for _ in range(depth):
        level = [child for parent in level for child in parent.GetChildren()]
        out.extend(level)
    return out


class CheckParams(ElementParams):
    checked: bool = Param(True, title="Ticked")


@activity(
    "desktop.check",
    title="Tick / untick in application",
    category=K,
    icon="square-check",
    sentence="Set {element} ticked: {checked}",
    params=CheckParams,
)
def check(ctx: RunContext, p: CheckParams) -> None:
    control = _locate(ctx, p)
    pattern = control.GetTogglePattern()
    if not pattern:
        raise ActivityError("That element can't be ticked.")
    if bool(pattern.ToggleState) != p.checked:
        pattern.Toggle()


@activity(
    "desktop.get_text",
    title="Get text from application",
    category=K,
    icon="text-cursor",
    sentence="Get text of {element}",
    params=ElementParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="app_text")],
)
def get_text(ctx: RunContext, p: ElementParams) -> str:
    return _text_of(_locate(ctx, p))


class KeysParams(Params):
    keys: str = Param(title="Keys", ui="keys", placeholder="Control+S, Enter, Tab")


_KEY_NAMES = {
    "control": "Ctrl", "ctrl": "Ctrl", "alt": "Alt", "shift": "Shift", "win": "Win", "enter": "Enter",
    "tab": "Tab", "escape": "Esc", "esc": "Esc", "delete": "Delete", "backspace": "Back", "space": "Space",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home", "end": "End",
    "pageup": "PageUp", "pagedown": "PageDown", **{f"f{i}": f"F{i}" for i in range(1, 13)},
}


def to_sendkeys(keys: str) -> str:
    """'Control+S, Enter' -> '{Ctrl}s{Enter}' (uiautomation SendKeys syntax)."""
    out = []
    for combo in [k.strip() for k in to_text(keys).split(",") if k.strip()]:
        parts = [x.strip() for x in combo.split("+")]
        for part in parts:
            name = _KEY_NAMES.get(part.lower())
            out.append(f"{{{name}}}" if name else part.lower() if len(parts) > 1 else part)
    return "".join(out)


@activity(
    "desktop.send_keys",
    title="Press keys in application",
    category=K,
    icon="keyboard",
    sentence="Press {keys}",
    description="Send keyboard shortcuts to the window in front, e.g. Control+S.",
    params=KeysParams,
)
def send_keys(ctx: RunContext, p: KeysParams) -> None:
    auto = _init(ctx)
    auto.SendKeys(to_sendkeys(p.keys), waitTime=0.05)


class WaitParams(ElementParams):
    state: Literal["appears", "disappears", "is enabled", "is disabled", "text contains", "text does not contain"] = Param(
        "appears", title="Wait until it"
    )
    text: str = Param("", title="Text", description="For the 'text contains' choices, e.g. Saved or a number.")


@activity(
    "desktop.wait_for",
    title="Wait for element in application",
    category=K,
    icon="hourglass",
    sentence="Wait until {element} {state} {text}",
    description="Wait for a screen, message or button state before continuing - more reliable than a fixed wait.",
    params=WaitParams,
)
def wait_for(ctx: RunContext, p: WaitParams) -> None:
    timeout = p.timeout if p.timeout is not None else ctx.flow.settings.default_timeout
    deadline = Deadline(timeout)
    if p.state == "appears":
        _locate(ctx, p)
        return
    wanted = to_text(p.text).casefold()
    while True:
        try:
            control = _locate(ctx, ElementParams(element=p.element, timeout=0))
        except ActivityError:
            if p.state == "disappears":
                return
            control = None
        if control is not None:
            if p.state == "is enabled" and control.IsEnabled:
                return
            if p.state == "is disabled" and not control.IsEnabled:
                return
            if p.state in ("text contains", "text does not contain"):
                shown = _text_of(control).casefold()
                if (wanted in shown) == (p.state == "text contains"):
                    return
        if deadline.passed:
            break
        ctx.sleep(0.25)
    raise ActivityError(f"'{p.state} {p.text}'".replace(" ''", "") + f" did not happen within {timeout:g} seconds.")


def _text_of(control: Any) -> str:
    for getter in ("GetValuePattern", "GetLegacyIAccessiblePattern"):
        pattern = _pattern(control, getter)
        value = getattr(pattern, "Value", None) if pattern is not None else None
        if value:
            return value
    return control.Name or ""


@activity(
    "desktop.read_table",
    title="Read table from application",
    category=K,
    icon="table",
    sentence="Read table {element}",
    description="Copy the rows of a grid or list in an application into a table variable.",
    params=ElementParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="app_table")],
)
def read_table(ctx: RunContext, p: ElementParams) -> Table:
    control = _locate(ctx, p)
    rows = []
    header: list[str] = []
    for child in control.GetChildren():
        cells = [specific(c) for c in child.GetChildren()]
        values = []
        for cell in cells:
            pattern = _pattern(cell, "GetValuePattern")
            value = pattern.Value if pattern is not None else None
            values.append(cell.Name if value in (None, "(null)") else value)
        if not values:
            continue
        name = (child.Name or "").lower()
        if not header and ("header" in name or "top row" in name or child.ControlTypeName == "HeaderControl"):
            header = [c.Name for c in cells]
            continue
        rows.append(values)
    if not header and rows:
        header = [f"Column{i + 1}" for i in range(len(rows[0]))]
    return Table.from_matrix([header, *rows], has_header=True)


class ScreenshotParams(Params):
    file: str = Param(title="Save as", ui="save_file", file_types=["png"])


@activity(
    "desktop.screenshot",
    title="Take screenshot of screen",
    category=K,
    icon="camera",
    sentence="Save screenshot to {file}",
    params=ScreenshotParams,
    outputs=[OutputDef("file", "Screenshot", "file", default_variable="screen_file")],
)
def screenshot(ctx: RunContext, p: ScreenshotParams) -> str:
    path = Path(to_text(p.file).strip() or ctx.file_path("screen.png"))
    if not path.suffix:
        path = path.with_suffix(".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    _screen_capture(path)
    return str(path)


# -- more about elements, menus, lists, programs (Brity "App" library) ------------------------------


@activity(
    "desktop.element_info",
    title="Get element details",
    category=K,
    icon="info",
    sentence="Get the details of {element}",
    description="Read where a control is and its state: position, size, visible, enabled, ticked, value.",
    params=ElementParams,
    outputs=[OutputDef("details", "Details", "any", default_variable="element")],
)
def element_info(ctx: RunContext, p: ElementParams) -> dict[str, Any]:
    control = _locate(ctx, p)
    rect = control.BoundingRectangle
    checked = None
    with contextlib.suppress(Exception):
        toggle = control.GetTogglePattern()
        if toggle:
            checked = toggle.ToggleState == 1
    value = ""
    with contextlib.suppress(Exception):
        pattern = control.GetValuePattern()
        value = pattern.Value if pattern else ""
    return {
        "x": rect.left, "y": rect.top, "width": rect.width(), "height": rect.height(),
        "visible": not control.IsOffscreen, "enabled": bool(control.IsEnabled),
        "checked": checked, "value": value or control.Name or "",
    }


class ExistsParams(ElementParams):
    timeout: float | None = Param(2, title="Wait up to (seconds)", ge=0, le=3600, advanced=True)


@activity(
    "desktop.element_exists",
    title="Does element exist",
    category=K,
    icon="search-check",
    sentence="Does {element} exist",
    description="Check whether a control is there (yes / no), without failing when it is not.",
    params=ExistsParams,
    outputs=[OutputDef("found", "Found", "boolean", default_variable="element_found")],
)
def element_exists(ctx: RunContext, p: ExistsParams) -> bool:
    try:
        _locate(ctx, p)
    except ActivityError:
        return False
    return True


class MenuParams(WindowParams):
    menu: str = Param(title="Menu item", placeholder="File > Save as",
                      description="The menu, then each item in it, separated by >.")


@activity(
    "desktop.select_menu",
    title="Choose menu item",
    category=K,
    icon="menu",
    sentence="Choose {menu} in {window}",
    description="Open a program's menu and choose an item, e.g. File > Save as.",
    params=MenuParams,
)
def select_menu(ctx: RunContext, p: MenuParams) -> None:
    auto = _init(ctx)
    parts = [part.strip() for part in to_text(p.menu).split(">") if part.strip()]
    if not parts:
        raise ActivityError("No menu item was given.", "Write the menu path, e.g. File > Save as.")
    window = find_window({"window": p.window, "process": p.process}, p.timeout, ctx.log)
    window.SetActive(waitTime=0.2)
    scope = window
    for depth, name in enumerate(parts):
        item = auto.MenuItemControl(searchFromControl=scope, Name=name, searchDepth=6 if depth == 0 else 12)
        if not item.Exists(5, 0.2):
            raise ActivityError(f"The menu item '{name}' was not found.", "Check the spelling, as shown in the program.")
        last = depth == len(parts) - 1
        expand = None if last else item.GetExpandCollapsePattern()
        if expand:
            expand.Expand()
        elif last and _invoke(item):
            pass
        else:
            item.Click(simulateMove=False)
        wait(0.3)
        scope = auto.GetRootControl()  # sub-menus open as separate pop-up windows


@activity(
    "desktop.read_list",
    title="Read list items",
    category=K,
    icon="list",
    sentence="Read the items of {element}",
    description="Get the entries of a list, drop-down or tree as a list (Brity GetListItems).",
    params=ElementParams,
    outputs=[OutputDef("items", "Items", "list", default_variable="items")],
)
def read_list(ctx: RunContext, p: ElementParams) -> list[str]:
    auto = uia()
    control = _locate(ctx, p)
    expand = None
    with contextlib.suppress(Exception):
        expand = control.GetExpandCollapsePattern()
    if expand and control.ControlTypeName == "ComboBoxControl":
        with contextlib.suppress(Exception):
            expand.Expand()
            wait(0.2)
    items = [
        item.Name
        for item, _depth in auto.WalkControl(control, maxDepth=3)
        if item.ControlTypeName in ("ListItemControl", "TreeItemControl", "DataItemControl") and item.Name
    ]
    if expand and control.ControlTypeName == "ComboBoxControl":
        with contextlib.suppress(Exception):
            expand.Collapse()
    return items


class CloseProgramParams(Params):
    program: str = Param(title="Program", placeholder="EXCEL.EXE",
                         description="The program's file name, as in Task Manager's Details tab.")
    force: bool = Param(False, title="Force it to close if it does not within 10 seconds",
                        description="Unsaved work in it is lost.")


@activity(
    "desktop.close_program",
    title="Close program",
    category=K,
    icon="power",
    sentence="Close all windows of {program}",
    description="Close every window of a program (Brity CloseAll), e.g. to start from a clean state.",
    params=CloseProgramParams,
)
def close_program(ctx: RunContext, p: CloseProgramParams) -> None:
    from ..selectors.desktop import process_name

    auto = _init(ctx)
    name = to_text(p.program).strip().lower()
    if not name:
        raise ActivityError("No program was given.", "Enter its file name, e.g. EXCEL.EXE.")
    pids = set()
    for window in auto.GetRootControl().GetChildren():
        if process_name(window.ProcessId).lower() == name:
            pids.add(window.ProcessId)
            with contextlib.suppress(Exception):
                pattern = window.GetWindowPattern()
                if pattern:
                    pattern.Close()
    if not pids:
        ctx.log(f"No window of {p.program} was open.")
        return
    deadline = Deadline(10)
    while not deadline.passed and any(_running(pid) for pid in pids):
        wait(0.3)
    left = [pid for pid in pids if _running(pid)]
    if left and p.force:
        for pid in left:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, check=False)
        ctx.log(f"{p.program} did not close by itself and was stopped.", "warning")
    elif left:
        raise ActivityError(f"{p.program} is still open (maybe it asks to save something).",
                            "Handle its question first, or tick 'Force it to close'.")


def _running(pid: int) -> bool:
    import ctypes

    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        return code.value == 259  # STILL_ACTIVE
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)
