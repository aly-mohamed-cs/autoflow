"""Conditions stored in odd shapes (AI drafts, a Studio 0.3.0 bug) still run as intended."""

from __future__ import annotations

from conftest import step

from autoflow_engine.runtime.conditions import Condition, as_expression, normalize_condition

SPLIT = "{{row['inputFileExists']}}"


def split(text: str) -> dict:
    return {str(i): ch for i, ch in enumerate(text)}


def test_text_becomes_a_formula():
    assert Condition.model_validate("{{amount > 5}}").expression == "{{amount > 5}}"
    assert as_expression('{{row["Amount"]}} > 100') == '{{row["Amount"] > 100}}'
    assert as_expression("{{a}} and {{b}}") == "{{a and b}}"
    assert normalize_condition("  ") == {}


def test_split_text_is_repaired():
    rules = [{"left": "{{inputFileExists}}", "op": "equals", "right": "Yes"}]
    fixed = Condition.model_validate({**split(SPLIT), "rules": rules})  # the rule the person added wins
    assert fixed.expression is None and fixed.rules[0].right == "Yes"
    assert Condition.model_validate(split(SPLIT)).expression == SPLIT  # no rules: the text is the condition


def test_if_step_with_a_damaged_condition_runs(h):
    """The exact shape Studio 0.3.0 saved for a user's If step."""
    rules = [{"left": "{{inputFileExists}}", "op": "equals", "right": "Yes"}]
    result = h.run([
        step("control.set_variable", {"variable": "inputFileExists", "value": "Yes"}),
        step("control.if", {"condition": {**split(SPLIT), "rules": rules}}, blocks={
            "then": [step("control.log", {"message": "file is there"})],
            "else": [step("control.log", {"message": "no file"})],
        }),
    ])
    assert result.status == "succeeded", result.error
    assert "file is there" in h.logs()


def test_mixed_text_condition_is_not_always_true(h):
    result = h.run([
        step("control.set_variable", {"variable": "amount", "value": 50}),
        step("control.if", {"condition": "{{amount}} > 100"}, blocks={
            "then": [step("control.log", {"message": "big"})],
            "else": [step("control.log", {"message": "small"})],
        }),
    ])
    assert result.status == "succeeded", result.error
    assert "small" in h.logs() and "big" not in h.logs()
