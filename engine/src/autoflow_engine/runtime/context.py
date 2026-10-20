"""State shared by every step while a flow runs."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ActivityError, RunCancelled
from ..flow import Element, Flow
from ..values import MASK, Credential, Secret, to_jsonable

log = logging.getLogger("autoflow.engine")

Emit = Callable[[dict[str, Any]], None]
CredentialProvider = Callable[[str], Credential]


class RunControl:
    """Pause / resume / step / stop requests coming from Studio or the robot.

    Stop takes effect at once, also while a step is waiting (for a window, an element, a
    file...): waits go through sleep(), which ends early. A pause asked for while a step is
    waiting also happens right there; the time spent paused doesn't count against the step's
    time limit (see Deadline).
    """

    def __init__(self, breakpoints: set[str] | None = None, step_mode: bool = False):
        self._cond = threading.Condition()
        self._cancelled = False
        self._paused = False
        # Set by step(): let the current step run, then pause before the next one.
        self._pause_before_next = step_mode
        # Set by pause(): pause as soon as possible (before the next step, or inside a wait).
        self._pause_now = False
        self._paused_total = 0.0
        # How the step running now reports pausing and resuming (set at its checkpoint).
        self._on_pause: Callable[[str], None] | None = None
        self._on_resume: Callable[[], None] | None = None
        self.breakpoints: set[str] = set(breakpoints or ())

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def paused_seconds(self) -> float:
        """Total time spent paused so far (time limits skip it)."""
        return self._paused_total

    def cancel(self) -> None:
        with self._cond:
            self._cancelled = True
            self._cond.notify_all()

    def pause(self) -> None:
        """Pause as soon as possible: before the next step, or inside the current step's wait."""
        with self._cond:
            self._pause_now = True
            self._cond.notify_all()

    def resume(self) -> None:
        with self._cond:
            self._paused = False
            self._pause_before_next = False
            self._pause_now = False
            self._cond.notify_all()

    def step(self) -> None:
        """Run exactly one more step, then pause again."""
        with self._cond:
            self._paused = False
            self._pause_now = False
            self._pause_before_next = True
            self._cond.notify_all()

    def set_breakpoints(self, step_ids: set[str]) -> None:
        with self._cond:
            self.breakpoints = set(step_ids)

    def checkpoint(self, step_id: str, on_pause: Callable[[str], None],
                   on_resume: Callable[[], None] | None = None) -> None:
        """Called before every step. Blocks while paused; raises when cancelled."""
        with self._cond:
            self._on_pause, self._on_resume = on_pause, on_resume
            if self._cancelled:
                raise RunCancelled()
            reason = None
            if step_id in self.breakpoints:
                reason = "breakpoint"
            elif self._pause_before_next or self._pause_now:
                reason = "paused"
            if reason is None:
                return
            self._hold(reason, notify_resume=False)  # the step_started that follows says it goes on

    def sleep(self, seconds: float) -> None:
        """A wait inside a step: ends early when the run is stopped, and pauses here if asked to."""
        deadline = time.monotonic() + seconds
        with self._cond:
            while True:
                if self._cancelled:
                    raise RunCancelled()
                if self._pause_now and self._on_pause is not None:
                    deadline += self._hold("paused", notify_resume=True)
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._cond.wait(min(remaining, 0.25))

    def _hold(self, reason: str, notify_resume: bool) -> float:
        """Stay paused until resumed (call with the lock held). Returns how long it was paused."""
        self._pause_before_next = self._pause_now = False
        self._paused = True
        if self._on_pause is not None:
            self._on_pause(reason)
        started = time.monotonic()
        while self._paused and not self._cancelled:
            self._cond.wait(0.25)
        paused_for = time.monotonic() - started
        self._paused_total += paused_for
        if self._cancelled:
            raise RunCancelled()
        if notify_resume and self._on_resume is not None:
            self._on_resume()
        return paused_for


# The run on this thread, so waiting loops deep in selectors and activities can be stopped
# and paused without passing the run context everywhere.
_active = threading.local()


def set_active_control(control: RunControl | None) -> None:
    _active.control = control


def active_control() -> RunControl | None:
    return getattr(_active, "control", None)


def wait(seconds: float) -> None:
    """Sleep inside a step's waiting loop (stopped and paused with the run)."""
    control = active_control()
    if control is None:
        time.sleep(seconds)
    else:
        control.sleep(seconds)


class Deadline:
    """A step's time limit that doesn't count time the run spent paused."""

    def __init__(self, seconds: float):
        self._control = active_control()
        self._end = time.monotonic() + seconds
        self._paused_at_start = self._paused()

    def _paused(self) -> float:
        return self._control.paused_seconds if self._control is not None else 0.0

    @property
    def passed(self) -> bool:
        return time.monotonic() - (self._paused() - self._paused_at_start) >= self._end


@dataclass
class RunOptions:
    work_dir: Path
    inputs: dict[str, Any] = field(default_factory=dict)
    credentials: CredentialProvider | None = None
    breakpoints: set[str] = field(default_factory=set)
    step_mode: bool = False
    headless: bool = False
    # AI self-repair (see runtime/repair.py): asked for new settings when a step fails.
    repair: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
    repair_attempts: int = 3
    # The AI step (activities/ai.py): a task for the company's AI model, via the Orchestrator.
    ai: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
    # Shared values and queue steps (activities/orchestrator.py): questions for the Orchestrator.
    orchestrator: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None


class RunContext:
    """Variables, resources and services available to activities."""

    def __init__(self, flow: Flow, options: RunOptions, emit: Emit, control: RunControl):
        self.flow = flow
        self.options = options
        self.control = control
        self._emit = emit
        self.variables: dict[str, Any] = {}
        self.elements: dict[str, Element] = {e.id: e for e in flow.elements}
        self.resources: dict[str, Any] = {}
        self._cleanups: list[tuple[str, Callable[[], None]]] = []
        self._secrets: set[str] = set()
        self.current_step_id: str | None = None
        # Set while a browser is open: waits let it work meanwhile (it saves downloads then).
        self.pump: Callable[[float], bool] | None = None
        self.work_dir = options.work_dir
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._sensitive_vars = {v.name for v in flow.variables if v.sensitive}

    # -- variables ---------------------------------------------------------
    def get(self, name: str, default: Any = None) -> Any:
        return self.variables.get(name, default)

    def set(self, name: str, value: Any) -> None:
        if not name:
            return
        if name in self._sensitive_vars and isinstance(value, str):
            value = Secret(value)
        self._remember_secret(value)
        self.variables[name] = value
        self.emit("variable", name=name, value=to_jsonable(value))

    def _remember_secret(self, value: Any) -> None:
        if isinstance(value, Secret) and len(value) >= 3:
            self._secrets.add(str(value))
        elif isinstance(value, Credential) and len(value.password) >= 3:
            self._secrets.add(str(value.password))

    # -- credentials -------------------------------------------------------
    def credential(self, name: str) -> Credential:
        if not name:
            raise ActivityError("No credential was chosen.", "Pick a saved credential in the step settings.")
        if self.options.credentials is None:
            raise ActivityError(
                f"Credential '{name}' is not available here.",
                "Credentials are provided by the Orchestrator vault or Studio's local vault.",
            )
        cred = self.options.credentials(name)
        self._remember_secret(cred)
        return cred

    # -- resources ---------------------------------------------------------
    def add_cleanup(self, key: str, func: Callable[[], None]) -> None:
        self._cleanups.append((key, func))

    def cleanup(self) -> None:
        while self._cleanups:
            key, func = self._cleanups.pop()
            try:
                func()
            except Exception as exc:  # cleanup must never hide the real result
                log.warning("cleanup of %s failed: %s", key, exc)
        self.resources.clear()

    # -- output ------------------------------------------------------------
    def mask(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, MASK)
        return text

    def emit(self, event: str, **data: Any) -> None:
        payload = {"event": event, "ts": time.time(), **data}
        if self.current_step_id and "step_id" not in payload:
            payload["step_id"] = self.current_step_id
        self._emit(self._mask_payload(payload))

    def masked(self, value: Any) -> Any:
        """A copy of a JSON-like value with every known secret replaced by the mask."""
        return self._mask_payload(value)

    def _mask_payload(self, value: Any) -> Any:
        if not self._secrets:
            return value
        if isinstance(value, str):
            return self.mask(value)
        if isinstance(value, dict):
            return {k: self._mask_payload(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._mask_payload(v) for v in value]
        return value

    def log(self, message: str, level: str = "info") -> None:
        self.emit("log", level=level, message=message)

    def sleep(self, seconds: float) -> None:
        if self.pump is None:
            self.control.sleep(seconds)
            return
        end = time.monotonic() + seconds
        while True:
            paused = self.control.paused_seconds
            self.control.sleep(0)  # stops or pauses here
            end += self.control.paused_seconds - paused
            left = end - time.monotonic()
            if left <= 0:
                return
            if self.pump is None or not self.pump(min(left, 0.25)):
                self.control.sleep(left)
                return

    def file_path(self, name: str) -> Path:
        """A path inside this run's working folder (screenshots, downloads...)."""
        return self.work_dir / name
