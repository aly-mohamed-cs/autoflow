"""Runs a flow: walks the step tree, resolves settings, calls activities.

Error model
-----------
* An activity failure is retried ``on_error.retries`` times. Then the step either
  continues (``action="continue"``) or raises :class:`StepFailed`.
* ``StepFailed`` bubbles up through parent blocks without triggering *their*
  retries, until a Try block catches it or the run ends as failed.
* Loop/flow signals (break, continue, stop) are never treated as failures.
* With AI self-repair on, a step that still fails after its retries gets up to
  ``repair_attempts`` fixes from the AI assistant, each retried in place (see repair.py).
"""

from __future__ import annotations

import json
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any

from .. import catalog
from ..catalog import ActivityDef
from ..errors import (
    ActivityError,
    AutoflowError,
    BreakLoop,
    ContinueLoop,
    FlowControl,
    RunCancelled,
    StepFailed,
    StopFlow,
    friendly,
)
from ..flow import Flow, Step, Variable
from ..values import Table, to_jsonable, to_text
from . import repair
from .context import Emit, RunContext, RunControl, RunOptions, log, set_active_control
from .expressions import to_date, to_number, truthy
from .templates import resolve

MAX_PROCESS_DEPTH = 20


@dataclass
class RunResult:
    run_id: str
    status: str  # succeeded | failed | cancelled
    duration_ms: int
    outputs: dict[str, Any] = field(default_factory=dict)
    error: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "outputs": to_jsonable(self.outputs),
            "error": self.error,
        }


class BlockRunner:
    """Lets control activities run their nested step lists."""

    def __init__(self, runner: FlowRunner, step: Step):
        self._runner = runner
        self._step = step

    def has(self, name: str) -> bool:
        return bool(self._step.blocks.get(name))

    def run(self, name: str) -> None:
        self._runner.run_steps(self._step.blocks.get(name, []))

    def run_process(self, process_id: str, inputs: dict[str, Any]) -> None:
        self._runner.run_process(process_id, inputs)


class FlowRunner:
    def __init__(
        self,
        flow: Flow,
        options: RunOptions,
        emit: Emit,
        control: RunControl | None = None,
        run_id: str | None = None,
    ):
        catalog.load_activities()
        self.flow = flow
        self.run_id = run_id or uuid.uuid4().hex
        self.control = control or RunControl(options.breakpoints, options.step_mode)
        self.ctx = RunContext(flow, options, emit, self.control)
        self._repair_calls = 0
        self._repair_given_up: set[str] = set()
        self._process_depth = 0

    # ------------------------------------------------------------------
    def run(self) -> RunResult:
        ctx = self.ctx
        started = time.monotonic()
        ctx.emit("run_started", run_id=self.run_id, flow_id=self.flow.id, flow_name=self.flow.name)
        status, error = "succeeded", None
        set_active_control(self.control)  # lets waits inside steps be stopped and paused
        try:
            self._init_variables()
            self.run_steps(self.flow.steps)
        except StopFlow as stop:
            if not stop.succeeded:
                status = "failed"
                error = {"message": stop.message or "The flow was stopped as failed.", "hint": None}
            elif stop.message:
                ctx.log(stop.message)
        except StepFailed as failed:
            status = "failed"
            error = {
                "message": failed.error.message,
                "hint": failed.error.hint,
                "step_id": failed.step_id,
                "activity": failed.activity,
            }
        except (BreakLoop, ContinueLoop):
            pass  # "Exit loop" used outside a loop simply ends the flow normally
        except RunCancelled:
            status = "cancelled"
        except AutoflowError as exc:
            status, error = "failed", {"message": exc.message, "hint": exc.hint}
        except Exception as exc:  # engine bug: report it rather than crash the host
            log.exception("unexpected engine error")
            status = "failed"
            error = {
                "message": f"Unexpected error: {exc}",
                "hint": "This looks like a bug in Autoflow. Please send the run log to the administrator.",
                "details": traceback.format_exc(limit=8),
            }
        finally:
            set_active_control(None)
            ctx.current_step_id = None
            ctx.cleanup()
        outputs = {v.name: ctx.get(v.name) for v in self.flow.variables if v.is_output}
        result = RunResult(
            run_id=self.run_id,
            status=status,
            duration_ms=int((time.monotonic() - started) * 1000),
            outputs=outputs,
            error=error,
        )
        ctx.emit("run_finished", **result.to_json())
        return result

    def _init_variables(self) -> None:
        inputs = self.ctx.options.inputs
        declared = {v.name for v in self.flow.variables}
        for name in inputs:
            if name not in declared:
                self.ctx.log(f"Input '{name}' is not a variable of this flow and was ignored.", "warning")
        for var in self.flow.variables:
            value = inputs[var.name] if var.is_input and var.name in inputs else var.default
            self.ctx.set(var.name, coerce_variable(var, value))

    # ------------------------------------------------------------------
    def run_steps(self, steps: list[Step]) -> None:
        for step in steps:
            self.run_step(step)

    def run_process(self, process_id: str, inputs: dict[str, Any]) -> None:
        """Run a sub-process: its inputs become variables, then its steps run."""
        ctx = self.ctx
        process = self.flow.process(process_id)
        if process is None:
            raise ActivityError("The sub-process to run no longer exists.",
                                "Choose a sub-process in this step's settings.")
        if self._process_depth >= MAX_PROCESS_DEPTH:
            raise ActivityError(
                f"Sub-processes started each other {MAX_PROCESS_DEPTH} levels deep while running '{process.name}'.",
                "A sub-process probably runs itself. Check its 'Run sub-process' steps.",
            )
        known = {i.name for i in process.inputs}
        for name in inputs:
            if name not in known:
                ctx.log(f"'{process.name}' has no input called '{name}'; it was ignored.", "warning")
        for spec in process.inputs:
            given = inputs.get(spec.name)
            value = spec.default if given is None or given == "" else given
            variable = Variable(name=spec.name, type=spec.type)
            ctx.set(spec.name, coerce_variable(variable, value))
        ctx.log(f"Running sub-process '{process.name}'")
        self._process_depth += 1
        try:
            self.run_steps(process.steps)
        except (BreakLoop, ContinueLoop):
            pass  # "Exit loop" outside a loop ends the sub-process, not the caller's loop
        finally:
            self._process_depth -= 1

    def run_step(self, step: Step) -> None:
        if step.disabled:
            return
        ctx = self.ctx
        ctx.control.checkpoint(
            step.id,
            on_pause=lambda reason: ctx.emit("paused", step_id=step.id, reason=reason),
            on_resume=lambda: ctx.emit("resumed", step_id=step.id),
        )
        parent_step = ctx.current_step_id
        ctx.current_step_id = step.id
        started = time.monotonic()
        ctx.emit("step_started", activity=step.activity, label=step.label)
        finish: dict[str, Any] = {"status": "ok"}
        try:
            finish = self._run_with_retries(step)
        except StepFailed as failed:
            finish = {"status": "failed"}
            if failed.step_id == step.id:
                finish["error"] = {"message": failed.error.message, "hint": failed.error.hint}
            raise
        except RunCancelled:
            finish = {"status": "cancelled"}
            raise
        except FlowControl:
            raise
        finally:
            ctx.current_step_id = step.id
            ctx.emit("step_finished", duration_ms=int((time.monotonic() - started) * 1000), **finish)
            ctx.current_step_id = parent_step

    def _run_with_retries(self, step: Step) -> dict[str, Any]:
        ctx = self.ctx
        adef = catalog.get(step.activity)
        attempts = step.on_error.retries + 1
        for attempt in range(1, attempts + 1):
            try:
                if adef is None:
                    raise ActivityError(
                        f"Unknown step type '{step.activity}'.",
                        "This flow may have been made with a newer version of Autoflow.",
                    )
                result = self._execute(step, adef)
                self._store_outputs(step, adef, result)
                runs_steps = bool(adef.blocks) or adef.uses_runner
                if self.flow.settings.screenshot_each_step and not runs_steps:
                    self._capture_screenshot("step")
                if self.flow.settings.step_delay and not runs_steps:
                    ctx.sleep(self.flow.settings.step_delay)  # Brity "SetPlayOption": slow the run down
                return {"status": "ok"}
            except (StepFailed, FlowControl, RunCancelled):
                raise
            except Exception as exc:
                if ctx.control.cancelled:
                    raise RunCancelled() from exc
                err = friendly(exc)
                if attempt < attempts:
                    delay = step.on_error.retry_delay
                    ctx.log(f"Attempt {attempt} of {attempts} failed: {err.message} Retrying in {delay:g}s.", "warning")
                    ctx.sleep(delay)
                    continue
                if self._repair(step, adef, err):
                    return {"status": "ok", "repaired": True}
                if self.flow.settings.screenshot_on_error:
                    self._capture_screenshot("error")
                if step.on_error.action == "continue":
                    ctx.log(f"Step failed but the flow continues: {err.message}", "warning")
                    return {"status": "failed", "continued": True,
                            "error": {"message": err.message, "hint": err.hint}}
                raise StepFailed(step.id, step.activity, err) from exc
        raise AssertionError("unreachable")

    def _repair(self, step: Step, adef: ActivityDef | None, error: AutoflowError) -> bool:
        """Ask the AI assistant for new settings and retry the step; True once it works."""
        ctx = self.ctx
        provider = ctx.options.repair
        if provider is None or adef is None or not repair.can_repair(adef, step) or step.id in self._repair_given_up:
            return False
        tries = ctx.options.repair_attempts
        history: list[dict[str, Any]] = []
        for attempt in range(1, tries + 1):
            if self._repair_calls >= repair.MAX_CALLS_PER_RUN:
                ctx.log("The AI assistant already tried to fix several steps in this run; not asking again.", "warning")
                break
            self._repair_calls += 1
            ctx.emit("repair_started", attempt=attempt, of=tries)
            ctx.log(f"Asking the AI assistant how to fix this step (attempt {attempt} of {tries})...")
            try:
                request = repair.describe_failure(ctx, step, adef, error, history)
                reply = provider(request)
            except RunCancelled:
                raise
            except Exception as exc:
                reason = friendly(exc).message
                ctx.log(f"The AI assistant could not help: {reason}", "warning")
                ctx.emit("repair_failed", attempt=attempt, reason=reason)
                break
            fix = repair.parse_fix(step, adef, reply)
            if fix is None:
                reason = str((reply or {}).get("explanation") or "It found no change that could fix this step.")
                ctx.log(f"The AI assistant has no fix: {reason}", "warning")
                ctx.emit("repair_failed", attempt=attempt, reason=reason)
                break
            trial = repair.try_fix(ctx, step, adef, fix, request.get("screen"))
            ctx.emit("repair_trying", attempt=attempt, explanation=fix.explanation, patch=trial.patch)
            ctx.log(f"AI fix: {fix.explanation} Trying the step again.", "warning")
            try:
                result = self._execute(trial.step, adef)
                self._store_outputs(trial.step, adef, result)
            except (StepFailed, FlowControl, RunCancelled):
                trial.revert()
                raise
            except Exception as exc:
                trial.revert()
                if ctx.control.cancelled:
                    raise RunCancelled() from exc
                error = friendly(exc)
                history.append({"explanation": fix.explanation, "changes": trial.patch, "error": error.message})
                ctx.log(f"The fix did not work: {error.message}", "warning")
                continue
            trial.commit()
            ctx.emit("step_repaired", attempt=attempt, explanation=fix.explanation, patch=trial.patch)
            ctx.log("The AI fix worked. A person should review it before it is kept.", "warning")
            return True
        self._repair_given_up.add(step.id)
        return False

    def _execute(self, step: Step, adef: ActivityDef) -> Any:
        variables = self.ctx.variables
        resolved: dict[str, Any] = {}
        for key, value in step.params.items():
            if key in adef.lazy_fields:
                resolved[key] = value
                continue
            value = resolve(value, variables)
            if key in adef.text_fields and value is not None and not isinstance(value, str):
                value = to_text(value)  # e.g. a number read from Excel typed into a text box
            resolved[key] = value
        params = adef.params.model_validate(resolved)
        if adef.blocks or adef.uses_runner:
            return adef.func(self.ctx, params, BlockRunner(self, step))
        return adef.func(self.ctx, params)

    def _store_outputs(self, step: Step, adef: ActivityDef, result: Any) -> None:
        if not adef.outputs:
            return
        if len(adef.outputs) == 1:
            values = {adef.outputs[0].name: result}
        elif isinstance(result, dict):
            values = result
        else:
            return
        for out in adef.outputs:
            variable = step.outputs.get(out.name)
            if variable and out.name in values:
                self.ctx.set(variable, values[out.name])

    def _capture_screenshot(self, reason: str) -> None:
        capture = self.ctx.resources.get("screenshot")
        if capture is None:
            return
        try:
            path = self.ctx.file_path(f"{self.ctx.current_step_id}-{reason}-{int(time.time() * 1000)}.png")
            if capture(path):
                self.ctx.emit("screenshot", path=str(path), reason=reason)
        except Exception as exc:
            log.warning("screenshot failed: %s", exc)


def coerce_variable(var: Variable, value: Any) -> Any:
    """Convert a start value (often text from a form or webhook) to the variable's type."""
    if value is None:
        return Table() if var.type == "table" else ([] if var.type == "list" else None)
    try:
        match var.type:
            case "text" | "file" | "credential":
                return to_text(value)
            case "number":
                return to_number(value)
            case "boolean":
                return truthy(value)
            case "date":
                return to_date(value)
            case "list":
                if isinstance(value, str):
                    text = value.strip()
                    if text.startswith("["):
                        return list(json.loads(text))
                    return [p.strip() for p in text.split(",") if p.strip()]
                return list(value)
            case "table":
                if isinstance(value, Table):
                    return value
                if isinstance(value, str):
                    value = json.loads(value)
                if isinstance(value, dict) and "columns" in value:
                    return Table(value["columns"], value.get("rows", []))
                return Table(rows=list(value))
    except (AutoflowError, ValueError, TypeError) as exc:
        raise AutoflowError(
            f"The value given for '{var.name}' is not a valid {var.type}: {exc}",
            "Check the start values of the flow.",
        ) from None
    return value
