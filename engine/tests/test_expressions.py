import datetime as dt

import pytest

from autoflow_engine.errors import ExpressionError
from autoflow_engine.runtime.conditions import Condition, evaluate_condition
from autoflow_engine.runtime.expressions import evaluate, friendly_date_format
from autoflow_engine.runtime.templates import referenced_variables, resolve
from autoflow_engine.values import Table

V = {
    "name": "Mona",
    "qty": "5",
    "price": 12.5,
    "row": {"Invoice No": "INV-7", "Total": "1,250.50"},
    "items": [1, 2, 3],
    "when": dt.date(2026, 1, 31),
    "table": Table(["a"], [{"a": 1}, {"a": 2}]),
}


@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ("name", "Mona"),
        ("qty + 1", 6),  # text that looks like a number adds as a number
        ('"Hi " + name', "Hi Mona"),
        ("price * 2", 25.0),
        ('row["Invoice No"]', "INV-7"),
        ('row["invoice no"]', "INV-7"),  # column names ignore case
        ("row.Total", "1,250.50"),
        ('NUMBER(row["Total"])', 1250.5),
        ("ROUND(2.345, 2)", 2.35),
        ("ROUND(2.5)", 3),
        ('UPPER(name) + "!"', "MONA!"),
        ('IF(price > 10, "High", "Low")', "High"),
        ("LEN(items)", 3),
        ("SUM(items)", 6),
        ("items[0]", 1),
        ("COUNT(table)", 2),
        ('FORMATDATE(when, "DD/MM/YYYY")', "31/01/2026"),
        ('DATEADD(when, 1, "month")', dt.date(2026, 2, 28)),
        ("DAYSBETWEEN(when, DATE(2026, 2, 10))", 10),
        ("qty > 3 and price < 20", True),
        ("not ISEMPTY(name)", True),
        ('CONTAINS(name, "ON")', True),
        ('MID("ABCDEF", 2, 3)', "BCD"),
        ("true", True),
        ('FORMATNUMBER(1250.5, 2)', "1,250.50"),
    ],
)
def test_evaluate(expr, expected):
    assert evaluate(expr, V) == expected


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os')",
        "name.__class__",
        "(lambda: 1)()",
        "[x for x in items]",
        "open('x')",
        "name.upper()",
    ],
)
def test_unsafe_expressions_are_rejected(expr):
    with pytest.raises(ExpressionError):
        evaluate(expr, V)


def test_friendly_errors():
    with pytest.raises(ExpressionError, match="no variable called 'nope'"):
        evaluate("nope", V)
    with pytest.raises(ExpressionError, match="no field or column called 'Missing'"):
        evaluate('row["Missing"]', V)
    with pytest.raises(ExpressionError, match="Division by zero"):
        evaluate("1 / 0", V)
    with pytest.raises(ExpressionError, match="typing mistake"):
        evaluate("UPPER(name", V)


def test_templates_keep_types_and_interpolate():
    assert resolve("{{table}}", V) is V["table"]
    assert resolve("Hello {{name}}, total {{price * 2}}", V) == "Hello Mona, total 25"
    assert resolve("{{name}} {{qty}}", V) == "Mona 5"  # two references, not one formula "name}} {{qty"
    assert resolve({"a": ["{{qty}}", 3]}, V) == {"a": ["5", 3]}
    assert resolve("no braces", V) == "no braces"


def test_referenced_variables_ignores_functions_and_aliases():
    assert referenced_variables('{{UPPER(name)}} {{row["x"]}} {{true}}') == {"name", "row"}


def test_date_format_tokens():
    assert friendly_date_format("YYYY-MM-DD HH:mm") == "%Y-%m-%d %H:%M"
    assert friendly_date_format("100%") == "100%%"


def test_conditions():
    cond = Condition.model_validate({
        "match": "all",
        "rules": [
            {"left": "{{price}}", "op": "greater", "right": "10"},
            {"left": "{{name}}", "op": "equals", "right": " mona "},
            {"left": '{{row["Invoice No"]}}', "op": "starts_with", "right": "inv"},
        ],
    })
    assert evaluate_condition(cond, V)
    any_cond = Condition.model_validate({"match": "any", "rules": [
        {"left": "{{qty}}", "op": "less", "right": 1},
        {"left": "{{items}}", "op": "contains", "right": "2"},
    ]})
    assert evaluate_condition(any_cond, V)
    assert not evaluate_condition(Condition(rules=[{"left": "{{name}}", "op": "is_empty"}]), V)
    assert evaluate_condition(Condition(expression="{{qty == 5}}"), V)
    with pytest.raises(ExpressionError, match="no rules"):
        evaluate_condition(Condition(), V)
