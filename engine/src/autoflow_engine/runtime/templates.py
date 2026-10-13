"""Resolve {{ }} references inside step settings.

``"Hello {{name}}"`` becomes text; a setting that is exactly ``"{{invoices}}"``
keeps the variable's real value (a table stays a table).
"""

from __future__ import annotations

import ast
import re
from collections.abc import Mapping
from typing import Any

from ..values import to_text
from .expressions import FUNCTIONS, evaluate, parse

TEMPLATE = re.compile(r"\{\{(.+?)\}\}", re.DOTALL)
_ALIASES = {"true", "false", "null", "none", "yes", "no"}
_FUNCTION_NAMES = {name.upper() for name in FUNCTIONS}


def resolve(value: Any, variables: Mapping[str, Any]) -> Any:
    if isinstance(value, str):
        return resolve_text(value, variables)
    if isinstance(value, dict):
        return {k: resolve(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, variables) for v in value]
    return value


def resolve_text(text: str, variables: Mapping[str, Any]) -> Any:
    if "{{" not in text:
        return text
    # Not fullmatch: that stretches the lazy match over "{{first}} {{last}}" as one formula.
    whole = TEMPLATE.match(text)
    if whole and whole.end() == len(text):
        return evaluate(whole.group(1), variables)
    return TEMPLATE.sub(lambda m: to_text(evaluate(m.group(1), variables)), text)


def has_template(value: Any) -> bool:
    if isinstance(value, str):
        return "{{" in value
    if isinstance(value, dict):
        return any(has_template(v) for v in value.values())
    if isinstance(value, list):
        return any(has_template(v) for v in value)
    return False


def referenced_variables(value: Any) -> set[str]:
    """Variable names used by {{ }} references inside a setting (for validation)."""
    names: set[str] = set()
    if isinstance(value, str):
        for match in TEMPLATE.finditer(value):
            tree = parse(match.group(1))
            for node in ast.walk(tree):
                if isinstance(node, ast.Name):
                    if node.id.lower() in _ALIASES:
                        continue
                    if node.id.upper() in _FUNCTION_NAMES and _is_called(tree, node):
                        continue
                    names.add(node.id)
    elif isinstance(value, dict):
        for v in value.values():
            names |= referenced_variables(v)
    elif isinstance(value, list):
        for v in value:
            names |= referenced_variables(v)
    return names


def _is_called(tree: ast.AST, name: ast.Name) -> bool:
    return any(isinstance(n, ast.Call) and n.func is name for n in ast.walk(tree))
