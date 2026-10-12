"""Static checks that Studio shows as red/yellow markers before a flow runs."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from pydantic import ValidationError

from . import catalog
from .errors import ExpressionError, friendly
from .flow import Flow, Step
from .runtime.templates import has_template, referenced_variables


@dataclass
class Issue:
    severity: str  # "error" | "warning"
    message: str
    step_id: str | None = None
    field: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


def _ui(field_info: Any) -> str | None:
    extra = field_info.json_schema_extra
    return extra.get("x-ui") if isinstance(extra, dict) else None


def shown(field_info: Any, params: dict[str, Any], fields: dict[str, Any]) -> bool:
    """Settings with ``show_when`` only count while the other setting has one of those values."""
    extra = field_info.json_schema_extra
    rule = extra.get("x-show-when") if isinstance(extra, dict) else None
    if not rule:
        return True
    for other, values in rule.items():
        current = params.get(other)
        if current is None and other in fields:
            current = fields[other].default
        if str(current) not in [str(v) for v in values]:
            return False
    return True


def validate_flow(document: Flow | dict[str, Any]) -> list[Issue]:
    catalog.load_activities()
    if isinstance(document, Flow):
        flow = document
    else:
        try:
            flow = Flow.model_validate(document)
        except ValidationError as exc:
            return [
                Issue("error", f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}")
                for e in exc.errors()
            ]

    issues: list[Issue] = []
    steps = list(flow.iter_steps())

    process_ids: set[str] = set()
    for process in flow.processes:
        if process.id in process_ids:
            issues.append(Issue("error", f"Two sub-processes share the id '{process.id}'."))
        process_ids.add(process.id)
        names = [i.name for i in process.inputs]
        for name in sorted({n for n in names if names.count(n) > 1}):
            issues.append(Issue("error", f"Sub-process '{process.name}' has two inputs called '{name}'."))

    seen: set[str] = set()
    for step in steps:
        if step.id in seen:
            issues.append(Issue("error", f"Two steps share the id '{step.id}'.", step.id))
        seen.add(step.id)

    known_vars = _known_variables(flow, steps)
    element_ids = {e.id for e in flow.elements}

    for step in steps:
        if step.disabled:
            continue
        adef = catalog.get(step.activity)
        if adef is None:
            issues.append(Issue("error", f"Unknown step type '{step.activity}'.", step.id))
            continue
        block_names = {b.name for b in adef.blocks}
        for name in step.blocks:
            if name not in block_names:
                issues.append(Issue("warning", f"'{adef.title}' has no section called '{name}'.", step.id))
        output_names = {o.name for o in adef.outputs}
        for name in step.outputs:
            if name not in output_names:
                issues.append(Issue("warning", f"'{adef.title}' has no result called '{name}'.", step.id))
        issues.extend(_check_params(step, adef, known_vars, element_ids, process_ids))
    return issues


def _known_variables(flow: Flow, steps: list[Step]) -> set[str]:
    known = {v.name for v in flow.variables}
    for process in flow.processes:
        known.update(i.name for i in process.inputs)
    for step in steps:
        known.update(v for v in step.outputs.values() if v)
        adef = catalog.get(step.activity)
        if adef is None:
            continue
        for name, field_info in adef.params.model_fields.items():
            if _ui(field_info) == "variable_name":
                value = step.params.get(name, field_info.default)
                if isinstance(value, str) and value:
                    known.add(value)
    return known


def _check_params(
    step: Step,
    adef: catalog.ActivityDef,
    known_vars: set[str],
    element_ids: set[str],
    process_ids: set[str],
) -> list[Issue]:
    issues: list[Issue] = []
    model = adef.params
    fields = model.model_fields
    for name in step.params:
        if name not in fields:
            issues.append(Issue("warning", f"Unknown setting '{name}' will be ignored.", step.id, name))

    probe = model.model_construct()
    for name, field_info in fields.items():
        if not shown(field_info, step.params, fields):
            continue  # hidden by another setting: its value is not used
        label = field_info.title or name
        present = name in step.params
        value = step.params.get(name)
        if not present or value in (None, ""):
            if field_info.is_required():
                issues.append(Issue("error", f"'{label}' is required.", step.id, name))
            continue

        lazy = name in adef.lazy_fields
        # Undefined variables and formula typos
        try:
            names = referenced_variables(value)
        except ExpressionError as exc:
            issues.append(Issue("error", f"'{label}': {exc.message}", step.id, name))
            continue
        allowed = known_vars | ({"row"} if lazy else set())
        for var in sorted(names - allowed):
            issues.append(Issue("warning", f"'{label}' uses '{var}', which is never set.", step.id, name))

        if _ui(field_info) == "element" and isinstance(value, str) and value and value not in element_ids:
            issues.append(Issue("error", f"'{label}' points to a UI element that no longer exists.", step.id, name))
        if _ui(field_info) == "process" and isinstance(value, str) and value and value not in process_ids:
            issues.append(Issue("error", f"'{label}' points to a sub-process that no longer exists.", step.id, name))

        if has_template(value) and not lazy:
            continue  # real value only known at run time
        try:
            model.__pydantic_validator__.validate_assignment(probe, name, value)
        except ValidationError as exc:
            issues.append(Issue("error", friendly(exc).message.replace("This step's settings are not valid: ", ""),
                                step.id, name))
        except Exception:  # pragma: no cover - defensive; never block editing on a checker bug
            pass
    return issues
