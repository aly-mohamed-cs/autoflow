"""AI self-repair: a failed step gets new settings from the repair provider and is retried in place."""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path
from typing import Any

import pytest
from conftest import step
from openpyxl import Workbook
from test_browser import BROWSER

from autoflow_engine.flow import Flow
from autoflow_engine.rpc.server import EngineServer
from autoflow_engine.runtime.context import RunOptions
from autoflow_engine.runtime.interpreter import FlowRunner


class FakeAssistant:
    """Stands in for the Orchestrator + model: records requests, answers with a function."""

    def __init__(self, answer):
        self.answer = answer
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: dict[str, Any]) -> dict[str, Any] | None:
        self.requests.append(json.loads(json.dumps(request, default=str)))
        return self.answer(request)


def run(tmp_path: Path, steps, assistant, *, elements=None, variables=None, headless=True):
    events: list[dict] = []
    flow = Flow.model_validate({"id": "f", "name": "Repair test", "steps": steps, "elements": elements or [],
                                "variables": variables or [], "settings": {"default_timeout": 2}})
    options = RunOptions(work_dir=tmp_path / "run", headless=headless, repair=assistant)
    runner = FlowRunner(flow, options, events.append)
    return runner.run(), events, runner


def of(events, kind):
    return [e for e in events if e["event"] == kind]


def test_fixes_a_wrong_file_inside_a_loop_and_asks_only_once(tmp_path):
    (tmp_path / "orders-2026.txt").write_text("hello", encoding="utf-8")
    assistant = FakeAssistant(lambda req: {
        "explanation": "The file is called orders-2026.txt.",
        "params": {"file": str(tmp_path / "orders-2026.txt")},
    })
    result, events, runner = run(tmp_path, [
        step("control.for_each", {"items": "{{[1, 2, 3]}}", "item_variable": "n"}, blocks={"body": [
            step("files.read_text", {"file": str(tmp_path / "orders.txt")}, outputs={"text": "t"}, id="read"),
        ]}),
    ], assistant)
    assert result.status == "succeeded", result.error
    assert len(assistant.requests) == 1  # the next rows reuse the fix
    request = assistant.requests[0]
    assert request["activity"] == "files.read_text"
    assert request["error"]["message"]
    files = request["screen"]["paths"]["file"]
    assert files["missing"].endswith("orders.txt") and "orders-2026.txt" in files["entries"]
    assert {"name": "n", "type": "number"} in request["variables"]
    repaired = of(events, "step_repaired")
    assert len(repaired) == 1
    assert repaired[0]["step_id"] == "read"
    assert repaired[0]["patch"] == {"step_id": "read", "params": {"file": str(tmp_path / "orders-2026.txt")},
                                    "element": None, "new_element": False}
    assert runner.ctx.variables["t"] == "hello"
    assert [e.get("repaired") for e in of(events, "step_finished") if e["step_id"] == "read"][0] is True


def test_fixes_a_sheet_name_using_the_workbook_sheets(tmp_path):
    book = tmp_path / "invoices.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Invoices 2026"
    ws.append(["Number", "Amount"])
    ws.append(["INV-1", 10])
    wb.save(book)

    def answer(req):
        sheets = req["screen"]["paths"]["file"]["sheets"]
        return {"explanation": "Use the sheet that exists.", "params": {"sheet": sheets[0]["name"]}}

    assistant = FakeAssistant(answer)
    result, _events, runner = run(tmp_path, [
        step("excel.read", {"file": str(book), "sheet": "Invoices"}, outputs={"table": "rows"}),
    ], assistant)
    assert result.status == "succeeded", result.error
    assert assistant.requests[0]["screen"]["paths"]["file"]["sheets"] == [
        {"name": "Invoices 2026", "first_row": ["Number", "Amount"]}]
    assert "INV-1" not in json.dumps(assistant.requests)  # cell values are never sent
    assert len(runner.ctx.variables["rows"]) == 1


def test_gives_up_after_three_fixes_that_do_not_work(tmp_path):
    counter = iter(range(1, 10))
    assistant = FakeAssistant(lambda req: {"explanation": "Try another name.",
                                           "params": {"file": str(tmp_path / f"guess-{next(counter)}.txt")}})
    result, events, _ = run(tmp_path, [step("files.read_text", {"file": str(tmp_path / "missing.txt")}, id="r")],
                            assistant)
    assert result.status == "failed"
    assert "missing.txt" in result.error["message"]  # the original problem is reported
    assert len(assistant.requests) == 3
    assert [len(r["attempts"]) for r in assistant.requests] == [0, 1, 2]
    assert assistant.requests[2]["attempts"][1]["error"]
    assert len(of(events, "repair_trying")) == 3
    assert not of(events, "step_repaired")


def test_no_fix_and_unreachable_assistant_end_the_repair(tmp_path):
    assistant = FakeAssistant(lambda req: {"fixable": False, "explanation": "The file was never created."})
    result, events, _ = run(tmp_path, [step("files.read_text", {"file": str(tmp_path / "x.txt")})], assistant)
    assert result.status == "failed"
    assert len(assistant.requests) == 1
    assert of(events, "repair_failed")[0]["reason"] == "The file was never created."

    def down(_req):
        raise ConnectionError("model server is off")

    result, events, _ = run(tmp_path, [step("files.read_text", {"file": str(tmp_path / "x.txt")})], down)
    assert result.status == "failed"
    assert "model server is off" in of(events, "repair_failed")[0]["reason"]


def test_only_safe_steps_and_settings_are_changed(tmp_path):
    assistant = FakeAssistant(lambda req: {"explanation": "x", "params": {"url": "http://example.invalid"}})
    # HTTP requests may have side effects, so they are never repaired.
    result, _events, _ = run(tmp_path, [step("http.request", {"url": "http://127.0.0.1:9/nothing", "timeout": 1})],
                             assistant)
    assert result.status == "failed" and assistant.requests == []

    # Unknown settings and credential settings are ignored; with nothing left there is no fix.
    sneaky = FakeAssistant(lambda req: {"explanation": "x", "params": {"bogus": 1, "element": "other"}})
    result, events, _ = run(tmp_path, [step("files.read_text", {"file": str(tmp_path / "x.txt")})], sneaky)
    assert result.status == "failed" and len(sneaky.requests) == 1 and not of(events, "repair_trying")

    # Where results are written (or what is typed / which site is opened) is never the assistant's call.
    redirect = FakeAssistant(lambda req: {"explanation": "x", "params": {"file": str(tmp_path / "elsewhere.txt")}})
    (tmp_path / "a-folder").mkdir()
    result, events, _ = run(tmp_path, [
        step("files.write_text", {"file": str(tmp_path / "a-folder"), "text": "data"}),
    ], redirect)
    assert result.status == "failed" and not of(events, "repair_trying")
    assert not (tmp_path / "elsewhere.txt").exists()

    # Steps that use a password are never handed to the assistant at all.
    never = FakeAssistant(lambda req: {"explanation": "x", "params": {"file": str(tmp_path / "a.txt")}})
    result, _events, _ = run(tmp_path, [
        step("files.read_text", {"file": str(tmp_path / "{{login.password}}.txt")}),
    ], never)
    assert result.status == "failed" and never.requests == []


def test_secrets_never_reach_the_assistant(tmp_path):
    assistant = FakeAssistant(lambda req: None)
    run(tmp_path, [
        step("control.set_variable", {"variable": "pin", "value": "secret-98765"}),
        step("files.read_text", {"file": str(tmp_path / "secret-98765.txt")}),
    ], assistant, variables=[{"name": "pin", "type": "text", "sensitive": True}])
    assert assistant.requests and "secret-98765" not in json.dumps(assistant.requests)


@pytest.mark.browser
def test_repicks_a_web_element_from_what_is_on_the_page(tmp_path, portal_url):
    def answer(req):
        buttons = [e for e in req["screen"]["elements"] if e["tag"] == "button"]
        name = buttons[0]["text"]
        return {"explanation": f"The button is now called '{name}'.",
                "selectors": [{"strategy": "role", "value": "button", "options": {"name": name, "exact": True}}]}

    assistant = FakeAssistant(answer)
    elements = [
        {"id": "user", "name": "Username box", "kind": "web", "selectors": [{"strategy": "label", "value": "Username"}]},
        {"id": "signin", "name": "Log on button", "kind": "web",
         "selectors": [{"strategy": "role", "value": "button", "options": {"name": "Log on"}}], "context": {"nth": 0}},
    ]
    result, events, runner = run(tmp_path, [
        step("browser.open", {"url": portal_url, "browser": BROWSER}),
        step("browser.type", {"element": "user", "text": "robot"}),
        step("browser.click", {"element": "signin"}, id="click"),
    ], assistant, elements=elements)
    assert result.status == "succeeded", result.error
    screen = assistant.requests[0]["screen"]
    assert screen["kind"] == "web" and screen["title"]
    assert {"tag": "button", "type": "submit", "text": "Sign in"} in screen["elements"]
    assert all("robot" not in json.dumps(e) for e in screen["elements"])  # typed text is not sent
    patch = of(events, "step_repaired")[0]["patch"]
    assert patch["element"]["selectors"][0]["options"]["name"] == "Sign in"
    assert patch["element"]["selectors"][1]["options"]["name"] == "Log on"  # old way kept as a backup
    assert "nth" not in patch["element"]["context"]
    assert runner.ctx.elements["signin"].selectors[0].options["name"] == "Sign in"


def test_rpc_asks_studio_for_the_fix(tmp_path):
    """Studio answers host.repair requests that the engine sends during a run."""
    (tmp_path / "real.txt").write_text("ok", encoding="utf-8")
    to_engine_r, to_engine_w = _pipe()
    out = _Lines()
    server = EngineServer(to_engine_r, out)
    threading.Thread(target=server.serve, daemon=True).start()
    flow = {"id": "f", "name": "f", "steps": [step("files.read_text", {"file": str(tmp_path / "nope.txt")})]}
    to_engine_w.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "run.start",
                                  "params": {"flow": flow, "repair": True, "work_dir": str(tmp_path / "w")}}) + "\n")
    to_engine_w.flush()
    ask = out.wait(lambda m: m.get("method") == "host.repair")
    assert ask["id"].startswith("h") and ask["params"]["activity"] == "files.read_text"
    to_engine_w.write(json.dumps({"jsonrpc": "2.0", "id": ask["id"],
                                  "result": {"explanation": "Right file.", "params": {"file": str(tmp_path / "real.txt")}}}) + "\n")
    to_engine_w.flush()
    finished = out.wait(lambda m: m.get("method") == "run.event" and m["params"]["event"] == "run_finished")
    assert finished["params"]["status"] == "succeeded"
    to_engine_w.close()


class _Lines(io.StringIO):
    """Collects what the engine writes and lets a test wait for a message."""

    def __init__(self):
        super().__init__()
        self._cond = threading.Condition()
        self.messages: list[dict] = []

    def write(self, text: str) -> int:
        with self._cond:
            for line in text.splitlines():
                if line.strip():
                    self.messages.append(json.loads(line))
            self._cond.notify_all()
        return len(text)

    def wait(self, match, timeout: float = 20):
        with self._cond:
            ok = self._cond.wait_for(lambda: any(match(m) for m in self.messages), timeout)
            assert ok, self.messages
            return next(m for m in self.messages if match(m))


def _pipe():
    import os

    r, w = os.pipe()
    return open(r, encoding="utf-8"), open(w, "w", encoding="utf-8")  # noqa: SIM115
