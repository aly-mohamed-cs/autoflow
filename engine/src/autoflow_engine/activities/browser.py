"""Websites and web applications, driven through Playwright.

By default the browser is the Microsoft Edge already installed on Windows, so
robot machines need no extra downloads. One browser session is shared by all
browser steps of a run and closed automatically when the run ends.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..selectors.web import find, selector_from_text
from ..values import Table, to_text

B = "Browser"
_SESSION = "browser"

BROWSER_CHANNELS = {"edge": "msedge", "chrome": "chrome", "chromium": None}


class BrowserSession:
    def __init__(self, ctx: RunContext, browser: str, headless: bool, profile: str | None):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:  # pragma: no cover - packaging problem
            raise ActivityError("Browser automation is not installed on this computer.") from None
        self.ctx = ctx
        self._closed = False
        self._pw = sync_playwright().start()
        channel = BROWSER_CHANNELS[browser]
        launch_args = {"channel": channel, "headless": headless, "args": ["--start-maximized"]}
        try:
            if profile:
                folder = _profiles_dir() / profile
                folder.mkdir(parents=True, exist_ok=True)
                self.context = self._pw.chromium.launch_persistent_context(
                    str(folder), accept_downloads=True, no_viewport=True, **launch_args
                )
                self.browser = None
                self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            else:
                self.browser = self._pw.chromium.launch(**launch_args)
                self.context = self.browser.new_context(accept_downloads=True, no_viewport=True)
                self.page = self.context.new_page()
        except Exception as exc:
            self._pw.stop()
            name = {"edge": "Microsoft Edge", "chrome": "Google Chrome"}.get(browser, browser)
            raise ActivityError(
                f"Could not start {name}: {str(exc).splitlines()[0]}",
                f"Check that {name} is installed on this computer, or choose another browser.",
            ) from None
        self.context.set_default_timeout(ctx.flow.settings.default_timeout * 1000)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.context.close()
            if self.browser is not None:
                self.browser.close()
        finally:
            self._pw.stop()

    def screenshot(self, path: Path) -> bool:
        if self.page.is_closed():
            return False
        self.page.screenshot(path=str(path))
        return True


def _profiles_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Autoflow" / "browser-profiles"


def _session(ctx: RunContext) -> BrowserSession:
    session = ctx.resources.get(_SESSION)
    if session is None:
        raise ActivityError("No browser is open.", "Add an 'Open browser' step before this one.")
    if session.page.is_closed():
        open_pages = [p for p in session.context.pages if not p.is_closed()]
        if not open_pages:
            raise ActivityError("The browser window was closed.", "Add an 'Open browser' step to open it again.")
        session.page = open_pages[-1]
    return session


def _page(ctx: RunContext) -> Any:
    return _session(ctx).page


def _url(value: Any) -> str:
    url = to_text(value).strip()
    if not url:
        raise ActivityError("No web address was given.")
    if "://" not in url and not url.startswith(("about:", "data:")):
        url = "https://" + url
    return url


# -- element settings shared by many steps ------------------------------------


class ElementParams(Params):
    element: str = Param("", title="Element", ui="element")
    selector: str = Param(
        "", title="Selector (advanced)", advanced=True,
        description="CSS, //xpath, text=... or role=button:Name. Used when no element is picked.",
    )
    timeout: float | None = Param(None, title="Wait up to (seconds)", ge=0, le=3600, advanced=True)


def _locate(ctx: RunContext, p: ElementParams, *, visible: bool = True) -> Any:
    from ..flow import Element

    timeout = p.timeout if p.timeout is not None else ctx.flow.settings.default_timeout
    if p.element:
        element = ctx.elements.get(p.element)
        if element is None:
            raise ActivityError("The chosen element no longer exists in this flow.", "Pick the element again.")
    elif p.selector.strip():
        element = Element(id="adhoc", name=p.selector.strip(), kind="web", selectors=[selector_from_text(p.selector)])
    else:
        raise ActivityError("No element was chosen.", "Click 'Pick element' and select it on the page.")
    if element.kind != "web":
        raise ActivityError(f"'{element.name}' is a desktop element, not a web element.")
    return find(_page(ctx), element, timeout, visible=visible, log=ctx.log).locator


# -- opening and navigating -------------------------------------------------------


class OpenParams(Params):
    url: str = Param(title="Web address", ui="url", placeholder="https://portal.example.com")
    browser: Literal["edge", "chrome", "chromium"] = Param("edge", title="Browser")
    profile: str = Param(
        "", title="Remember logins using profile", advanced=True,
        description="Keep cookies between runs in a named profile, e.g. for sites with 'remember me'.",
    )
    new_tab: bool = Param(False, title="Open in a new tab if a browser is already open", advanced=True)


@activity(
    "browser.open",
    title="Open browser",
    category=B,
    icon="globe",
    sentence="Open {url} in {browser}",
    description="Start a browser and go to a web page. Later browser steps use this window.",
    params=OpenParams,
)
def open_browser(ctx: RunContext, p: OpenParams) -> None:
    url = _url(p.url)
    session = ctx.resources.get(_SESSION)
    if session is None:
        session = BrowserSession(ctx, p.browser, ctx.options.headless, p.profile.strip() or None)
        ctx.resources[_SESSION] = session
        ctx.resources["screenshot"] = session.screenshot
        ctx.add_cleanup(_SESSION, session.close)
    elif p.new_tab:
        session.page = session.context.new_page()
    _goto(session.page, url)


def _goto(page: Any, url: str) -> None:
    try:
        page.goto(url, wait_until="domcontentloaded")
    except Exception as exc:
        message = str(exc).splitlines()[0]
        if "ERR_NAME_NOT_RESOLVED" in message or "ERR_CONNECTION" in message:
            raise ActivityError(f"Could not reach {url}.", "Check the address and the network connection.") from None
        raise


class GoToParams(Params):
    url: str = Param(title="Web address", ui="url")


@activity(
    "browser.go_to",
    title="Go to web page",
    category=B,
    icon="navigation",
    sentence="Go to {url}",
    params=GoToParams,
)
def go_to(ctx: RunContext, p: GoToParams) -> None:
    _goto(_page(ctx), _url(p.url))


class NavigateParams(Params):
    action: Literal["back", "forward", "reload"] = Param("back", title="Action")


@activity(
    "browser.navigate",
    title="Back / forward / reload",
    category=B,
    icon="history",
    sentence="Browser {action}",
    params=NavigateParams,
)
def navigate(ctx: RunContext, p: NavigateParams) -> None:
    page = _page(ctx)
    {"back": page.go_back, "forward": page.go_forward, "reload": page.reload}[p.action]()


# -- interacting ------------------------------------------------------------------


class ClickParams(ElementParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")


@activity(
    "browser.click",
    title="Click",
    category=B,
    icon="mouse-pointer-click",
    sentence="Click {element}",
    description="Click a button, link or any element on the page.",
    params=ClickParams,
)
def click(ctx: RunContext, p: ClickParams) -> None:
    target = _locate(ctx, p)
    if p.click == "double":
        target.dblclick()
    elif p.click == "right":
        target.click(button="right")
    else:
        target.click()


class TypeParams(ElementParams):
    text: str = Param(title="Text to type")
    clear_first: bool = Param(True, title="Clear the field first")
    press_enter: bool = Param(False, title="Press Enter afterwards")
    slowly: bool = Param(False, title="Type one key at a time", advanced=True,
                         description="For pages that react to every key press.")


@activity(
    "browser.type",
    title="Type text",
    category=B,
    icon="keyboard",
    sentence="Type {text} into {element}",
    description="Fill in a text box. Passwords from credentials are never shown in logs.",
    params=TypeParams,
)
def type_text(ctx: RunContext, p: TypeParams) -> None:
    target = _locate(ctx, p)
    text = to_text(p.text)
    if p.slowly:
        if p.clear_first:
            target.fill("")
        target.press_sequentially(text, delay=40)
    elif p.clear_first:
        target.fill(text)
    else:
        target.press("End")
        target.press_sequentially(text)
    if p.press_enter:
        target.press("Enter")


class SelectParams(ElementParams):
    option: str = Param(title="Option", description="The visible text (or value) of the option to choose.")


@activity(
    "browser.select",
    title="Choose from dropdown",
    category=B,
    icon="list-checks",
    sentence="Choose {option} in {element}",
    params=SelectParams,
)
def select_option(ctx: RunContext, p: SelectParams) -> None:
    target = _locate(ctx, p)
    option = to_text(p.option)
    try:
        target.select_option(label=option, timeout=2000)
    except Exception:
        try:
            target.select_option(value=option, timeout=2000)
        except Exception:
            raise ActivityError(f"The dropdown has no option '{option}'.", "Check the spelling of the option.") from None


class CheckParams(ElementParams):
    checked: bool = Param(True, title="Ticked")


@activity(
    "browser.check",
    title="Tick / untick checkbox",
    category=B,
    icon="square-check",
    sentence="Set {element} ticked: {checked}",
    params=CheckParams,
)
def check(ctx: RunContext, p: CheckParams) -> None:
    target = _locate(ctx, p)
    target.set_checked(p.checked)


@activity(
    "browser.hover",
    title="Hover over element",
    category=B,
    icon="pointer",
    sentence="Hover over {element}",
    description="Move the mouse over an element, e.g. to open a menu.",
    params=ElementParams,
)
def hover(ctx: RunContext, p: ElementParams) -> None:
    _locate(ctx, p).hover()


class PressKeyParams(Params):
    keys: str = Param(title="Keys", ui="keys", placeholder="Enter, Tab, Control+A")


@activity(
    "browser.press_key",
    title="Press key",
    category=B,
    icon="keyboard",
    sentence="Press {keys}",
    params=PressKeyParams,
)
def press_key(ctx: RunContext, p: PressKeyParams) -> None:
    page = _page(ctx)
    for combo in [k.strip() for k in to_text(p.keys).split(",") if k.strip()]:
        page.keyboard.press(combo)


class UploadParams(ElementParams):
    file: str = Param(title="File to upload", ui="file")


@activity(
    "browser.upload",
    title="Upload file",
    category=B,
    icon="upload",
    sentence="Upload {file} using {element}",
    description="Pick the page's file input (or its upload button).",
    params=UploadParams,
)
def upload(ctx: RunContext, p: UploadParams) -> None:
    path = Path(to_text(p.file).strip())
    if not path.is_file():
        raise ActivityError(f"The file '{path}' does not exist.")
    target = _locate(ctx, p, visible=False)
    if target.evaluate("e => e.tagName === 'INPUT' && e.type === 'file'"):
        target.set_input_files(str(path))
        return
    with _page(ctx).expect_file_chooser() as chooser:
        target.click()
    chooser.value.set_files(str(path))


# -- reading ----------------------------------------------------------------------


@activity(
    "browser.get_text",
    title="Get text",
    category=B,
    icon="text-cursor",
    sentence="Get text of {element}",
    description="Read the text of an element, or the value typed in a text box.",
    params=ElementParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="page_text")],
)
def get_text(ctx: RunContext, p: ElementParams) -> str:
    target = _locate(ctx, p)
    is_input = target.evaluate("e => ['INPUT','TEXTAREA','SELECT'].includes(e.tagName)")
    text = target.input_value() if is_input else target.inner_text()
    return " ".join(text.split()) if "\n" not in text else text.strip()


class AttributeParams(ElementParams):
    attribute: str = Param("href", title="Attribute", placeholder="href")


@activity(
    "browser.get_attribute",
    title="Get attribute",
    category=B,
    icon="tag",
    sentence="Get {attribute} of {element}",
    advanced=True,
    params=AttributeParams,
    outputs=[OutputDef("value", "Value", "text", default_variable="attribute_value")],
)
def get_attribute(ctx: RunContext, p: AttributeParams) -> str | None:
    return _locate(ctx, p, visible=False).get_attribute(p.attribute)


_EXTRACT_TABLE_JS = """
(table) => {
  const clean = (c) => (c.innerText || '').replace(/\\s+/g, ' ').trim();
  const rows = Array.from(table.querySelectorAll('tr'))
    .filter((r) => r.closest('table') === table);
  return rows.map((r) => Array.from(r.children)
    .filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map(clean));
}
"""


class ExtractTableParams(ElementParams):
    has_header: bool = Param(True, title="First row has column names")


@activity(
    "browser.extract_table",
    title="Extract table from page",
    category=B,
    icon="table",
    sentence="Extract table {element}",
    description="Copy an HTML table from the page into a table variable.",
    params=ExtractTableParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="web_table")],
)
def extract_table(ctx: RunContext, p: ExtractTableParams) -> Table:
    target = _locate(ctx, p)
    if target.evaluate("e => e.tagName") != "TABLE":
        inner = target.locator("table").first
        if inner.count() == 0:
            raise ActivityError("The chosen element is not a table.", "Pick the table itself.")
        target = inner
    matrix = [row for row in target.evaluate(_EXTRACT_TABLE_JS) if any(cell for cell in row)]
    return Table.from_matrix(matrix, p.has_header)


class WaitForParams(ElementParams):
    state: Literal["appears", "disappears"] = Param("appears", title="Wait until it")
    fail_if_not: bool = Param(True, title="Fail if it doesn't happen in time")


@activity(
    "browser.wait_for",
    title="Wait for element",
    category=B,
    icon="hourglass",
    sentence="Wait until {element} {state}",
    description="Wait for something to show up (or go away), like a results table or a loading spinner.",
    params=WaitForParams,
    outputs=[OutputDef("ok", "Happened in time", "boolean", default_variable="element_ready")],
)
def wait_for(ctx: RunContext, p: WaitForParams) -> bool:
    timeout = p.timeout if p.timeout is not None else ctx.flow.settings.default_timeout
    if p.state == "appears":
        try:
            _locate(ctx, p)
            return True
        except ActivityError:
            if p.fail_if_not:
                raise
            return False
    try:
        locator = _locate(ctx, ElementParams(element=p.element, selector=p.selector, timeout=0), visible=False)
    except ActivityError:
        return True  # already gone
    try:
        locator.wait_for(state="hidden", timeout=timeout * 1000)
        return True
    except Exception:
        if p.fail_if_not:
            raise ActivityError(f"The element was still on the page after {timeout:g} seconds.") from None
        return False


class ExistsParams(ElementParams):
    pass


@activity(
    "browser.element_exists",
    title="Check if element exists",
    category=B,
    icon="scan-eye",
    sentence="Check if {element} is on the page",
    description="True/false, for use with 'If'. Waits only briefly (2 seconds by default).",
    params=ExistsParams,
    outputs=[OutputDef("exists", "Exists", "boolean", default_variable="element_found")],
)
def element_exists(ctx: RunContext, p: ExistsParams) -> bool:
    timeout = p.timeout if p.timeout is not None else 2
    try:
        _locate(ctx, ElementParams(element=p.element, selector=p.selector, timeout=timeout))
        return True
    except ActivityError as exc:
        if "several elements" in exc.message:
            return True
        return False


class PageInfoParams(Params):
    pass


@activity(
    "browser.page_info",
    title="Get page address and title",
    category=B,
    icon="link",
    sentence="Get page address and title",
    params=PageInfoParams,
    outputs=[OutputDef("url", "Address", "text", default_variable="page_url"),
             OutputDef("title", "Title", "text", default_variable="page_title")],
)
def page_info(ctx: RunContext, p: PageInfoParams) -> dict[str, str]:
    page = _page(ctx)
    return {"url": page.url, "title": page.title()}


# -- files ------------------------------------------------------------------------


class DownloadParams(ElementParams):
    folder: str = Param(title="Save to folder", ui="folder")
    file_name: str = Param("", title="File name", placeholder="(keep the website's name)")
    overwrite: bool = Param(True, title="Replace if it exists")


@activity(
    "browser.download",
    title="Download file",
    category=B,
    icon="download",
    sentence="Download by clicking {element} into {folder}",
    description="Click a download link or button and save the file.",
    params=DownloadParams,
    outputs=[OutputDef("file", "Downloaded file", "file", default_variable="downloaded_file")],
)
def download(ctx: RunContext, p: DownloadParams) -> str:
    folder = Path(to_text(p.folder).strip())
    if not to_text(p.folder).strip():
        raise ActivityError("No folder was chosen.")
    folder.mkdir(parents=True, exist_ok=True)
    target = _locate(ctx, p)
    timeout = (p.timeout if p.timeout is not None else max(ctx.flow.settings.default_timeout, 60)) * 1000
    try:
        with _page(ctx).expect_download(timeout=timeout) as info:
            target.click()
    except Exception as exc:
        if "Timeout" in type(exc).__name__ or "Timeout" in str(exc):
            raise ActivityError("Clicking did not start a download.", "Check that this is the right link.") from None
        raise
    dl = info.value
    name = to_text(p.file_name).strip() or dl.suggested_filename
    if not Path(name).suffix and Path(dl.suggested_filename).suffix:
        name += Path(dl.suggested_filename).suffix
    path = folder / name
    if path.exists():
        if not p.overwrite:
            raise ActivityError(f"'{path}' already exists.")
        path.unlink()
    dl.save_as(str(path))
    if dl.failure():
        raise ActivityError(f"The download failed: {dl.failure()}")
    return str(path)


class ScreenshotParams(Params):
    file: str = Param(title="Save as", ui="save_file", file_types=["png"])
    full_page: bool = Param(False, title="Whole page (not just the visible part)")


@activity(
    "browser.screenshot",
    title="Take screenshot of page",
    category=B,
    icon="camera",
    sentence="Save screenshot to {file}",
    params=ScreenshotParams,
    outputs=[OutputDef("file", "Screenshot", "file", default_variable="screenshot_file")],
)
def screenshot(ctx: RunContext, p: ScreenshotParams) -> str:
    path = Path(to_text(p.file).strip() or ctx.file_path("screenshot.png"))
    if not path.suffix:
        path = path.with_suffix(".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    _page(ctx).screenshot(path=str(path), full_page=p.full_page)
    return str(path)


# -- tabs and scripts -----------------------------------------------------------------


class SwitchTabParams(Params):
    match: Literal["newest", "title contains", "address contains", "first"] = Param("newest", title="Switch to")
    text: str = Param("", title="Text to look for")


@activity(
    "browser.switch_tab",
    title="Switch tab",
    category=B,
    icon="panels-top-left",
    sentence="Switch to tab: {match} {text}",
    description="Work in another tab, e.g. one opened by clicking a link.",
    params=SwitchTabParams,
)
def switch_tab(ctx: RunContext, p: SwitchTabParams) -> None:
    session = _session(ctx)
    pages = [pg for pg in session.context.pages if not pg.is_closed()]
    if p.match == "newest":
        chosen = pages[-1]
    elif p.match == "first":
        chosen = pages[0]
    else:
        wanted = to_text(p.text).casefold()
        key = (lambda pg: pg.title()) if p.match == "title contains" else (lambda pg: pg.url)
        chosen = next((pg for pg in pages if wanted in key(pg).casefold()), None)
        if chosen is None:
            raise ActivityError(f"No open tab matches '{p.text}'.")
    session.page = chosen
    chosen.bring_to_front()


class CloseTabParams(Params):
    what: Literal["tab", "browser"] = Param("browser", title="Close")


@activity(
    "browser.close",
    title="Close browser",
    category=B,
    icon="x",
    sentence="Close {what}",
    params=CloseTabParams,
)
def close(ctx: RunContext, p: CloseTabParams) -> None:
    session = ctx.resources.get(_SESSION)
    if session is None:
        return
    if p.what == "tab" and len(session.context.pages) > 1:
        session.page.close()
        session.page = session.context.pages[-1]
        return
    session.close()
    ctx.resources.pop(_SESSION, None)
    ctx.resources.pop("screenshot", None)


class ScriptParams(Params):
    script: str = Param(title="JavaScript", ui="code", placeholder="() => document.title")


@activity(
    "browser.run_script",
    title="Run JavaScript",
    category=B,
    icon="code",
    sentence="Run JavaScript on the page",
    advanced=True,
    params=ScriptParams,
    outputs=[OutputDef("result", "Result", "any", default_variable="script_result")],
)
def run_script(ctx: RunContext, p: ScriptParams) -> Any:
    return _page(ctx).evaluate(p.script)
