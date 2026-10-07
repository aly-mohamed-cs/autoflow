"""JSON-RPC 2.0 over stdio, one JSON message per line.

Studio starts ``autoflow-engine rpc`` as a child process. Requests come in on
stdin; responses and ``run.event`` notifications go out on stdout. Anything
printed by activities is redirected to stderr so it can never corrupt the
protocol stream.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any

from pydantic import ValidationError

from .. import __version__, catalog
from ..errors import AutoflowError
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
        }

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
        try:
            if not isinstance(method, str) or not isinstance(params, dict):
                raise RpcError(INVALID_REQUEST, "Invalid request")
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
