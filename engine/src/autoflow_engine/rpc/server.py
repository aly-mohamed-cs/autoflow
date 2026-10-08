"""JSON-RPC 2.0 over stdio, one JSON message per line.

Studio starts ``autoflow-engine rpc`` as a child process. Requests come in on
stdin; responses and ``run.event`` notifications go out on stdout. Anything
printed by activities is redirected to stderr so it can never corrupt the
protocol stream. The engine can also ask Studio something during a run (ids
"h1", "h2"...), e.g. ``host.repair`` for an AI fix; Studio answers on stdin.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any

from pydantic import ValidationError

from .. import __version__, catalog
from ..design.desktop_picker import DesktopPicker
from ..design.desktop_recorder import DesktopRecorder
from ..design.session import DesignSession
from ..errors import AutoflowError, RunCancelled
from ..flow import Flow
from ..runtime.context import RunControl, RunOptions
from ..runtime.expressions import evaluate
from ..runtime.interpreter import FlowRunner
from ..validation import validate_flow
from ..values import Credential, to_jsonable

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603
APP_ERROR = 1


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class EngineServer:
    def __init__(self, reader: IO[str], writer: IO[str]):
        self._reader = reader
        self._writer = writer
        self._write_lock = threading.Lock()
        self._run_thread: threading.Thread | None = None
        self._control: RunControl | None = None
        self._run_id: str | None = None
        self._design: DesignSession | None = None
        self._desktop_picker: DesktopPicker | None = None
        self._desktop_recorder: DesktopRecorder | None = None
        self._host_seq = 0
        self._host_waiting: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        # Methods that answer later (the user is clicking in the design browser).
        self._deferred: dict[str, Callable[[dict[str, Any], Callable[..., None]], None]] = {
            "picker.web": lambda p, respond: self.design.pick(p.get("url"), respond),
            "recorder.start": lambda p, respond: self.design.record_start(p.get("url"), respond),
            "recorder.stop": lambda _p, respond: self.design.record_stop(respond),
            "picker.desktop": lambda _p, respond: self.desktop_picker.pick(respond),
            # Recording anything on the PC (any program), not just the design browser.
            "recorder.desktop_start": lambda _p, respond: self.desktop_recorder.start(respond),
            "recorder.desktop_stop": lambda _p, respond: self.desktop_recorder.stop(respond),
        }
        self._methods: dict[str, Callable[[dict[str, Any]], Any]] = {
            "ping": lambda _p: {"engine_version": __version__},
            "catalog.get": lambda _p: catalog.export_catalog(),
            "flow.validate": self._validate,
            "expression.evaluate": self._evaluate,
            "run.start": self._run_start,
            "run.pause": lambda _p: self._with_control(lambda c: c.pause()),
            "run.resume": lambda _p: self._with_control(lambda c: c.resume()),
            "run.step": lambda _p: self._with_control(lambda c: c.step()),
            "run.stop": lambda _p: self._with_control(lambda c: c.cancel()),
            "run.set_breakpoints": lambda p: self._with_control(lambda c: c.set_breakpoints(set(p.get("step_ids", [])))),
            "picker.cancel": lambda _p: self._cancel_pickers(),
            "design.close": lambda _p: self._close_design(),
        }

    @property
    def design(self) -> DesignSession:
        if self._design is None:
            # Tests run the design browser hidden.
            self._design = DesignSession(self.notify, headless=os.environ.get("AUTOFLOW_DESIGN_HEADLESS") == "1")
        return self._design

    def _close_design(self) -> None:
        if self._design is not None:
            self._design.close()
            self._design = None

    @property
    def desktop_picker(self) -> DesktopPicker:
        if self._desktop_picker is None:
            self._desktop_picker = DesktopPicker(self.notify)
        return self._desktop_picker

    @property
    def desktop_recorder(self) -> DesktopRecorder:
        if self._desktop_recorder is None:
            self._desktop_recorder = DesktopRecorder(self.notify)
        return self._desktop_recorder

    def _cancel_pickers(self) -> None:
        if self._design is not None:
            self._design.cancel()
        if self._desktop_picker is not None:
            self._desktop_picker.cancel()

    # -- transport ---------------------------------------------------------
    def serve(self) -> None:
        self._send({"jsonrpc": "2.0", "method": "engine.ready", "params": {"engine_version": __version__}})
        for line in self._reader:
            line = line.strip()
            if not line:
                continue
            self._handle(line)
        if self._control:
            self._control.cancel()
        if self._desktop_recorder is not None:
            self._desktop_recorder.cancel()
        self._close_design()

    def _send(self, message: dict[str, Any]) -> None:
        data = json.dumps(message, default=str, ensure_ascii=False)
        with self._write_lock:
            self._writer.write(data + "\n")
            self._writer.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _handle(self, line: str) -> None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            self._send({"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": "Invalid JSON"}})
            return
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if method is None and isinstance(req_id, str) and req_id in self._host_waiting:
            done, slot = self._host_waiting[req_id]
            slot.update(request)  # Studio's answer to a host.* request
            done.set()
            return
        try:
            if not isinstance(method, str) or not isinstance(params, dict):
                raise RpcError(INVALID_REQUEST, "Invalid request")
            deferred = self._deferred.get(method)
            if deferred is not None:
                deferred(params, self._responder(req_id))
                return
            handler = self._methods.get(method)
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"Unknown method {method}")
            result = handler(params)
            if req_id is not None:
                self._send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except RpcError as exc:
            self._reply_error(req_id, exc.code, exc.message, exc.data)
        except AutoflowError as exc:
            self._reply_error(req_id, APP_ERROR, exc.message, {"hint": exc.hint})
        except ValidationError as exc:
            self._reply_error(req_id, INVALID_PARAMS, "Invalid parameters", exc.errors(include_url=False))
        except Exception as exc:  # report, never crash the engine process
            traceback.print_exc(file=sys.stderr)
            self._reply_error(req_id, INTERNAL_ERROR, str(exc))

    def _responder(self, req_id: Any) -> Callable[..., None]:
        """Callback that sends the answer to a deferred request exactly once."""
        done = threading.Event()

        def respond(result: Any = None, error: BaseException | None = None) -> None:
            if done.is_set() or req_id is None:
                return
            done.set()
            if error is None:
                self._send({"jsonrpc": "2.0", "id": req_id, "result": to_jsonable(result)})
            elif isinstance(error, AutoflowError):
                self._reply_error(req_id, APP_ERROR, error.message, {"hint": error.hint})
            else:
                self._reply_error(req_id, INTERNAL_ERROR, str(error))

        return respond

    def request_host(self, method: str, params: dict[str, Any], control: RunControl, timeout: float) -> Any:
        """Ask Studio something and wait for the answer (stops waiting if the run is cancelled)."""
        self._host_seq += 1
        req_id = f"h{self._host_seq}"
        done, slot = threading.Event(), {}
        self._host_waiting[req_id] = (done, slot)
        try:
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": to_jsonable(params)})
            deadline = time.monotonic() + timeout
            while not done.wait(0.25):
                if control.cancelled:
                    raise RunCancelled()
                if time.monotonic() > deadline:
                    raise AutoflowError("Studio did not answer in time.")
        finally:
            self._host_waiting.pop(req_id, None)
        if "error" in slot:
            raise AutoflowError(str((slot["error"] or {}).get("message") or "Studio could not answer."))
        return slot.get("result")

    def _reply_error(self, req_id: Any, code: int, message: str, data: Any = None) -> None:
        if req_id is None:
            return
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = to_jsonable(data)
        self._send({"jsonrpc": "2.0", "id": req_id, "error": error})

    # -- methods -----------------------------------------------------------
    def _validate(self, params: dict[str, Any]) -> dict[str, Any]:
        issues = validate_flow(params.get("flow") or {})
        return {"issues": [i.to_json() for i in issues]}

    def _evaluate(self, params: dict[str, Any]) -> dict[str, Any]:
        """Lets Studio preview a formula with sample variable values."""
        try:
            value = evaluate(str(params.get("expression", "")), params.get("variables") or {})
            return {"ok": True, "value": to_jsonable(value)}
        except AutoflowError as exc:
            return {"ok": False, "error": exc.message, "hint": exc.hint}

    def _run_start(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._run_thread and self._run_thread.is_alive():
            raise RpcError(APP_ERROR, "A flow is already running.")
        flow = Flow.model_validate(params["flow"])
        secrets = params.get("credentials") or {}

        def provide(name: str) -> Credential:
            entry = secrets.get(name)
            if not entry:
                raise AutoflowError(f"Credential '{name}' was not found.", "Add it under Credentials in Studio.")
            return Credential(name, entry.get("username", ""), entry.get("password", ""))

        work_dir = Path(params.get("work_dir") or tempfile.mkdtemp(prefix="autoflow-run-"))
        options = RunOptions(
            work_dir=work_dir,
            inputs=params.get("inputs") or {},
            credentials=provide,
            breakpoints=set(params.get("breakpoints") or []),
            step_mode=bool(params.get("step_mode")),
            headless=bool(params.get("headless")),
        )
        self._control = RunControl(options.breakpoints, options.step_mode)
        if params.get("repair"):
            control = self._control
            options.repair = lambda request: self.request_host("host.repair", request, control, timeout=660)
        runner = FlowRunner(flow, options, emit=lambda e: self.notify("run.event", e), control=self._control)
        self._run_id = runner.run_id

        self._run_thread = threading.Thread(target=runner.run, name=f"run-{runner.run_id}", daemon=True)
        self._run_thread.start()
        return {"run_id": runner.run_id, "work_dir": str(work_dir)}

    def _with_control(self, action: Callable[[RunControl], None]) -> dict[str, Any]:
        if self._control is None:
            raise RpcError(APP_ERROR, "No flow is running.")
        action(self._control)
        return {"ok": True}


def serve_stdio() -> None:
    protocol_out = sys.stdout
    sys.stdout = sys.stderr  # stray print() calls must not break the protocol
    reader = open(sys.stdin.fileno(), encoding="utf-8", closefd=False)  # noqa: SIM115
    writer = open(protocol_out.fileno(), "w", encoding="utf-8", closefd=False)  # noqa: SIM115
    EngineServer(reader, writer).serve()
