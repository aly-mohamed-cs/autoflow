from __future__ import annotations

import functools
import http.server
import itertools
import threading
from pathlib import Path
from typing import Any

import pytest

from autoflow_engine.flow import Flow
from autoflow_engine.runtime.context import RunControl, RunOptions
from autoflow_engine.runtime.interpreter import FlowRunner, RunResult

_ids = itertools.count(1)


def step(activity: str, params: dict[str, Any] | None = None, *, outputs: dict[str, str] | None = None,
         blocks: dict[str, list[dict]] | None = None, **extra: Any) -> dict[str, Any]:
    """Build a step dict with an auto id (pass id= to choose one)."""
    data = {"id": extra.pop("id", f"s{next(_ids)}"), "activity": activity, "params": params or {}}
    if outputs:
        data["outputs"] = outputs
    if blocks:
        data["blocks"] = blocks
    data.update(extra)
    return data


class Harness:
    def __init__(self, tmp_path: Path):
        self.tmp_path = tmp_path
        self.events: list[dict[str, Any]] = []
        self.runner: FlowRunner | None = None

    def run(self, steps: list[dict], *, variables: list[dict] | None = None, inputs: dict | None = None,
            control: RunControl | None = None, credentials=None, settings: dict | None = None,
            processes: list[dict] | None = None) -> RunResult:
        self.events = []
        flow = Flow.model_validate({
            "id": "test", "name": "Test flow", "steps": steps,
            "variables": variables or [], "settings": settings or {}, "processes": processes or [],
        })
        options = RunOptions(work_dir=self.tmp_path / "run", inputs=inputs or {}, credentials=credentials)
        self.runner = FlowRunner(flow, options, self.events.append, control=control)
        return self.runner.run()

    @property
    def vars(self) -> dict[str, Any]:
        assert self.runner is not None
        return self.runner.ctx.variables

    def logs(self) -> list[str]:
        return [e["message"] for e in self.events if e["event"] == "log"]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["event"] == kind]


@pytest.fixture
def h(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


PORTAL = Path(__file__).resolve().parents[2] / "testbed" / "portal"


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def portal_url():
    """The demo portal (testbed/portal) served on a free local port."""
    handler = functools.partial(_QuietHandler, directory=str(PORTAL))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/index.html"
    server.shutdown()
