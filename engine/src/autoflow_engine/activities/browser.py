"""Websites and web applications, driven through Playwright.

By default the browser is the Microsoft Edge already installed on Windows, so
robot machines need no extra downloads. One browser session is shared by all
browser steps of a run and closed automatically when the run ends.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Literal

from .. import downloads
from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import Deadline, RunContext, wait
from ..selectors.web import find, selector_from_text
from ..values import Table, parse_point, to_text

B = "Browser"
_SESSION = "browser"
log = logging.getLogger("autoflow.browser")


def _key(download: Any) -> Any:
    """The same download is wrapped anew in each callback: compare what's inside."""
    return getattr(download, "_impl_obj", download)

BROWSER_CHANNELS = {"edge": "msedge", "chrome": "chrome", "chromium": None}


class BrowserSession:
    def __init__(self, ctx: RunContext, browser: str, headless: bool, profile: str | None):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:  # pragma: no cover - packaging problem
            raise ActivityError("Browser automation is not installed on this computer.") from None
        self.ctx = ctx
        self._closed = False
        # Downloads: the "Download file" step handles its own (claimed); any other one lands in the
        # Downloads folder with the website's file name.
        self.claiming = False
        self._claimed: list[Any] = []
        self._done: dict[Any, Path | Exception] = {}
        self._saving = 0
        self._pw = sync_playwright().start()
        channel = BROWSER_CHANNELS[browser]
        launch_args = {"channel": channel, "headless": headless, "args": ["--start-maximized"]}
        # Always a normal window (not a private one): with a named profile it keeps logins between
        # runs, otherwise it starts clean in a temporary profile that is removed afterwards.
        self._temp_profile = None if profile else tempfile.mkdtemp(prefix="autoflow-browser-")
        folder = _profiles_dir() / profile if profile else Path(self._temp_profile)
        try:
            folder.mkdir(parents=True, exist_ok=True)
            self.context = self._pw.chromium.launch_persistent_context(
                str(folder), accept_downloads=True, no_viewport=True, **launch_args
            )
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        except Exception as exc:
            self._pw.stop()
            self._remove_temp_profile()
            name = {"edge": "Microsoft Edge", "chrome": "Google Chrome"}.get(browser, browser)
            raise ActivityError(
                f"Could not start {name}: {str(exc).splitlines()[0]}",
                f"Check that {name} is installed on this computer, or choose another browser.",
            ) from None
        self.context.set_default_timeout(ctx.flow.settings.default_timeout * 1000)
        # Loading a page may take longer than finding an element (a slow portal, a new profile).
        self.context.set_default_navigation_timeout(max(ctx.flow.settings.default_timeout, 60) * 1000)
        try:
            self.saver: downloads.BrowserDownloads | None = downloads.BrowserDownloads(self.context)
        except Exception as exc:  # then Autoflow copies each download out of Playwright's folder
            log.warning("the browser can't save downloads itself: %s", exc)
            self.saver = None
        for page in self.context.pages:
            self._watch(page)
        self.context.on("page", self._watch)

    def _watch(self, page: Any) -> None:
        page.on("download", self._on_download)

    def claim(self, download: Any) -> None:
        """The "Download file" step takes care of this download."""
        self._claimed.append(_key(download))

    def _on_download(self, download: Any) -> None:
        # Playwright runs this between the run's own browser calls (a step, a wait, closing); it
        # may wait for the download to end meanwhile.
        claimed = self.claiming or _key(download) in self._claimed
        if claimed and self.saver is None:
            return  # the step saves it
        self._saving += 1
        try:
            if self.saver is None:
                path = downloads.save(download, downloads.downloads_folder(), existing="keep_both", log=self.ctx.log)
            else:
                folder = self.saver.folder
                path = downloads.located(download, folder)
                if claimed:
                    self._done[_key(download)] = path
                    return
                name = downloads.target_name("", path.name, downloads.sniff(path), self.ctx.log)
                path = downloads.place(path, folder / name, "replace")  # like the browser itself
            self.ctx.log(f"Downloaded {path}")
        except Exception as exc:
            if claimed:
                self._done[_key(download)] = exc
            else:
                self.ctx.log(f"A download could not be saved: {str(exc).splitlines()[0]}", "warning")
        finally:
            self._saving -= 1

    def saved(self, download: Any, seconds: float) -> Path:
        """Wait (up to `seconds`) until the browser has saved a claimed download; the file."""
        key = _key(download)
        deadline = Deadline(seconds)
        while key not in self._done:
            if deadline.passed:
                with contextlib.suppress(Exception):
                    download.cancel()
                raise ActivityError(f"The download did not finish within {seconds / 60:g} minutes.")
            self.ctx.sleep(0.25)  # lets the browser report the end of the download
        result = self._done.pop(key)
        if isinstance(result, Exception):
            raise result
        return result

    def pump(self, seconds: float) -> bool:
        """Wait while the browser delivers its events (downloads are saved meanwhile)."""
        page = next((p for p in self.context.pages if not p.is_closed()), None)
        if page is None or self._closed:
            return False
        try:
            page.wait_for_timeout(seconds * 1000)
        except Exception:
            return False
        return True

    def _finish_downloads(self) -> None:
        """Before closing: save downloads a click started just before (the browser deletes them)."""
        if self.ctx.control.cancelled:
            return
        self.pump(0.5)
        give_up = time.monotonic() + 600
        while self._saving and time.monotonic() < give_up and self.pump(0.2):
            pass

    def close(self) -> None:
        if self._closed:
            return
        with contextlib.suppress(Exception):  # the browser may already be gone
            self._finish_downloads()
        self._closed = True
        if self.ctx.pump == self.pump:
            self.ctx.pump = None
        try:
            self.context.close()
        finally:
            self._pw.stop()
            self._remove_temp_profile()

    def _remove_temp_profile(self) -> None:
        if self._temp_profile:
            shutil.rmtree(self._temp_profile, ignore_errors=True)

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
        ctx.pump = session.pump
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
    icon="rotate-ccw",
    sentence="Browser {action}",
    params=NavigateParams,
)
def navigate(ctx: RunContext, p: NavigateParams) -> None:
    page = _page(ctx)
    {"back": page.go_back, "forward": page.go_forward, "reload": page.reload}[p.action]()


# -- interacting ------------------------------------------------------------------


def _point_param() -> Any:
    return Param(
        "", title="Point inside the element", ui="point", placeholder="Centre",
        description="X, Y in pixels from the element's top-left corner. Leave empty for its centre.",
    )


def _position(point: str) -> dict[str, int] | None:
    if not point:
        return None
    x, y = parse_point(point)
    return {"x": x, "y": y}


class ClickParams(ElementParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")
    point: str = _point_param()


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
    where = {"position": pos} if (pos := _position(p.point)) else {}
    if p.click == "double":
        target.dblclick(**where)
    elif p.click == "right":
        target.click(button="right", **where)
    else:
        target.click(**where)


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


class HoverParams(ElementParams):
    point: str = _point_param()


@activity(
    "browser.hover",
    title="Hover over element",
    category=B,
    icon="pointer",
    sentence="Hover over {element}",
    description="Move the mouse over an element, e.g. to open a menu.",
    params=HoverParams,
)
def hover(ctx: RunContext, p: HoverParams) -> None:
    where = {"position": pos} if (pos := _position(p.point)) else {}
    _locate(ctx, p).hover(**where)


class DragDropParams(ElementParams):
    element: str = Param("", title="Drag", ui="element")
    target: str = Param("", title="Drop on", ui="element")


@activity(
    "browser.drag_drop",
    title="Drag and drop",
    category=B,
    icon="hand-grab",
    sentence="Drag {element} onto {target}",
    description="Drag an element (a card, a file in a list, a slider handle) onto another one.",
    params=DragDropParams,
)
def drag_drop(ctx: RunContext, p: DragDropParams) -> None:
    source = _locate(ctx, p)
    target = _locate(ctx, ElementParams(element=p.target, timeout=p.timeout))
    source.drag_to(target)


class PressKeyParams(Params):
    keys: str = Param(title="Keys", ui="keys", placeholder="Enter, Tab, Control+A",
                      description="One key or a combination per comma: Enter, Tab, Esc, Down, F5, Ctrl+A...")


# What people write -> the browser's key names (which are exact: "Enter", "Control", "ArrowDown").
_BROWSER_KEYS = {
    "ctrl": "Control", "control": "Control", "alt": "Alt", "shift": "Shift", "win": "Meta", "windows": "Meta",
    "meta": "Meta", "cmd": "Meta", "enter": "Enter", "return": "Enter", "tab": "Tab", "esc": "Escape",
    "escape": "Escape", "space": "Space", "spacebar": "Space", "del": "Delete", "delete": "Delete",
    "backspace": "Backspace", "back": "Backspace", "ins": "Insert", "insert": "Insert", "home": "Home",
    "end": "End", "pageup": "PageUp", "pgup": "PageUp", "pagedown": "PageDown", "pgdn": "PageDown",
    "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "arrowup": "ArrowUp",
    "arrowdown": "ArrowDown", "arrowleft": "ArrowLeft", "arrowright": "ArrowRight", "plus": "+",
    **{f"f{i}": f"F{i}" for i in range(1, 13)},
}


def browser_keys(text: str) -> list[str]:
    """ "ctrl+a, enter" -> ["Control+a", "Enter"] (any case, common short names)."""
    combos = []
    for combo in [c.strip() for c in text.split(",") if c.strip()]:
        parts = [k.strip() for k in combo.split("+") if k.strip()] or ["+"]
        names = []
        for key in parts:
            name = _BROWSER_KEYS.get(key.lower().replace(" ", ""))
            if name is None and len(key) != 1:
                raise ActivityError(
                    f"'{key}' is not a key name.",
                    "Use names like Enter, Tab, Esc, Down, Backspace, F5, or a combination like Ctrl+A.",
                )
            names.append(name or (key.lower() if len(parts) > 1 else key))
        combos.append("+".join(names))
    if not combos:
        raise ActivityError("No key was given.", "Write the key to press, e.g. Enter.")
    return combos


@activity(
    "browser.press_key",
    title="Press key",
    category=B,
    icon="keyboard",
    sentence="Press {keys}",
    description="Press keys in the web page, e.g. Enter to search after typing. The key goes to the box that "
    "has the focus: click it (or type into it) first.",
    params=PressKeyParams,
)
def press_key(ctx: RunContext, p: PressKeyParams) -> None:
    page = _page(ctx)
    for combo in browser_keys(to_text(p.keys)):
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
    # Polled rather than one long browser-side wait, so Stop and Pause work meanwhile.
    deadline = Deadline(timeout)
    while not deadline.passed:
        try:
            if not locator.is_visible():
                return True
        except Exception:
            return True  # the page changed: it's gone
        wait(0.25)
    if p.fail_if_not:
        raise ActivityError(f"The element was still on the page after {timeout:g} seconds.")
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
        return "several elements" in exc.message


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
    folder: str = Param("", title="Save to folder", ui="folder", placeholder="(the Downloads folder)")
    file_name: str = Param("", title="File name", placeholder="(keep the website's name)")
    overwrite: bool = Param(True, title="Replace if it exists")
    open_file: bool = Param(False, title="Open the file when the download has finished",
                            description="Opens it with its program, e.g. Excel.")


@activity(
    "browser.download",
    title="Download file",
    category=B,
    icon="download",
    sentence="Download by clicking {element} into {folder}",
    description="Click a download link or button, wait until the file is downloaded and keep it with its own "
    "name (Excel, PDF, CSV...). The next steps get the file.",
    params=DownloadParams,
    outputs=[OutputDef("file", "Downloaded file", "file", default_variable="downloaded_file")],
)
def download(ctx: RunContext, p: DownloadParams) -> str:
    chosen = to_text(p.folder).strip()
    folder = Path(chosen) if chosen else downloads.downloads_folder()
    name = to_text(p.file_name)
    existing = "replace" if p.overwrite else "fail"
    target = _locate(ctx, p)
    session = _session(ctx)
    seconds = p.timeout if p.timeout is not None else max(ctx.flow.settings.default_timeout, 60)
    saver = session.saver
    # The browser saves it straight into the folder (its download list then opens it), unless
    # it's renamed or must not replace a file: then next to the run first.
    landing = folder if not name.strip() and p.overwrite else ctx.file_path("downloads")
    session.claiming = True
    try:
        if saver is not None:
            saver.save_into(landing)
        try:
            with session.page.expect_download(timeout=seconds * 1000) as info:
                target.click()
            session.claim(info.value)
        except Exception as exc:
            if "Timeout" in type(exc).__name__ or "Timeout" in str(exc):
                raise ActivityError("Clicking did not start a download.", "Check that this is the right link.") from None
            raise
        finally:
            session.claiming = False
        if saver is None:
            path = downloads.save(info.value, folder, name, existing=existing, log=ctx.log)
        else:
            saved = session.saved(info.value, max(seconds, 1800))
            final = downloads.target_name(name, saved.name, downloads.sniff(saved), ctx.log)
            path = downloads.place(saved, folder / final, existing)
    finally:
        if saver is not None:
            saver.save_into(downloads.downloads_folder())
    if p.open_file:
        os.startfile(path)  # type: ignore[attr-defined]  # Windows only
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
