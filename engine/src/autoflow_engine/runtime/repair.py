"""AI self-repair: when a step fails, ask the company's AI model for new settings and retry.

The engine never talks to the model itself. It describes the failure (the step, the
error, what is on screen) to a *repair provider* given by the host - Studio or the
robot - which forwards it to the Orchestrator. A fix only changes the current run and
is retried from the failed step, so work already done is never repeated. Keeping a fix
is a person's decision: Studio offers Keep / Discard, robots file a suggested version.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from ..errors import AutoflowError
from ..flow import Element, Selector, Step
from ..values import Table, type_name
from .templates import resolve

if TYPE_CHECKING:
    from ..catalog import ActivityDef
    from .context import RunContext

log = logging.getLogger("autoflow.engine.repair")

RepairProvider = Callable[[dict[str, Any]], "dict[str, Any] | None"]

# Steps whose failures are usually about the screen or the data, where new settings can help.
# Not: control logic, credentials, email, HTTP or database writes (a retry could repeat a side effect).
REPAIRABLE_CATEGORIES = frozenset({"Browser", "Desktop", "Excel", "Files", "Data", "Text", "PDF"})
PROTECTED_UI = frozenset({"credential", "password"})
# The assistant may change how a step *finds* things, never what it does with the data: which
# element, how long to wait, which sheet or column, and which file to *read*. Never web
# addresses, typed values, output files or credentials - an unattended robot uses a fix before
# anyone reviews it, and page text could try to steer the model (prompt injection).
# Keep in sync with apps/server/src/services/ai.ts.
LOCATOR_PARAMS = frozenset({"element", "selector", "timeout", "sheet", "range", "column", "columns", "has_header",
                            "encoding", "window", "process"})
READ_ONLY = frozenset({
    "browser.get_text", "browser.extract_table", "browser.wait_for", "browser.element_exists", "browser.page_info",
    "desktop.get_text", "desktop.wait_for", "desktop.read_table",
    "excel.read", "excel.read_cell", "excel.list_sheets",
    "files.list", "files.exists", "files.wait_for_file", "files.info", "files.read_text", "files.read_csv",
    "pdf.read_text", "pdf.extract_tables", "pdf.extract_fields", "pdf.page_count", "pdf.read_image",
})
READ_PATH_UI = frozenset({"file", "folder"})
WEB_STRATEGIES = frozenset({"role", "text", "label", "placeholder", "testid", "css", "xpath"})
PATH_UI = frozenset({"file", "folder", "save_file"})
MAX_CALLS_PER_RUN = 10


@dataclass
class Fix:
    explanation: str
    params: dict[str, Any]
    selectors: list[Selector] | None
    element_name: str | None


def changeable_params(adef: ActivityDef) -> frozenset[str]:
    """Settings of this step type the assistant may change (see LOCATOR_PARAMS)."""
    names = set()
    for name in adef.params.model_fields:
        ui = _ui(adef, name)
        if ui in PROTECTED_UI:
            continue
        if name in LOCATOR_PARAMS or (adef.id in READ_ONLY and ui in READ_PATH_UI):
            names.add(name)
    return frozenset(names)


def can_repair(adef: ActivityDef, step: Step) -> bool:
    if adef.category not in REPAIRABLE_CATEGORIES or adef.blocks or adef.advanced or not changeable_params(adef):
        return False
    # A step that types or uses a password is never handed to the assistant.
    return "password" not in json.dumps(step.params, default=str).lower()


def element_kind(adef: ActivityDef) -> str | None:
    if "element" not in adef.params.model_fields:
        return None
    return "desktop" if adef.category == "Desktop" else "web"


def _ui(adef: ActivityDef, name: str) -> str | None:
    extra = adef.params.model_fields[name].json_schema_extra
    return extra.get("x-ui") if isinstance(extra, dict) else None


# -- describing the failure -------------------------------------------------------


def describe_failure(ctx: RunContext, step: Step, adef: ActivityDef, error: AutoflowError,
                     attempts: list[dict[str, Any]]) -> dict[str, Any]:
    element = _element_of(ctx, step)
    request = {
        "flow_name": ctx.flow.name,
        "activity": adef.id,
        "step": {"id": step.id, "label": step.label, "params": step.params},
        "element": element.model_dump(exclude={"screenshot"}) if element else None,
        "error": {"message": error.message, "hint": error.hint},
        "screen": _screen(ctx, step, adef, element),
        "variables": _variables(ctx),
        "attempts": attempts,
    }
    return ctx.masked(request)


def _element_of(ctx: RunContext, step: Step) -> Element | None:
    element_id = step.params.get("element")
    return ctx.elements.get(element_id) if isinstance(element_id, str) and element_id else None


def _screen(ctx: RunContext, step: Step, adef: ActivityDef, element: Element | None) -> dict[str, Any] | None:
    try:
        if adef.category == "Browser":
            session = ctx.resources.get("browser")
            page = getattr(session, "page", None)
            if page is None or page.is_closed():
                return None
            from ..selectors import web

            return web.snapshot(page)
        if adef.category == "Desktop":
            from ..selectors import desktop

            return desktop.snapshot(element.context if element else None)
        return _files(ctx, step, adef)
    except Exception as exc:  # a snapshot is a nice-to-have; never fail the repair over it
        log.info("could not capture the screen for repair: %s", exc)
        return None


def _files(ctx: RunContext, step: Step, adef: ActivityDef) -> dict[str, Any] | None:
    """For file steps: what is in the folder of a missing file, or the sheets of a workbook."""
    found: dict[str, Any] = {}
    for name in adef.params.model_fields:
        if _ui(adef, name) not in PATH_UI or not step.params.get(name):
            continue
        try:
            value = resolve(step.params[name], ctx.variables)
        except AutoflowError:
            continue
        if not isinstance(value, str) or not value.strip():
            continue
        path = Path(value)
        if not path.exists():
            parent = path.parent
            if parent.is_dir():
                entries = sorted(p.name + ("\\" if p.is_dir() else "") for p in parent.iterdir())
                found[name] = {"missing": str(path), "folder": str(parent), "entries": entries[:60]}
            else:
                found[name] = {"missing": str(path), "folder_missing": str(parent)}
        elif path.suffix.lower() in (".xlsx", ".xlsm"):
            found[name] = {"workbook": str(path), "sheets": _sheets(path)}
    return {"kind": "files", "paths": found} if found else None


def _sheets(path: Path) -> list[dict[str, Any]]:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        sheets = []
        for ws in wb.worksheets[:8]:
            header = next(ws.iter_rows(min_row=1, max_row=1, max_col=30, values_only=True), ())
            sheets.append({"name": ws.title, "first_row": [str(v) for v in header if v is not None]})
        return sheets
    finally:
        wb.close()


def _variables(ctx: RunContext) -> list[dict[str, Any]]:
    """Names and kinds of the variables (no values: they can be personal data)."""
    out = []
    for name, value in list(ctx.variables.items())[:60]:
        item: dict[str, Any] = {"name": name, "type": type_name(value)}
        if isinstance(value, Table):
            item["columns"] = list(value.columns)[:40]
        elif isinstance(value, dict):
            item["keys"] = [str(k) for k in list(value)[:40]]
        out.append(item)
    return out


# -- reading and applying the answer ------------------------------------------------


def parse_fix(step: Step, adef: ActivityDef, reply: Any) -> Fix | None:
    """Keep only changes this step can take; None when the assistant has no usable fix."""
    if not isinstance(reply, dict) or reply.get("fixable") is False:
        return None
    allowed_params = changeable_params(adef)
    params: dict[str, Any] = {}
    for key, value in (reply.get("params") or {}).items():
        if key not in allowed_params or key == "element":
            continue
        if value != step.params.get(key):
            params[key] = value
    selectors: list[Selector] | None = None
    kind = element_kind(adef)
    if kind and isinstance(reply.get("selectors"), list):
        allowed = WEB_STRATEGIES if kind == "web" else frozenset({"uia"})
        parsed = []
        for raw in reply["selectors"][:5]:
            try:
                selector = Selector.model_validate(raw)
            except ValidationError:
                continue
            if selector.strategy in allowed and (selector.value.strip() or selector.options):
                parsed.append(selector)
        selectors = parsed or None
    if not params and not selectors:
        return None
    explanation = str(reply.get("explanation") or "").strip()[:500] or "Adjusted the settings of this step."
    name = str(reply.get("element_name") or "").strip()[:80] or None
    return Fix(explanation, params, selectors, name)


@dataclass
class Trial:
    """A fix applied for one try. ``commit`` keeps it for the rest of the run, ``revert`` undoes it."""

    step: Step
    patch: dict[str, Any]
    _ctx: RunContext
    _original_step: Step
    _element_id: str | None
    _previous_element: Element | None

    def commit(self) -> None:
        # Later uses of this step (e.g. the next rows of a loop) run with the fix too.
        self._original_step.params = self.step.params

    def revert(self) -> None:
        if self._element_id is None:
            return
        if self._previous_element is None:
            self._ctx.elements.pop(self._element_id, None)
        else:
            self._ctx.elements[self._element_id] = self._previous_element


def try_fix(ctx: RunContext, step: Step, adef: ActivityDef, fix: Fix, screen: dict[str, Any] | None) -> Trial:
    params = {**step.params, **fix.params}
    element_id: str | None = None
    previous: Element | None = None
    element_patch: dict[str, Any] | None = None
    new_element = False
    if fix.selectors:
        current = _element_of(ctx, step)
        if current is not None:
            element_id, previous = current.id, current
            kept = [s for s in current.selectors if s not in fix.selectors]
            context = {k: v for k, v in current.context.items() if k != "nth"}  # positions refer to the old selectors
            patched = current.model_copy(update={"selectors": [*fix.selectors, *kept], "context": context})
        else:
            new_element = True
            element_id = f"el_ai_{step.id}"
            kind = element_kind(adef) or "web"
            where: dict[str, Any] = {}
            if kind == "desktop" and screen and screen.get("kind") == "desktop":
                where = {"window": screen.get("window", ""), "process": screen.get("process", "")}
            patched = Element(id=element_id, name=fix.element_name or "Element found by the AI assistant",
                              kind=kind, selectors=fix.selectors, context=where)
            params["element"] = element_id
        ctx.elements[element_id] = patched
        element_patch = patched.model_dump(exclude={"screenshot"})
    patch = {
        "step_id": step.id,
        "params": {k: v for k, v in params.items() if step.params.get(k) != v},
        "element": element_patch,
        "new_element": new_element,
    }
    return Trial(step.model_copy(update={"params": params}), patch, ctx, step, element_id, previous)
