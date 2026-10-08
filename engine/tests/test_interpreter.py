import threading
import time

from conftest import step

from autoflow_engine.runtime.context import RunControl
from autoflow_engine.values import Credential, Table


def test_variables_inputs_and_outputs(h):
    result = h.run(
        [step("control.set_variable", {"variable": "greeting", "value": "Hello {{name}}"})],
        variables=[
            {"name": "name", "type": "text", "is_input": True, "default": "World"},
            {"name": "count", "type": "number", "is_input": True},
            {"name": "greeting", "type": "text", "is_output": True},
        ],
        inputs={"name": "Mona", "count": "7"},
    )
    assert result.status == "succeeded"
    assert result.outputs == {"greeting": "Hello Mona"}
    assert h.vars["count"] == 7


def test_if_else(h):
    branch = {
        "then": [step("control.set_variable", {"variable": "size", "value": "big"})],
        "else": [step("control.set_variable", {"variable": "size", "value": "small"})],
    }
    cond = {"rules": [{"left": "{{amount}}", "op": "greater", "right": 100}]}
    h.run([step("control.if", {"condition": cond}, blocks=branch)],
          variables=[{"name": "amount", "default": 250}])
    assert h.vars["size"] == "big"
    h.run([step("control.if", {"condition": cond}, blocks=branch)],
          variables=[{"name": "amount", "default": 5}])
    assert h.vars["size"] == "small"


def test_for_each_over_table_with_break_and_continue(h):
    rows = [
        {"Name": "a", "Skip": "no"}, {"Name": "b", "Skip": "yes"}, {"Name": "c", "Skip": "no"},
        {"Name": "stop", "Skip": "no"}, {"Name": "d", "Skip": "no"},
    ]
    body = [
        step("control.if", {"condition": {"rules": [{"left": '{{row["Skip"]}}', "op": "equals", "right": "yes"}]}},
             blocks={"then": [step("control.continue")]}),
        step("control.if", {"condition": {"rules": [{"left": '{{row["Name"]}}', "op": "equals", "right": "stop"}]}},
             blocks={"then": [step("control.break")]}),
        step("control.add_to_list", {"variable": "seen", "value": '{{row["Name"]}}'}),
    ]
    result = h.run(
        [step("control.for_each", {"items": "{{rows}}", "item_variable": "row", "index_variable": "n"},
              blocks={"body": body})],
        variables=[{"name": "rows", "type": "table", "is_input": True}, {"name": "seen", "type": "list"}],
        inputs={"rows": rows},
    )
    assert result.status == "succeeded"
    assert isinstance(h.vars["rows"], Table)
    assert h.vars["seen"] == ["a", "c"]
    assert h.vars["n"] == 4


def test_repeat_and_while(h):
    h.run([
        step("control.set_variable", {"variable": "total", "value": 0}),
        step("control.repeat", {"times": 4}, blocks={"body": [step("control.increase", {"variable": "total", "by": 2})]}),
        step("control.while", {"condition": {"rules": [{"left": "{{total}}", "op": "less", "right": 20}]}},
             blocks={"body": [step("control.increase", {"variable": "total", "by": 5})]}),
    ])
    assert h.vars["total"] == 23


def test_while_safety_limit(h):
    result = h.run([
        step("control.while", {"condition": {"expression": "{{true}}"}, "max_iterations": 5},
             blocks={"body": [step("control.comment")]}, id="loop"),
    ])
    assert result.status == "failed"
    assert "more than 5 times" in result.error["message"]
    assert result.error["step_id"] == "loop"


def test_retry_then_fail_with_friendly_error(h):
    result = h.run([step("files.read_text", {"file": str(h.tmp_path / "missing.txt")},
                         on_error={"retries": 2, "retry_delay": 0}, id="read")])
    assert result.status == "failed"
    assert result.error["step_id"] == "read"
    assert "does not exist" in result.error["message"]
    assert result.error["hint"]
    assert sum("Retrying" in m for m in h.logs()) == 2


def test_continue_on_error(h):
    result = h.run([
        step("control.fail", {"message": "boom"}, on_error={"action": "continue"}),
        step("control.set_variable", {"variable": "after", "value": "yes"}),
    ])
    assert result.status == "succeeded"
    assert h.vars["after"] == "yes"
    finished = h.of("step_finished")
    assert finished[0]["status"] == "failed" and finished[0]["continued"]


def test_try_catch_finally(h):
    result = h.run([
        step("control.try", {}, blocks={
            "try": [step("control.fail", {"message": "Invoice {{n}} has no total"}),
                    step("control.set_variable", {"variable": "not_reached", "value": 1})],
            "catch": [step("control.set_variable", {"variable": "handled", "value": "{{error}}"})],
            "finally": [step("control.set_variable", {"variable": "cleanup", "value": True})],
        }),
    ], variables=[{"name": "n", "default": 42}])
    assert result.status == "succeeded"
    assert h.vars["handled"] == "Invoice 42 has no total"
    assert h.vars["cleanup"] is True
    assert "not_reached" not in h.vars


def test_child_failure_does_not_retry_parent_loop(h):
    result = h.run([
        step("control.repeat", {"times": 3}, on_error={"retries": 3, "retry_delay": 0}, blocks={"body": [
            step("control.increase", {"variable": "attempts"}),
            step("control.fail", {"message": "child failed"}),
        ]}),
    ], variables=[{"name": "attempts", "default": 0}])
    assert result.status == "failed"
    assert h.vars["attempts"] == 1


def test_stop_flow(h):
    ok = h.run([step("control.stop", {"outcome": "succeeded", "message": "Nothing to do"}),
                step("control.set_variable", {"variable": "x", "value": 1})])
    assert ok.status == "succeeded" and "x" not in h.vars
    bad = h.run([step("control.stop", {"outcome": "failed", "message": "No invoices today"})])
    assert bad.status == "failed" and bad.error["message"] == "No invoices today"


def test_missing_required_setting_is_friendly(h):
    result = h.run([step("control.log", {})])
    assert result.status == "failed"
    assert "'message' is required" in result.error["message"]


def test_unknown_activity(h):
    result = h.run([step("nope.unknown")])
    assert result.status == "failed"
    assert "Unknown step type" in result.error["message"]


def test_disabled_steps_are_skipped(h):
    h.run([step("control.set_variable", {"variable": "x", "value": 1}, disabled=True)])
    assert "x" not in h.vars


def test_events_sequence(h):
    h.run([step("control.log", {"message": "hi"}, id="a")])
    kinds = [e["event"] for e in h.events]
    assert kinds[0] == "run_started" and kinds[-1] == "run_finished"
    started = h.of("step_started")[0]
    assert started["step_id"] == "a" and started["activity"] == "control.log"
    assert h.of("log")[0]["step_id"] == "a"


def test_secrets_are_masked_everywhere(h):
    creds = {"portal": Credential("portal", "robot", "S3cretPass!")}
    result = h.run([
        step("control.get_credential", {"credential": "portal"}, outputs={"credential": "login"}),
        step("control.log", {"message": "Logging in as {{login.username}} with {{login.password}}"}),
    ], credentials=lambda name: creds[name])
    assert result.status == "succeeded"
    text = str(h.events)
    assert "S3cretPass!" not in text
    assert "Logging in as robot with ••••••" in h.logs()


def test_cancel_running_flow(h):
    control = RunControl()
    threading.Timer(0.3, control.cancel).start()
    started = time.monotonic()
    result = h.run([step("control.wait", {"seconds": 30})], control=control)
    assert result.status == "cancelled"
    assert time.monotonic() - started < 5


def test_breakpoint_pause_and_step(h):
    control = RunControl(breakpoints={"b"})
    done = threading.Event()
    results = []

    def run():
        results.append(h.run([
            step("control.set_variable", {"variable": "x", "value": 1}, id="a"),
            step("control.set_variable", {"variable": "x", "value": 2}, id="b"),
            step("control.set_variable", {"variable": "x", "value": 3}, id="c"),
        ], control=control))
        done.set()

    threading.Thread(target=run).start()
    _wait_for(lambda: control.paused)
    assert h.vars["x"] == 1                     # paused before step b
    assert h.of("paused")[-1]["reason"] == "breakpoint"
    control.step()                              # run b only
    _wait_for(lambda: control.paused and h.vars["x"] == 2)
    assert h.of("paused")[-1]["step_id"] == "c"
    control.resume()
    assert done.wait(5)
    assert results[0].status == "succeeded" and h.vars["x"] == 3


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition not reached")


def _run_in_thread(h, steps):
    import threading

    from autoflow_engine.runtime.context import RunControl

    control = RunControl()
    box: dict = {}
    thread = threading.Thread(target=lambda: box.update(result=h.run(steps, control=control)), daemon=True)
    thread.start()
    return control, thread, box


def _wait_for_event(h, kind, timeout=10):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(e["event"] == kind for e in list(h.events)):
            return
        time.sleep(0.05)
    raise AssertionError(f"no {kind} event")


def test_stop_ends_a_step_that_is_waiting(h, tmp_path):
    """Stop must not wait for a step's time limit (looking for a window or file can take minutes)."""
    import time

    control, thread, box = _run_in_thread(h, [
        step("files.wait_for_file", {"folder": str(tmp_path), "pattern": "never.txt", "timeout": 120}),
    ])
    _wait_for_event(h, "step_started")
    time.sleep(0.5)
    stopped_at = time.monotonic()
    control.cancel()
    thread.join(5)
    assert box["result"].status == "cancelled"
    assert time.monotonic() - stopped_at < 2


def test_pause_happens_inside_a_wait_and_paused_time_does_not_count(h, tmp_path):
    import time

    control, thread, box = _run_in_thread(h, [
        step("files.wait_for_file", {"folder": str(tmp_path), "pattern": "late.txt", "timeout": 2}, id="w"),
    ])
    _wait_for_event(h, "step_started")
    time.sleep(0.5)
    control.pause()
    _wait_for_event(h, "paused")
    assert [e["step_id"] for e in h.events if e["event"] == "paused"] == ["w"]
    time.sleep(3)  # longer than the step's 2-second limit
    control.resume()
    _wait_for_event(h, "resumed")
    time.sleep(0.5)
    (tmp_path / "late.txt").write_text("here")  # within the limit once the paused time is left out
    thread.join(10)
    assert box["result"].status == "succeeded", box["result"].error
