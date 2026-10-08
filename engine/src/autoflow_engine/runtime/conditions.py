"""Conditions built with the visual rule editor ("Invoice total" is greater than 1000).

Conditions are evaluated lazily: the If/While/Filter activities re-check them
with the current variables (and the current row, for table filters).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..errors import ExpressionError
from ..values import to_text
from .expressions import coerce_pair, is_empty, is_number, truthy
from .templates import resolve


def _equals(a: Any, b: Any) -> bool:
    x, y = coerce_pair(a, b)
    return x == y


def _compare(op: Callable[[Any, Any], bool]) -> Callable[[Any, Any], bool]:
    def check(a: Any, b: Any) -> bool:
        x, y = coerce_pair(a, b)
        try:
            return op(x, y)
        except TypeError:
            return False

    return check


def _contains(a: Any, b: Any) -> bool:
    if isinstance(a, list | tuple):
        return any(_equals(item, b) for item in a)
    return to_text(b).casefold() in to_text(a).casefold()


def _matches(a: Any, b: Any) -> bool:
    try:
        return re.search(to_text(b), to_text(a)) is not None
    except re.error as exc:
        raise ExpressionError(f"The pattern '{b}' is not valid: {exc}") from None


# name -> (label shown in the UI, needs a right-hand value, check)
OPERATORS: dict[str, tuple[str, bool, Callable[[Any, Any], bool]]] = {
    "equals": ("is equal to", True, _equals),
    "not_equals": ("is not equal to", True, lambda a, b: not _equals(a, b)),
    "greater": ("is greater than", True, _compare(lambda a, b: a > b)),
    "greater_or_equal": ("is greater than or equal to", True, _compare(lambda a, b: a >= b)),
    "less": ("is less than", True, _compare(lambda a, b: a < b)),
    "less_or_equal": ("is less than or equal to", True, _compare(lambda a, b: a <= b)),
    "contains": ("contains", True, _contains),
    "not_contains": ("does not contain", True, lambda a, b: not _contains(a, b)),
    "starts_with": ("starts with", True, lambda a, b: to_text(a).casefold().startswith(to_text(b).casefold())),
    "ends_with": ("ends with", True, lambda a, b: to_text(a).casefold().endswith(to_text(b).casefold())),
    "is_empty": ("is empty", False, lambda a, _b: is_empty(a)),
    "is_not_empty": ("is not empty", False, lambda a, _b: not is_empty(a)),
    "is_true": ("is true", False, lambda a, _b: truthy(a)),
    "is_false": ("is false", False, lambda a, _b: not truthy(a)),
    "is_number": ("is a number", False, lambda a, _b: is_number(a)),
    "matches": ("matches pattern (advanced)", True, _matches),
}

OperatorName = Literal[
    "equals", "not_equals", "greater", "greater_or_equal", "less", "less_or_equal",
    "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty",
    "is_true", "is_false", "is_number", "matches",
]


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    left: Any = None
    op: OperatorName = "equals"
    right: Any = None


class Condition(BaseModel):
    """All (or any) of the rules must hold. ``expression`` is an advanced alternative."""

    model_config = ConfigDict(extra="forbid", json_schema_extra={"x-ui": "condition"})
    match: Literal["all", "any"] = "all"
    rules: list[Rule] = Field(default_factory=list)
    expression: str | None = Field(None, description="Advanced: a {{formula}} that is true or false.")

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, value: Any) -> Any:
        return normalize_condition(value)


def normalize_condition(value: Any) -> Any:
    """Any stored condition value in the model's shape.

    AI drafts may write a condition as text ("{{row['Paid']}}"), and Studio 0.3.0 and older split
    such text into one entry per character when a rule was added ({"0": "{", "1": "{", ...}).
    Text becomes a formula; split text is joined back unless the person added rules.
    Mirrors packages/flow-types/src/conditions.ts.
    """
    if isinstance(value, str):
        return {"expression": as_expression(value)} if value.strip() else {}
    if not isinstance(value, dict) or "0" not in value:
        return value
    chars: list[str] = []
    while isinstance(value.get(str(len(chars))), str):
        chars.append(value[str(len(chars))])
    cleaned = {k: v for k, v in value.items() if not (isinstance(k, str) and k.isdigit())}
    text = "".join(chars)
    if not cleaned.get("rules") and cleaned.get("expression") is None and text.strip():
        cleaned["expression"] = as_expression(text)
    return cleaned


def as_expression(text: str) -> str:
    """One formula from condition text: "{{row['A']}} > 100" would otherwise be the text "250 > 100"
    (always true), so it becomes "{{row['A'] > 100}}"."""
    stripped = text.strip()
    if re.fullmatch(r"\{\{.*\}\}", stripped, re.S) and "{{" not in stripped[2:]:
        return stripped
    return "{{" + stripped.replace("{{", "").replace("}}", "").strip() + "}}"


def evaluate_condition(condition: Condition, variables: Mapping[str, Any]) -> bool:
    if condition.expression and condition.expression.strip():
        return truthy(resolve(condition.expression, variables))
    if not condition.rules:
        raise ExpressionError("This condition has no rules.", "Add at least one rule to the condition.")
    results = (_check_rule(rule, variables) for rule in condition.rules)
    return all(results) if condition.match == "all" else any(results)


def _check_rule(rule: Rule, variables: Mapping[str, Any]) -> bool:
    _label, needs_right, check = OPERATORS[rule.op]
    left = resolve(rule.left, variables)
    right = resolve(rule.right, variables) if needs_right else None
    return check(left, right)
