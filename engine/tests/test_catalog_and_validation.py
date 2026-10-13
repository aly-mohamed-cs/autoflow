"""Contract tests: every activity is complete enough for Studio to render it."""

import io
import json
import re
import threading
import time

import pytest
from conftest import step

from autoflow_engine import catalog
from autoflow_engine.catalog import UI_KINDS
from autoflow_engine.flow import IDENTIFIER, Flow
from autoflow_engine.rpc.server import EngineServer
from autoflow_engine.validation import validate_flow

REGISTRY = catalog.load_activities()
ACTIVITIES = sorted(REGISTRY.values(), key=lambda a: a.id)


def test_catalog_exports_as_json():
    data = catalog.export_catalog()
    text = json.dumps(data)
    assert len(data["activities"]) == len(REGISTRY) >= 60
    assert {"categories", "functions", "operators"} <= data.keys()
    assert "UPPER" in text


@pytest.mark.parametrize("adef", ACTIVITIES, ids=lambda a: a.id)
def test_activity_contract(adef):
    assert re.fullmatch(r"[a-z]+\.[a-z_]+", adef.id)
    assert adef.id.split(".")[0] in {"control", "files", "data", "text", "excel", "browser", "desktop", "pdf",
                                     "email", "http", "db", "screen"}
    assert adef.title and adef.title[0].isupper()
    assert adef.icon and adef.sentence
    fields = adef.params.model_fields
    for placeholder in re.findall(r"\{(\w+)\}", adef.sentence):
        assert placeholder in fields, f"sentence uses unknown setting {placeholder}"
    for name, info in fields.items():
        assert info.title, f"setting {name} needs a title"
        extra = info.json_schema_extra if isinstance(info.json_schema_extra, dict) else {}
        assert extra.get("x-ui") in (None, *UI_KINDS)
        if extra.get("x-ui") == "column":
            assert extra.get("x-source") in fields, f"column picker {name} needs a valid source"
        schema = adef.params.model_json_schema()["properties"]
        for other, values in (extra.get("x-show-when") or {}).items():
            assert other in fields, f"{name} is shown depending on unknown setting {other}"
            choices = schema[other].get("enum") or (["True", "False"] if schema[other].get("type") == "boolean" else None)
            if choices:
                assert set(map(str, values)) <= set(map(str, choices)), f"{name}: show_when uses unknown values"
        if extra.get("x-labels"):
            assert set(extra["x-labels"]) == set(schema[name]["enum"]), f"{name}: labels must match the choices"
    for out in adef.outputs:
        assert re.fullmatch(IDENTIFIER, out.default_variable or out.name)
    adef.params.model_json_schema()  # must not raise


def test_flow_schema_exports():
    schema = Flow.model_json_schema()
    assert "Step" in schema["$defs"]


def test_validation_reports_problems():
    issues = validate_flow({
        "id": "f", "name": "f",
        "variables": [{"name": "known"}],
        "steps": [
            step("control.log", {}, id="missing"),
            step("control.log", {"message": "{{unknown_var}} {{known}}"}, id="undefined"),
            step("control.wait", {"seconds": -5}, id="range"),
            step("control.log", {"message": "{{UPPER(known}}"}, id="typo"),
            step("does.not_exist", id="unknown"),
            step("control.log", {"message": "ok"}, id="dup"),
            step("control.log", {"message": "ok"}, id="dup"),
            step("control.wait", {"seconds": "{{known}}"}, id="templated"),
        ],
    })
    by_step = {(i.step_id, i.severity) for i in issues}
    assert ("missing", "error") in by_step
    assert ("undefined", "warning") in by_step
    assert ("range", "error") in by_step
    assert ("typo", "error") in by_step
    assert ("unknown", "error") in by_step
    assert ("dup", "error") in by_step
    assert not any(i.step_id == "templated" for i in issues)


def test_validation_checks_sub_processes():
    issues = validate_flow({
        "id": "f", "name": "f",
        "steps": [
            step("control.run_process", {"process": "login", "inputs": {"user": "x"}}, id="ok"),
            step("control.run_process", {"process": "gone"}, id="missing"),
        ],
        "processes": [
            {"id": "login", "name": "Log in", "inputs": [{"name": "user"}, {"name": "user"}],
             "steps": [step("control.log", {"message": "{{user}}"}, id="uses_input")]},
            {"id": "login", "name": "Copy"},
        ],
    })
    messages = [i.message for i in issues]
    assert {(i.step_id, i.severity) for i in issues if i.step_id} == {("missing", "error")}
    assert "Two sub-processes share the id 'login'." in messages
    assert "Sub-process 'Log in' has two inputs called 'user'." in messages


def test_validation_knows_loop_and_output_variables():
    issues = validate_flow({
        "id": "f", "name": "f",
        "steps": [
            step("files.list", {"folder": "C:/x"}, outputs={"files": "files"}),
            step("control.for_each", {"items": "{{files}}", "item_variable": "file"}, blocks={"body": [
                step("control.log", {"message": "{{file}}"}),
            ]}),
            step("data.filter", {"table": "{{files}}", "condition": {"rules": [
                {"left": '{{row["x"]}}', "op": "is_empty"}]}}),
        ],
    })
    assert issues == []


def test_rpc_server_round_trip(tmp_path):
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {"jsonrpc": "2.0", "id": 2, "method": "flow.validate", "params": {"flow": {"id": "f", "name": "f", "steps": [
            {"id": "a", "activity": "control.log", "params": {}}]}}},
        {"jsonrpc": "2.0", "id": 3, "method": "expression.evaluate",
         "params": {"expression": "UPPER(x)", "variables": {"x": "ok"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "run.start", "params": {
            "work_dir": str(tmp_path), "flow": {"id": "f", "name": "f", "steps": [
                {"id": "a", "activity": "control.log", "params": {"message": "hi"}}]}}},
        {"jsonrpc": "2.0", "id": 5, "method": "nope"},
    ]
    reader = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    writer = io.StringIO()
    server = EngineServer(reader, writer)
    t = threading.Thread(target=server.serve)
    t.start()
    t.join(5)
    deadline = time.monotonic() + 5
    while "run_finished" not in writer.getvalue() and time.monotonic() < deadline:
        time.sleep(0.02)
    messages = [json.loads(line) for line in writer.getvalue().splitlines()]
    replies = {m["id"]: m for m in messages if "id" in m}
    assert messages[0]["method"] == "engine.ready"
    assert replies[1]["result"]["engine_version"]
    assert replies[2]["result"]["issues"][0]["field"] == "message"
    assert replies[3]["result"] == {"ok": True, "value": "OK"}
    assert replies[4]["result"]["run_id"]
    assert replies[5]["error"]["code"] == -32601
    events = [m["params"]["event"] for m in messages if m.get("method") == "run.event"]
    assert events[0] == "run_started" and events[-1] == "run_finished"


def test_switch_cases_are_its_sections():
    issues = validate_flow({
        "id": "f", "name": "f",
        "steps": [step("control.switch", {"value": "x", "cases": ["A", "B"]}, id="sw", blocks={
            "case_1": [], "case_2": [], "default": [], "case_3": [],
        })],
    })
    assert [(i.step_id, i.message) for i in issues] == [("sw", "'Switch / case' has no section called 'case_3'.")]
    exported = next(a for a in catalog.export_catalog()["activities"] if a["id"] == "control.switch")
    assert exported["block_list"] == {"param": "cases", "prefix": "case_"}


def test_debug_console_reads_the_variables_of_a_paused_run(tmp_path):
    server = EngineServer(io.StringIO(), io.StringIO())
    events: list[dict] = []
    server.notify = lambda method, params: events.append(params)
    assert server._run_evaluate({"expression": "1"})["ok"] is False  # nothing ran yet
    server._run_start({"work_dir": str(tmp_path), "breakpoints": ["b"], "flow": {
        "id": "f", "name": "f", "variables": [{"name": "x", "type": "number", "default": 5}],
        "steps": [{"id": "a", "activity": "control.increase", "params": {"variable": "x"}},
                  {"id": "b", "activity": "control.log", "params": {"message": "{{x}}"}}],
    }})
    deadline = time.monotonic() + 5
    while not any(e.get("event") == "paused" for e in events) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server._run_evaluate({"expression": "x * 2"}) == {"ok": True, "value": 12}
    assert server._run_evaluate({"expression": "UPPER("})["ok"] is False
    server._with_control(lambda c: c.resume())
    while not any(e.get("event") == "run_finished" for e in events) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert events[-1]["status"] == "succeeded"
