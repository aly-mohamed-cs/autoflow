"""Orchestrator steps (Brity's "Orchestration" library): company-wide shared values and work queues
kept on the Orchestrator. Robots ask their Orchestrator; Studio test runs ask the one it is
connected to (so queue steps in a test run work on the real queue)."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Literal

from ..catalog import BlockDef, OutputDef, Param, Params, activity
from ..errors import ActivityError, AutoflowError, BreakLoop, ContinueLoop, RunCancelled, StepFailed
from ..runtime.context import RunContext
from ..runtime.interpreter import BlockRunner
from ..values import to_jsonable, to_text

ORCH = "Orchestrator"
_CURRENT = "queue.current_item"


def _ask(ctx: RunContext, request: dict[str, Any]) -> dict[str, Any]:
    provider = ctx.options.orchestrator
    if provider is None:
        raise ActivityError(
            "The Orchestrator is not available for this run.",
            "To test this step in Studio, connect Studio to the Orchestrator under Settings.",
        )
    try:
        reply = provider(request)
    except (RunCancelled, ActivityError):
        raise
    except AutoflowError as exc:
        raise ActivityError(exc.message, exc.hint) from None
    except Exception as exc:
        raise ActivityError(f"The Orchestrator could not answer: {exc}") from None
    if not isinstance(reply, dict):
        raise ActivityError("The Orchestrator gave no answer.")
    return reply


# -- shared values ------------------------------------------------------------------------------


class SharedValueParams(Params):
    name: str = Param(title="Shared value", ui="asset", placeholder="Vendor portal address")


@activity(
    "assets.get",
    title="Get shared value",
    category=ORCH,
    icon="library",
    sentence="Get shared value {name}",
    description="Read a company-wide value or file kept in the Orchestrator (dashboard > Shared values), e.g. a "
    "portal address, a limit or a price list. A file is saved in the run's folder and the step gives its path.",
    params=SharedValueParams,
    outputs=[OutputDef("value", "Value", "any", default_variable="shared_value")],
)
def get_shared_value(ctx: RunContext, p: SharedValueParams) -> Any:
    name = p.name.strip()
    if not name:
        raise ActivityError("Choose a shared value.")
    reply = _ask(ctx, {"op": "asset.get", "name": name})
    if reply.get("kind") != "file":
        return reply.get("value")
    folder = ctx.file_path("shared values")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (Path(str(reply.get("fileName") or "file")).name or "file")
    path.write_bytes(base64.b64decode(str(reply.get("content") or "")))
    return str(path)


# -- work queues --------------------------------------------------------------------------------


class QueueParams(Params):
    queue: str = Param(title="Queue", ui="queue", placeholder="Invoices to enter")


def _queue_name(p: QueueParams) -> str:
    name = p.queue.strip()
    if not name:
        raise ActivityError("Choose a queue.")
    return name


class AddItemParams(QueueParams):
    values: dict[str, Any] = Param(
        default_factory=dict, title="Values", ui="key_values",
        description="The item's data, e.g. Invoice = {{row[\"Invoice\"]}}.",
    )
    row: Any = Param(
        None, title="Or a whole row", ui="variable",
        description="e.g. the current row of a For each loop: each column becomes a value of the item.",
    )
    reference: str = Param(
        "", title="Reference", placeholder="{{row[\"Invoice\"]}}",
        description="A short name people see in the dashboard, e.g. the invoice number.",
    )
    priority: int = Param(0, title="Priority", ge=-100, le=100, advanced=True,
                          description="Items with higher numbers are worked on first.")


@activity(
    "queue.add",
    title="Add queue item",
    category=ORCH,
    icon="list-plus",
    sentence="Add an item to queue {queue}",
    description="Put work into a queue in the Orchestrator, e.g. one item per invoice. If the queue has an "
    "automation, robots start working on the item straight away.",
    params=AddItemParams,
    outputs=[OutputDef("item_id", "Item number", "text")],
)
def add_item(ctx: RunContext, p: AddItemParams) -> str:
    data: dict[str, Any] = {}
    if p.row is not None:
        row = to_jsonable(p.row)
        if not isinstance(row, dict):
            raise ActivityError("'Or a whole row' must be a row (e.g. the current row of a For each loop).")
        data.update(row)
    data.update({str(k): to_jsonable(v) for k, v in p.values.items() if str(k).strip()})
    if not data:
        raise ActivityError("Give the item some values, or a whole row.")
    reply = _ask(ctx, {"op": "queue.add", "queue": _queue_name(p), "reference": to_text(p.reference)[:200],
                       "data": data, "priority": p.priority})
    return str(reply.get("id") or "")


def _take(ctx: RunContext, queue: str) -> dict[str, Any] | None:
    item = _ask(ctx, {"op": "queue.next", "queue": queue}).get("item")
    if not isinstance(item, dict):
        return None
    ctx.resources[_CURRENT] = str(item["id"])
    return item


def _finish(ctx: RunContext, item_id: str, outcome: str, message: str = "", result: Any = None) -> None:
    request: dict[str, Any] = {"op": "queue.finish", "item": item_id, "outcome": outcome, "message": message[:2000]}
    if result is not None:
        request["result"] = to_jsonable(result)
    _ask(ctx, request)
    if ctx.resources.get(_CURRENT) == item_id:
        ctx.resources.pop(_CURRENT, None)


@activity(
    "queue.next",
    title="Get next queue item",
    category=ORCH,
    icon="list-start",
    sentence="Get the next item of queue {queue}",
    description="Take the next waiting item of a queue to work on it. Finish it afterwards with "
    "'Finish queue item' - or use 'For each queue item', which does both.",
    params=QueueParams,
    outputs=[
        OutputDef("item", "Item", "any", default_variable="queue_item"),
        OutputDef("found", "Got an item", "boolean", default_variable="queue_item_found"),
        OutputDef("reference", "Reference", "text"),
        OutputDef("item_id", "Item number", "text"),
    ],
)
def next_item(ctx: RunContext, p: QueueParams) -> dict[str, Any]:
    item = _take(ctx, _queue_name(p))
    if item is None:
        ctx.log(f"The queue '{p.queue}' has no waiting items.")
        return {"item": {}, "found": False, "reference": "", "item_id": ""}
    return {"item": item.get("data") or {}, "found": True, "reference": item.get("reference") or "",
            "item_id": str(item["id"])}


class FinishParams(Params):
    outcome: Literal["done", "retry", "failed"] = Param(
        "done", title="Result",
        labels={"done": "Done", "retry": "Failed - try it again later", "failed": "Failed - don't try again"},
    )
    message: str = Param("", title="Reason", show_when={"outcome": ["retry", "failed"]},
                         placeholder="The vendor number does not exist")
    result: dict[str, Any] = Param(
        default_factory=dict, title="Result values", ui="key_values", show_when={"outcome": ["done"]},
        description="Optional values kept with the item, e.g. Reference = {{reference_no}}.",
    )
    item_id: str = Param(
        "", title="Item number", advanced=True,
        description="Leave empty for the item taken last with 'Get next queue item'.",
    )


@activity(
    "queue.finish",
    title="Finish queue item",
    category=ORCH,
    icon="list-checks",
    sentence="Mark the queue item as {outcome}",
    description="Tell the Orchestrator how working on a queue item went. Items marked 'try it again later' "
    "go back to the queue while the queue's retries last.",
    params=FinishParams,
)
def finish_item(ctx: RunContext, p: FinishParams) -> None:
    item_id = p.item_id.strip() or ctx.resources.get(_CURRENT)
    if not item_id:
        raise ActivityError("There is no queue item to finish.", "Use 'Get next queue item' before this step.")
    _finish(ctx, str(item_id), p.outcome, to_text(p.message), p.result or None)


class CountParams(QueueParams):
    status: Literal["new", "in_progress", "done", "failed", "all"] = Param(
        "new", title="Count",
        labels={"new": "Waiting items", "in_progress": "Items being worked on", "done": "Done items",
                "failed": "Failed items", "all": "All items"},
    )


@activity(
    "queue.count",
    title="Count queue items",
    category=ORCH,
    icon="list-ordered",
    sentence="Count {status} in queue {queue}",
    description="How many items of a queue are waiting, being worked on, done or failed.",
    params=CountParams,
    outputs=[OutputDef("count", "Number of items", "number", default_variable="queue_count")],
)
def count_items(ctx: RunContext, p: CountParams) -> int:
    return int(_ask(ctx, {"op": "queue.count", "queue": _queue_name(p), "status": p.status}).get("count") or 0)


class ForEachItemParams(QueueParams):
    item_variable: str = Param("queue_item", title="Name of current item", ui="variable_name")
    on_failure: Literal["retry", "failed", "stop"] = Param(
        "retry", title="If an item fails",
        labels={"retry": "Try it again later, go on with the next", "failed": "Mark it failed, go on with the next",
                "stop": "Mark it failed and stop"},
    )
    max_items: int = Param(0, title="At most", ge=0, advanced=True,
                           description="Stop after this many items; 0 works until the queue is empty.")
    reference_variable: str = Param("queue_item_reference", title="Name of reference", ui="variable_name",
                                    advanced=True)


@activity(
    "queue.for_each",
    title="For each queue item",
    category=ORCH,
    icon="list-video",
    sentence="For each item of queue {queue}",
    description="Work through a queue: take the next waiting item, run the steps inside, and mark it done - or, "
    "when a step fails, mark it failed (or to try again) and go on with the next item.",
    params=ForEachItemParams,
    blocks=[BlockDef("body", "Do")],
)
def for_each_item(ctx: RunContext, p: ForEachItemParams, blocks: BlockRunner) -> None:
    queue = _queue_name(p)
    done = 0
    while not p.max_items or done < p.max_items:
        item = _take(ctx, queue)
        if item is None:
            break
        item_id = str(item["id"])
        done += 1
        ctx.set(p.item_variable, item.get("data") or {})
        if p.reference_variable:
            ctx.set(p.reference_variable, item.get("reference") or "")
        try:
            blocks.run("body")
        except BreakLoop:
            _finish(ctx, item_id, "done")
            break
        except ContinueLoop:
            pass
        except StepFailed as failed:
            ctx.log(f"Queue item {item.get('reference') or item_id} failed: {failed.error.message}", "warning")
            _finish(ctx, item_id, "retry" if p.on_failure == "retry" else "failed", failed.error.message)
            if p.on_failure == "stop":
                raise
            continue
        # Cancelled or stopped runs leave the item unfinished: the Orchestrator gives it back to the queue.
        _finish(ctx, item_id, "done")
    ctx.log(f"Worked on {done} item(s) of the queue '{queue}'.")

