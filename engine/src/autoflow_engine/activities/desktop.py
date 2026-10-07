"""Windows desktop applications (ERP clients, legacy software) through UI Automation.

Desktop steps need a signed-in, unlocked desktop. On robots that means the robot
account signs in automatically (see ROBOT-SETUP.md).
"""

from __future__ import annotations

import contextlib
import subprocess
import time
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..flow import Element
from ..runtime.context import RunContext
from ..selectors.desktop import find, find_window, specific, uia
from ..values import Table, to_text

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
        window = find_window({"window": p.window}, p.timeout)
        window.SetActive(waitTime=0.1)
    else:
        time.sleep(1)
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
    window = find_window({"window": p.window}, p.timeout)
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
        window = find_window({"window": p.window}, p.timeout)
    except ActivityError:
        return
    pattern = window.GetWindowPattern()
    if pattern:
        pattern.Close()
    else:
        window.SendKeys("{Alt}{F4}")


# -- interacting -----------------------------------------------------------------------------------


class ClickParams(ElementParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")


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
    if p.click == "single" and _invoke(control):
        return
    if p.click == "double":
        control.DoubleClick(simulateMove=False)
    elif p.click == "right":
        control.RightClick(simulateMove=False)
    else:
        control.Click(simulateMove=False)


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
        time.sleep(0.2)
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
    deadline = time.monotonic() + timeout
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
        if time.monotonic() >= deadline:
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
