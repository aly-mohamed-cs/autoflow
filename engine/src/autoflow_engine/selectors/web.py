"""Find a web element using its ranked list of selectors.

The recorder saves several ways to find each element (accessible role + name,
visible text, label, test id, CSS, XPath). At run time they are tried in order;
the first that matches exactly one visible element wins. When a fallback is
needed the run log says so, which tells the designer the page changed and the
element should be re-picked - before the remaining selectors break too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..errors import ActivityError
from ..flow import Element, Selector
from ..runtime.context import Deadline, wait


@dataclass
class Match:
    locator: Any
    selector: Selector
    index: int


def build_locator(scope: Any, selector: Selector) -> Any:
    """Turn a saved selector into a Playwright locator on a page or frame."""
    value, opts = selector.value, selector.options
    exact = bool(opts.get("exact", False))
    match selector.strategy:
        case "role":
            kwargs: dict[str, Any] = {}
            if opts.get("name"):
                kwargs["name"] = opts["name"]
                kwargs["exact"] = exact
            return scope.get_by_role(value, **kwargs)
        case "text":
            return scope.get_by_text(value, exact=exact)
        case "label":
            return scope.get_by_label(value, exact=exact)
        case "placeholder":
            return scope.get_by_placeholder(value, exact=exact)
        case "testid":
            return scope.get_by_test_id(value)
        case "css":
            return scope.locator(value)
        case "xpath":
            return scope.locator(value if value.startswith("xpath=") else f"xpath={value}")
        case _:
            raise ActivityError(f"'{selector.strategy}' selectors cannot be used on web pages.")


def _scope(page: Any, element: Element) -> Any:
    """Enter the iframes the element lives in (recorded as a list of CSS selectors)."""
    scope = page
    for frame_selector in element.context.get("frames", []) or []:
        scope = scope.frame_locator(frame_selector)
    return scope


def _nth(locator: Any, element: Element) -> Any:
    nth = element.context.get("nth")
    return locator.nth(int(nth)) if isinstance(nth, int) else locator


def find(page: Any, element: Element, timeout: float, *, visible: bool = True,
         log: Any = None) -> Match:
    """Wait up to ``timeout`` seconds for the element; raise a friendly error if absent."""
    scope = _scope(page, element)
    deadline = Deadline(timeout)
    ambiguous: list[str] = []
    while True:
        ambiguous.clear()
        for index, selector in enumerate(element.selectors):
            try:
                locator = _nth(build_locator(scope, selector), element)
                count = locator.count()
            except ActivityError:
                raise
            except Exception:
                continue  # invalid selector on this page/frame; try the next one
            if count == 0:
                continue
            if count > 1 and "nth" not in element.context:
                if visible:
                    visible_items = [i for i in range(min(count, 20)) if _is_visible(locator.nth(i))]
                    if len(visible_items) == 1:
                        locator = locator.nth(visible_items[0])
                        count = 1
                if count > 1:
                    ambiguous.append(selector.strategy)
                    continue
            target = locator.first
            if visible and not _is_visible(target):
                continue
            if index > 0 and log is not None:
                log(
                    f"'{element.name}' was found using a backup method ({selector.strategy}). "
                    "The page may have changed; consider picking this element again.",
                    "warning",
                )
            return Match(target, selector, index)
        if deadline.passed:
            break
        wait(0.2)
    if ambiguous:
        raise ActivityError(
            f"'{element.name}' matches several elements on the page.",
            "Pick the element again so Autoflow can tell them apart.",
        )
    raise ActivityError(
        f"Couldn't find '{element.name}' after {timeout:g} seconds.",
        "Check that the right page is open, wait longer, or pick the element again.",
    )


def _is_visible(locator: Any) -> bool:
    try:
        return bool(locator.is_visible())
    except Exception:
        return False


def selector_from_text(text: str) -> Selector:
    """An ad-hoc selector typed by a power user: CSS, //xpath or text=..."""
    text = text.strip()
    if text.startswith(("//", "xpath=")):
        return Selector(strategy="xpath", value=text)
    if text.lower().startswith("text="):
        return Selector(strategy="text", value=text[5:].strip().strip('"'), options={"exact": True})
    if re.match(r"^role=", text, re.I):
        role, _, name = text[5:].partition(":")
        return Selector(strategy="role", value=role.strip(), options={"name": name.strip()} if name else {})
    return Selector(strategy="css", value=text)


_SNAPSHOT_JS = r"""
(limit) => {
  const out = [];
  const seen = new Set();
  const query = 'a,button,input,select,textarea,label,h1,h2,h3,th,[role],[contenteditable="true"],[data-testid],[aria-label]';
  for (const el of document.querySelectorAll(query)) {
    if (out.length >= limit) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const item = { tag: el.tagName.toLowerCase() };
    for (const a of ['role', 'type', 'id', 'name', 'placeholder', 'aria-label', 'data-testid', 'title']) {
      const v = el.getAttribute(a);
      if (v) item[a] = v.slice(0, 80);
    }
    if (el.labels && el.labels.length) item.label = el.labels[0].innerText.trim().slice(0, 80);
    // Visible text only: never what was typed into fields (it may be personal or a password).
    if (!['input', 'textarea', 'select'].includes(item.tag)) {
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (text) item.text = text.slice(0, 80);
    } else if (item.tag === 'select') {
      item.options = Array.from(el.options).slice(0, 15).map((o) => o.text.trim().slice(0, 40));
    }
    out.push(item);
  }
  return out;
}
"""


def snapshot(page: Any, limit: int = 150) -> dict[str, Any]:
    """What is on the page now, for the AI assistant: address, title and visible elements."""
    return {
        "kind": "web",
        "url": page.url,
        "title": page.title(),
        "elements": page.evaluate(_SNAPSHOT_JS, limit),
    }
