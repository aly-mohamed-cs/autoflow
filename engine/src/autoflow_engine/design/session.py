"""Design-time browser: pick elements and record actions for Studio.

Playwright's sync API must be used from a single thread, and Studio must stay
responsive while the user clicks around. So the session owns one thread running
a small event loop: it executes queued tasks (start picking, stop recording...)
and keeps pumping Playwright so page callbacks are delivered.
"""

from __future__ import annotations

import base64
import contextlib
import logging
import queue
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future
from importlib.resources import files
from typing import Any

from ..errors import ActivityError
from ..flow import Element, Selector
from ..selectors.web import build_locator

log = logging.getLogger("autoflow.design")

Respond = Callable[..., None]  # respond(result=...) or respond(error=Exception)
Notify = Callable[[str, dict[str, Any]], None]

INJECT_JS = files("autoflow_engine.design").joinpath("inject.js").read_text(encoding="utf-8")
MAX_THUMB = (480, 160)
MAX_SELECTORS = 5
CHANNELS = {"edge": "msedge", "chrome": "chrome", "chromium": None}


class DesignSession:
    def __init__(self, notify: Notify, browser: str = "edge", headless: bool = False):
        self._notify = notify
        self._browser_name = browser
        self._headless = headless
        self._tasks: queue.Queue[Callable[[], None]] = queue.Queue()
        self._closed = False
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._mode = "off"
        self._pick_respond: Respond | None = None
        self._captures: list[tuple[str, Any, Any]] = []
        self._recorded: list[dict[str, Any]] = []
        self._last_page: Any = None
        self._last_action_at = 0.0
        self._thread = threading.Thread(target=self._loop, name="autoflow-design", daemon=True)
        self._thread.start()

    # -- public, thread-safe -----------------------------------------------------
    def pick(self, url: str | None, respond: Respond) -> None:
        self._submit(lambda: self._start_pick(url, respond), respond)

    def cancel(self) -> None:
        self._submit(self._cancel_pick)

    def record_start(self, url: str | None, respond: Respond) -> None:
        self._submit(lambda: self._start_record(url, respond), respond)

    def record_stop(self, respond: Respond) -> None:
        self._submit(lambda: self._stop_record(respond), respond)

    def run(self, fn: Callable[[Any], Any]) -> Future:
        """Run fn(page) on the design thread (used by tests to act like a user)."""
        future: Future = Future()

        def task() -> None:
            try:
                future.set_result(fn(self._current_page()))
            except Exception as exc:
                future.set_exception(exc)

        self._tasks.put(task)
        return future

    @property
    def mode(self) -> str:
        return self._mode

    def close(self) -> None:
        def task() -> None:
            self._shutdown_browser()
            self._closed = True

        self._tasks.put(task)
        self._thread.join(timeout=10)

    # -- loop ------------------------------------------------------------------------
    def _submit(self, fn: Callable[[], None], respond: Respond | None = None) -> None:
        def task() -> None:
            try:
                fn()
            except Exception as exc:
                log.exception("design task failed")
                if respond is not None:
                    respond(error=exc)

        self._tasks.put(task)

    def _loop(self) -> None:
        while not self._closed:
            try:
                task = self._tasks.get(timeout=0.03 if self._context else 0.5)
            except queue.Empty:
                task = None
            if task is not None:
                task()
            if self._context is not None and not self._closed:
                self._pump()
                self._process_captures()

    def _pump(self) -> None:
        """Let Playwright deliver page callbacks; detect the user closing the browser."""
        try:
            page = self._current_page()
            page.wait_for_timeout(30)
        except Exception:
            self._browser_gone()

    def _browser_gone(self) -> None:
        log.info("design browser closed by the user")
        self._shutdown_browser()
        if self._pick_respond:
            self._pick_respond(result=None)
            self._pick_respond = None
        if self._mode == "record":
            self._notify("recorder.stopped", {"reason": "browser_closed"})
        self._mode = "off"

    # -- browser -------------------------------------------------------------------
    def _ensure_browser(self, url: str | None) -> Any:
        if self._context is None:
            from playwright.sync_api import sync_playwright

            self._pw = sync_playwright().start()
            try:
                self._browser = self._pw.chromium.launch(
                    channel=CHANNELS.get(self._browser_name), headless=self._headless, args=["--start-maximized"]
                )
            except Exception as exc:
                self._pw.stop()
                self._pw = None
                raise ActivityError(
                    f"Could not open the browser for picking: {str(exc).splitlines()[0]}",
                    "Check that Microsoft Edge is installed.",
                ) from None
            self._context = self._browser.new_context(no_viewport=True)
            self._context.expose_binding("__autoflowPicked", self._on_picked)
            self._context.expose_binding("__autoflowRecorded", self._on_recorded)
            self._context.expose_function("__autoflowMode", lambda: self._mode)
            self._context.add_init_script(INJECT_JS + "\nwindow.__autoflowMode && window.__autoflowMode().then(m => window.__autoflow.setMode(m));")
            self._context.on("page", self._on_new_page)
            page = self._context.new_page()
            self._watch(page)
            if url:
                page.goto(_normalize_url(url), wait_until="domcontentloaded")
        elif url and self._current_page().url in ("about:blank", ""):
            self._current_page().goto(_normalize_url(url), wait_until="domcontentloaded")
        return self._current_page()

    def _current_page(self) -> Any:
        if self._context is None:
            raise ActivityError("The design browser is not open.")
        pages = [p for p in self._context.pages if not p.is_closed()]
        if not pages:
            raise ActivityError("The design browser was closed.")
        return self._last_page if self._last_page in pages else pages[-1]

    def _on_new_page(self, page: Any) -> None:
        self._watch(page)

    def _watch(self, page: Any) -> None:
        page.on("framenavigated", lambda frame: self._on_navigated(page, frame))

    def _on_navigated(self, page: Any, frame: Any) -> None:
        # Address typed by the user (not caused by a recorded click shortly before).
        if self._mode == "record" and frame == page.main_frame and time.monotonic() - self._last_action_at > 2:
            self._captures.append(("goto", page, frame.url))

    def _set_mode(self, mode: str) -> None:
        self._mode = mode
        for page in list(self._context.pages if self._context else []):
            for frame in page.frames:
                # A frame navigating away asks for the mode itself when it loads.
                with contextlib.suppress(Exception):
                    frame.evaluate("m => window.__autoflow && window.__autoflow.setMode(m)", mode)

    def _shutdown_browser(self) -> None:
        for closer in (self._context, self._browser, self._pw):
            if closer is not None:
                with contextlib.suppress(Exception):
                    closer.stop() if closer is self._pw else closer.close()
        self._pw = self._browser = self._context = self._last_page = None

    # -- picking -------------------------------------------------------------------
    def _start_pick(self, url: str | None, respond: Respond) -> None:
        if self._pick_respond:
            self._pick_respond(result=None)
        page = self._ensure_browser(url)
        self._pick_respond = respond
        self._set_mode("pick")
        page.bring_to_front()

    def _cancel_pick(self) -> None:
        if self._pick_respond:
            self._pick_respond(result=None)
            self._pick_respond = None
        if self._mode == "pick":
            self._set_mode("off")

    def _on_picked(self, source: dict[str, Any], info: dict[str, Any] | None) -> None:
        self._captures.append(("pick", source["frame"], info))

    # -- recording -----------------------------------------------------------------
    def _start_record(self, url: str | None, respond: Respond) -> None:
        page = self._ensure_browser(url)
        self._recorded = []
        self._last_page = page
        self._last_action_at = time.monotonic()
        self._set_mode("record")
        page.bring_to_front()
        respond(result={"url": page.url})

    def _stop_record(self, respond: Respond) -> None:
        self._process_captures()
        self._set_mode("off")
        respond(result={"actions": self._recorded})

    def _on_recorded(self, source: dict[str, Any], payload: dict[str, Any]) -> None:
        self._last_action_at = time.monotonic()
        self._captures.append(("record", source["frame"], payload))

    # -- turning captures into elements ------------------------------------------------
    def _process_captures(self) -> None:
        while self._captures:
            kind, ref, payload = self._captures.pop(0)
            try:
                if kind == "pick":
                    self._finish_pick(ref, payload)
                elif kind == "record" and self._mode == "record":
                    self._add_recorded(ref, payload)
                elif kind == "goto" and self._mode == "record":
                    self._emit_action({"action": "goto", "url": payload})
            except Exception as exc:
                log.exception("could not process %s", kind)
                if kind == "pick" and self._pick_respond:
                    self._pick_respond(error=exc)
                    self._pick_respond = None

    def _finish_pick(self, frame: Any, info: dict[str, Any] | None) -> None:
        respond, self._pick_respond = self._pick_respond, None
        self._set_mode("off")
        if respond is None:
            return
        respond(result=None if info is None else self.element_from(frame, info, kind_hint="web").model_dump())

    def _add_recorded(self, frame: Any, payload: dict[str, Any]) -> None:
        page = frame.page
        if self._last_page is not None and page != self._last_page:
            self._emit_action({"action": "switch_tab"})
        self._last_page = page
        element = self.element_from(frame, payload["target"], kind_hint="web")
        action = {k: v for k, v in payload.items() if k != "target"}
        action["element"] = element.model_dump()
        self._emit_action(action)

    def _emit_action(self, action: dict[str, Any]) -> None:
        self._recorded.append(action)
        self._notify("recorder.action", action)

    def element_from(self, frame: Any, info: dict[str, Any], kind_hint: str = "web") -> Element:
        mark = info.get("mark", "")
        target = frame.locator(f'[data-autoflow-mark="{mark}"]')
        selectors = self._verified_selectors(frame, info, mark)
        screenshot = self._thumbnail(frame, target)
        with contextlib.suppress(Exception):
            target.evaluate("e => e.removeAttribute('data-autoflow-mark')")
        page = frame.page
        return Element(
            id=f"el_{uuid.uuid4().hex[:12]}",
            name=(info.get("friendly") or info.get("tag") or "element")[:60],
            kind="web",
            selectors=selectors,
            screenshot=screenshot,
            context={"url": page.url, "title": _safe(page.title), "frames": _frame_chain(frame)},
        )

    def _verified_selectors(self, frame: Any, info: dict[str, Any], mark: str) -> list[Selector]:
        role, name = info.get("role"), info.get("name")
        candidates: list[Selector] = []
        if info.get("testid"):
            candidates.append(Selector(strategy="testid", value=info["testid"]))
        if role and name:
            candidates.append(Selector(strategy="role", value=role, options={"name": name}))
        if info.get("label"):
            candidates.append(Selector(strategy="label", value=info["label"]))
        if info.get("placeholder"):
            candidates.append(Selector(strategy="placeholder", value=info["placeholder"]))
        if info.get("text") and role in (None, "button", "link", "heading", "cell", "tab", "menuitem", "option"):
            candidates.append(Selector(strategy="text", value=info["text"], options={"exact": True}))
        candidates += [Selector(strategy="css", value=css) for css in info.get("css") or []]
        if info.get("xpath"):
            candidates.append(Selector(strategy="xpath", value=info["xpath"]))

        verified: list[Selector] = []
        for selector in candidates:
            try:
                locator = build_locator(frame, selector)
                if locator.count() != 1:
                    continue
                if not locator.evaluate("(e, m) => e.getAttribute('data-autoflow-mark') === m", mark):
                    continue  # unique, but a different element
            except Exception:
                continue
            verified.append(selector)
            if len(verified) >= MAX_SELECTORS:
                break
        if not verified:
            fallback = (info.get("css") or [None])[-1] or info.get("xpath")
            if fallback:
                verified.append(Selector(strategy="css" if not fallback.startswith("/") else "xpath", value=fallback))
        if not verified:
            raise ActivityError("Autoflow could not find a reliable way to locate that element.")
        return verified

    def _thumbnail(self, frame: Any, target: Any) -> str | None:
        try:
            for f in frame.page.frames:
                f.evaluate("() => window.__autoflow && window.__autoflow.hideOverlay()")
            box = target.bounding_box()
            if not box or box["width"] < 1 or box["height"] < 1:
                return None
            pad = 6
            clip = {
                "x": max(box["x"] - pad, 0),
                "y": max(box["y"] - pad, 0),
                "width": min(box["width"] + 2 * pad, MAX_THUMB[0]),
                "height": min(box["height"] + 2 * pad, MAX_THUMB[1]),
            }
            png = frame.page.screenshot(clip=clip, type="png")
            return "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        except Exception as exc:
            log.debug("thumbnail failed: %s", exc)
            return None


def _frame_chain(frame: Any) -> list[str]:
    """CSS selectors of the iframes leading to this frame, outermost first."""
    chain: list[str] = []
    current = frame
    while current.parent_frame is not None:
        try:
            handle = current.frame_element()
            css = handle.evaluate("e => window.__autoflow ? window.__autoflow.cssPath(e) : null")
        except Exception:
            css = None
        chain.insert(0, css or "iframe")
        current = current.parent_frame
    return chain


def _normalize_url(url: str) -> str:
    url = url.strip()
    return url if "://" in url or url.startswith(("about:", "data:")) else "https://" + url


def _safe(fn: Callable[[], str]) -> str:
    try:
        return fn()
    except Exception:
        return ""
