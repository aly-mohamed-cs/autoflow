"""Flowcharts with free connections: steps run along the connectors drawn between them."""

from __future__ import annotations

from conftest import step

from autoflow_engine.runtime import interpreter
from autoflow_engine.validation import validate_flow


def log(text: str, **extra) -> dict:
    return step("control.log", {"message": text}, **extra)


def link(source: str, target: str, port: str = "next") -> dict:
    return {"source": source, "target": target, "port": port}


def test_steps_run_in_the_order_they_are_connected_and_unconnected_ones_never(h):
    steps = [log("third", id="c"), log("first", id="a"), log("never", id="loose"), log("second", id="b")]
    result = h.run(steps, flowchart={"links": [link("start", "a"), link("a", "b"), link("b", "c")]})
    assert result.status == "succeeded", result.error
    assert h.logs() == ["first", "second", "third"]
    assert "loose" not in {e.get("step_id") for e in h.of("step_started")}


def test_nothing_connected_to_start_runs_nothing(h):
    result = h.run([log("alone", id="a")], flowchart={"links": [], "positions": {"a": {"x": 10, "y": 20}}})
    assert result.status == "succeeded"
    assert h.logs() == []


def test_a_decision_branches_and_a_connector_back_repeats_steps(h):
    steps = [
        step("control.set_variable", {"variable": "n", "value": "{{n + 1}}"}, id="count"),
        step("control.decision", {"condition": "{{n}} >= 3"}, id="enough"),
        log("Counted to {{n}}", id="done"),
    ]
    result = h.run(steps, variables=[{"name": "n", "type": "number", "default": 0}], flowchart={"links": [
        link("start", "count"), link("count", "enough"), link("enough", "done", "yes"), link("enough", "count", "no"),
    ]})
    assert result.status == "succeeded", result.error
    assert h.logs() == ["Counted to 3"]
    assert [e["step_id"] for e in h.of("step_started")].count("enough") == 3


def test_a_decision_without_a_connector_on_its_answer_ends_the_run(h):
    steps = [step("control.decision", {"condition": "1 == 2"}, id="d"), log("yes side", id="y")]
    result = h.run(steps, flowchart={"links": [link("start", "d"), link("d", "y", "yes")]})
    assert result.status == "succeeded" and h.logs() == []


def test_a_turned_off_decision_goes_on_along_no(h):
    steps = [step("control.decision", {"condition": "1 == 1"}, id="d", disabled=True), log("no side", id="n")]
    h.run(steps, flowchart={"links": [link("start", "d"), link("d", "n", "no")]})
    assert h.logs() == ["no side"]


def test_a_connector_loop_that_never_ends_is_stopped(h, monkeypatch):
    monkeypatch.setattr(interpreter, "MAX_CHART_STEPS", 50)
    result = h.run([log("again", id="a")], flowchart={"links": [link("start", "a"), link("a", "a")]})
    assert result.status == "failed"
    assert "ran 50 steps and was stopped" in result.error["message"]
    assert len(h.logs()) == 50


def test_boxes_inside_a_flowchart_still_run_their_steps_in_order(h):
    steps = [
        step("control.for_each", {"items": "{{['x', 'y']}}", "item_variable": "it"}, id="loop",
             blocks={"body": [log("item {{it}}"), log("after {{it}}")]}),
        log("end", id="end"),
    ]
    h.run(steps, flowchart={"links": [link("start", "loop"), link("loop", "end")]})
    assert h.logs() == ["item x", "after x", "item y", "after y", "end"]


def test_sub_processes_can_have_their_own_flowchart(h):
    processes = [{"id": "greet", "name": "Greet", "steps": [log("hi", id="p1"), log("bye", id="p2"), log("unused", id="p3")],
                  "flowchart": {"links": [link("start", "p2"), link("p2", "p1")]}}]
    result = h.run([step("control.run_process", {"process": "greet"})], processes=processes)
    assert result.status == "succeeded", result.error
    assert h.logs()[-2:] == ["bye", "hi"]


def _issues(steps, flowchart=None):
    flow = {"id": "f", "name": "f", "steps": steps, **({"flowchart": flowchart} if flowchart is not None else {})}
    return [(i.severity, i.message, i.step_id) for i in validate_flow(flow)]


def test_validation_of_connectors_and_decisions():
    decision = step("control.decision", {"condition": "1 == 1"}, id="d")
    assert any("only works between connectors" in m for _, m, _ in _issues([decision]))
    inside = step("control.repeat", {"times": 2}, id="r", blocks={"body": [step("control.decision", {"condition": "1 == 1"}, id="d2")]})
    assert any(sid == "d2" and "only works" in m for _, m, sid in _issues([inside], {"links": [link("start", "r")]}))

    steps = [log("a", id="a"), log("b", id="b"), decision]
    issues = _issues(steps, {"links": [
        link("start", "a"), link("a", "b"), link("a", "d"),      # two connectors out of 'a'
        link("b", "gone"),                                        # leads nowhere
        link("d", "a", "next"),                                   # Decisions go on Yes / No
        link("d", "b", "yes"),
    ]})
    messages = [m for _, m, _ in issues]
    assert any("Two connectors go out of the same place" in m for m in messages)
    assert any("leads to a step that no longer exists" in m for m in messages)
    assert any("on 'next', which it doesn't have" in m for m in messages)
    assert all(sev == "error" for sev, _, _ in issues)

    # A clean flowchart (with a step left unconnected on purpose) has no problems.
    assert _issues([log("a", id="a"), log("spare", id="s")], {"links": [link("start", "a")]}) == []
