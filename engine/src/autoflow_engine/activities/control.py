"""Decisions, loops, waits, errors and other flow control."""

from __future__ import annotations

from typing import Any, Literal

from ..catalog import BlockDef, NoParams, OutputDef, Param, Params, activity
from ..errors import ActivityError, BreakLoop, ContinueLoop, StepFailed, StopFlow
from ..runtime.conditions import Condition, evaluate_condition
from ..runtime.context import RunContext
from ..runtime.expressions import to_number
from ..runtime.interpreter import BlockRunner
from ..values import Table, to_text, type_name

C = "Control"


# -- Notes & logging ---------------------------------------------------------


class CommentParams(Params):
    text: str = Param("", title="Note", ui="multiline", placeholder="Explain what the next steps do")


@activity(
    "control.comment",
    title="Note",
    category=C,
    icon="sticky-note",
    sentence="Note: {text}",
    description="A note for people reading the flow. It does nothing when the flow runs.",
    params=CommentParams,
)
def comment(ctx: RunContext, p: CommentParams) -> None:
    return None


class LogParams(Params):
    message: str = Param(title="Message", ui="multiline", placeholder="Processed invoice {{invoice_no}}")
    level: Literal["info", "warning", "error"] = Param("info", title="Level")


@activity(
    "control.log",
    title="Write to log",
    category=C,
    icon="scroll-text",
    sentence="Log {message}",
    description="Add a message to the run log. Useful to track progress.",
    params=LogParams,
)
def write_log(ctx: RunContext, p: LogParams) -> None:
    ctx.log(to_text(p.message), p.level)


class SetVariableParams(Params):
    variable: str = Param(title="Variable", ui="variable_name")
    value: Any = Param(None, title="New value", placeholder="Type a value or insert a variable")


@activity(
    "control.set_variable",
    title="Set variable",
    category=C,
    icon="variable",
    sentence="Set {variable} to {value}",
    description="Store a value in a variable so later steps can use it.",
    params=SetVariableParams,
)
def set_variable(ctx: RunContext, p: SetVariableParams) -> None:
    ctx.set(p.variable, p.value)


class IncreaseParams(Params):
    variable: str = Param(title="Variable", ui="variable_name")
    by: float = Param(1, title="Increase by")


@activity(
    "control.increase",
    title="Increase number",
    category=C,
    icon="plus",
    sentence="Increase {variable} by {by}",
    description="Add to a number variable, e.g. to count processed items.",
    params=IncreaseParams,
)
def increase(ctx: RunContext, p: IncreaseParams) -> None:
    current = ctx.get(p.variable)
    total = to_number(current) + p.by
    ctx.set(p.variable, int(total) if float(total).is_integer() else total)


class AddToListParams(Params):
    variable: str = Param(title="List variable", ui="variable_name")
    value: Any = Param(None, title="Item to add")


@activity(
    "control.add_to_list",
    title="Add item to list",
    category=C,
    icon="list-plus",
    sentence="Add {value} to {variable}",
    params=AddToListParams,
)
def add_to_list(ctx: RunContext, p: AddToListParams) -> None:
    current = ctx.get(p.variable)
    items = list(current) if isinstance(current, list | tuple) else ([] if current in (None, "") else [current])
    items.append(p.value)
    ctx.set(p.variable, items)


# -- Decisions ---------------------------------------------------------------


class IfParams(Params):
    condition: Condition = Param(title="If")


@activity(
    "control.if",
    title="If / Otherwise",
    category=C,
    icon="split",
    sentence="If {condition}",
    description="Run some steps only when a condition is true, and others when it is not.",
    params=IfParams,
    blocks=[BlockDef("then", "Then"), BlockDef("else", "Otherwise")],
)
def if_else(ctx: RunContext, p: IfParams, blocks: BlockRunner) -> None:
    if evaluate_condition(p.condition, ctx.variables):
        blocks.run("then")
    else:
        blocks.run("else")


# -- Loops -------------------------------------------------------------------


class ForEachParams(Params):
    items: Any = Param(title="For each item in", ui="variable", placeholder="A table, list or text")
    item_variable: str = Param("item", title="Name of current item", ui="variable_name")
    index_variable: str = Param(
        "", title="Name of position counter", ui="variable_name", advanced=True,
        description="Starts at 1. Leave empty if not needed.",
    )


def _iterable(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, Table):
        return list(value.rows)
    if isinstance(value, list | tuple | set):
        return list(value)
    if isinstance(value, dict):
        return [{"key": k, "value": v} for k, v in value.items()]
    if isinstance(value, str):
        return [line for line in value.splitlines() if line.strip()]
    if isinstance(value, int | float):
        raise ActivityError(
            f"Cannot loop over the number {value}.", "Use 'Repeat' to repeat steps a number of times."
        )
    raise ActivityError(f"Cannot loop over a {type_name(value)} value.")


def _loop_body(blocks: BlockRunner) -> bool:
    """Run the loop body once. Returns False when the loop should stop."""
    try:
        blocks.run("body")
    except BreakLoop:
        return False
    except ContinueLoop:
        pass
    return True


@activity(
    "control.for_each",
    title="For each",
    category=C,
    icon="repeat",
    sentence="For each {item_variable} in {items}",
    description="Repeat steps for every row of a table, item of a list or line of text.",
    params=ForEachParams,
    blocks=[BlockDef("body", "Do")],
)
def for_each(ctx: RunContext, p: ForEachParams, blocks: BlockRunner) -> None:
    for index, item in enumerate(_iterable(p.items), start=1):
        ctx.set(p.item_variable, item)
        if p.index_variable:
            ctx.set(p.index_variable, index)
        if not _loop_body(blocks):
            break


class RepeatParams(Params):
    times: int = Param(title="Times", ge=0, le=1_000_000)
    counter_variable: str = Param("counter", title="Name of counter", ui="variable_name", advanced=True)


@activity(
    "control.repeat",
    title="Repeat",
    category=C,
    icon="rotate-cw",
    sentence="Repeat {times} times",
    params=RepeatParams,
    blocks=[BlockDef("body", "Do")],
)
def repeat(ctx: RunContext, p: RepeatParams, blocks: BlockRunner) -> None:
    for counter in range(1, p.times + 1):
        if p.counter_variable:
            ctx.set(p.counter_variable, counter)
        if not _loop_body(blocks):
            break


class WhileParams(Params):
    condition: Condition = Param(title="While")
    max_iterations: int = Param(
        10_000, title="Safety limit", ge=1, advanced=True,
        description="Stop with an error after this many rounds, so a mistake can't loop forever.",
    )


@activity(
    "control.while",
    title="Repeat while",
    category=C,
    icon="refresh-cw",
    sentence="Repeat while {condition}",
    description="Repeat steps as long as a condition stays true.",
    params=WhileParams,
    blocks=[BlockDef("body", "Do")],
)
def while_loop(ctx: RunContext, p: WhileParams, blocks: BlockRunner) -> None:
    rounds = 0
    while evaluate_condition(p.condition, ctx.variables):
        rounds += 1
        if rounds > p.max_iterations:
            raise ActivityError(
                f"The loop ran more than {p.max_iterations} times and was stopped.",
                "Check that the condition eventually becomes false, or raise the safety limit.",
            )
        if not _loop_body(blocks):
            break


@activity(
    "control.break",
    title="Exit loop",
    category=C,
    icon="log-out",
    sentence="Exit loop",
    description="Stop the loop this step is in and continue after it.",
)
def break_loop(ctx: RunContext, p: NoParams) -> None:
    raise BreakLoop()


@activity(
    "control.continue",
    title="Next item",
    category=C,
    icon="skip-forward",
    sentence="Skip to next item",
    description="Skip the remaining steps of this loop round and go to the next item.",
)
def continue_loop(ctx: RunContext, p: NoParams) -> None:
    raise ContinueLoop()


# -- Errors ------------------------------------------------------------------


class TryParams(Params):
    error_variable: str = Param("error", title="Save error message as", ui="variable_name", advanced=True)


@activity(
    "control.try",
    title="Try / If it fails",
    category=C,
    icon="shield",
    sentence="Try",
    description="Run steps and, if one fails, run other steps instead of stopping the flow.",
    params=TryParams,
    blocks=[BlockDef("try", "Try"), BlockDef("catch", "If it fails"), BlockDef("finally", "Always")],
)
def try_catch(ctx: RunContext, p: TryParams, blocks: BlockRunner) -> None:
    try:
        blocks.run("try")
    except StepFailed as failed:
        if p.error_variable:
            ctx.set(p.error_variable, failed.error.message)
        ctx.log(f"Handled error: {failed.error.message}", "warning")
        blocks.run("catch")
    finally:
        blocks.run("finally")


class FailParams(Params):
    message: str = Param(title="Error message", placeholder="Invoice {{invoice_no}} has no total")


@activity(
    "control.fail",
    title="Raise error",
    category=C,
    icon="octagon-alert",
    sentence="Raise error {message}",
    description="Fail on purpose with your own message (caught by 'Try / If it fails').",
    params=FailParams,
)
def fail(ctx: RunContext, p: FailParams) -> None:
    raise ActivityError(to_text(p.message))


class StopParams(Params):
    outcome: Literal["succeeded", "failed"] = Param("succeeded", title="Finish as")
    message: str = Param("", title="Message")


@activity(
    "control.stop",
    title="Stop flow",
    category=C,
    icon="square",
    sentence="Stop flow as {outcome}",
    description="End the flow immediately.",
    params=StopParams,
)
def stop(ctx: RunContext, p: StopParams) -> None:
    raise StopFlow(p.outcome == "succeeded", to_text(p.message))


# -- Waiting -----------------------------------------------------------------


class WaitParams(Params):
    seconds: float = Param(title="Seconds", ge=0, le=86_400, ui="duration")


@activity(
    "control.wait",
    title="Wait",
    category=C,
    icon="timer",
    sentence="Wait {seconds} seconds",
    description="Pause for a fixed time. Prefer 'Wait for element' when waiting for a screen.",
    params=WaitParams,
)
def wait(ctx: RunContext, p: WaitParams) -> None:
    ctx.sleep(p.seconds)


class GetCredentialParams(Params):
    credential: str = Param(title="Credential", ui="credential")


@activity(
    "control.get_credential",
    title="Get credential",
    category=C,
    icon="key-round",
    sentence="Get credential {credential}",
    description="Load a saved username and password. The password is never shown in logs.",
    params=GetCredentialParams,
    outputs=[OutputDef("credential", "Credential", "credential", default_variable="login")],
)
def get_credential(ctx: RunContext, p: GetCredentialParams) -> Any:
    return ctx.credential(p.credential)
