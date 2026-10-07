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
    """Pause / resume / step / stop requests coming from Studio or the robot."""

    def __init__(self, breakpoints: set[str] | None = None, step_mode: bool = False):
        self._cond = threading.Condition()
        self._cancelled = False
        self._paused = False
        # Set by step(): let the current step run, then pause before the next one.
        self._pause_before_next = step_mode
        self.breakpoints: set[str] = set(breakpoints or ())

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def paused(self) -> bool:
        return self._paused

    def cancel(self) -> None:
        with self._cond:
            self._cancelled = True
            self._cond.notify_all()

    def pause(self) -> None:
        """Pause before the next step starts."""
        with self._cond:
            self._pause_before_next = True

    def resume(self) -> None:
        with self._cond:
            self._paused = False
            self._pause_before_next = False
            self._cond.notify_all()

    def step(self) -> None:
        """Run exactly one more step, then pause again."""
        with self._cond:
            self._paused = False
            self._pause_before_next = True
            self._cond.notify_all()

    def set_breakpoints(self, step_ids: set[str]) -> None:
        with self._cond:
            self.breakpoints = set(step_ids)

    def checkpoint(self, step_id: str, on_pause: Callable[[str], None]) -> None:
        """Called before every step. Blocks while paused; raises when cancelled."""
        with self._cond:
            if self._cancelled:
                raise RunCancelled()
            reason = None
            if step_id in self.breakpoints:
                reason = "breakpoint"
            elif self._pause_before_next:
                reason = "paused"
            if reason is None:
                return
            self._pause_before_next = False
            self._paused = True
            on_pause(reason)
            while self._paused and not self._cancelled:
                self._cond.wait(0.25)
            if self._cancelled:
                raise RunCancelled()

    def sleep(self, seconds: float) -> None:
        """Interruptible sleep: stops early when the run is cancelled."""
        deadline = time.monotonic() + seconds
        with self._cond:
            while not self._cancelled:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._cond.wait(min(remaining, 0.25))
        raise RunCancelled()


@dataclass
class RunOptions:
    work_dir: Path
    inputs: dict[str, Any] = field(default_factory=dict)
    credentials: CredentialProvider | None = None
    breakpoints: set[str] = field(default_factory=set)
    step_mode: bool = False
    headless: bool = False


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
        self.control.sleep(seconds)

    def file_path(self, name: str) -> Path:
        """A path inside this run's working folder (screenshots, downloads...)."""
        return self.work_dir / name
