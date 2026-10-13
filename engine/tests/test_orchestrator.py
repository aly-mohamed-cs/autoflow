"""Release F: shared values and queue steps, against a stand-in for the Orchestrator."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from conftest import step

from autoflow_engine.errors import ActivityError


class FakeOrchestrator:
    """Answers like the server's /api/run/orchestrator (apps/server/src/routes/assets.ts)."""

    def __init__(self) -> None:
        self.assets: dict[str, dict[str, Any]] = {
            "Portal address": {"kind": "text", "value": "https://vendors.example"},
            "Limit": {"kind": "number", "value": 250},
            "Prices": {"kind": "file", "value": None, "fileName": "prices.csv",
                       "content": base64.b64encode(b"item,price\nA,1\n").decode()},
        }
        self.items: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(request)
        op = request["op"]
        if op == "asset.get":
            if request["name"] not in self.assets:
                raise ActivityError(f"There is no shared value called {request['name']}.")
            return self.assets[request["name"]]
        if op == "queue.add":
            item = {"id": f"qi_{len(self.items) + 1}", "queue": request["queue"], "reference": request["reference"],
                    "data": request["data"], "status": "new", "attempts": 0}
            self.items.append(item)
            return {"id": item["id"]}
        if op == "queue.next":
            item = next((i for i in self.items if i["queue"] == request["queue"] and i["status"] == "new"), None)
            if item is None:
                return {"item": None}
            item["status"], item["attempts"] = "in_progress", item["attempts"] + 1
            return {"item": {"id": item["id"], "reference": item["reference"], "data": item["data"]}}
        if op == "queue.finish":
            item = next(i for i in self.items if i["id"] == request["item"])
            retry = "new" if item["attempts"] < 2 else "failed"
            item["status"] = {"done": "done", "retry": retry}.get(request["outcome"], "failed")
            item["result"], item["error"] = request.get("result"), request.get("message")
            return {"ok": True}
        if op == "queue.count":
            return {"count": sum(1 for i in self.items if i["queue"] == request["queue"]
                                 and request["status"] in ("all", i["status"]))}
        raise AssertionError(op)


def test_shared_values_text_number_and_file(h):
    orch = FakeOrchestrator()
    result = h.run([
        step("assets.get", {"name": "Portal address"}, outputs={"value": "portal"}),
        step("assets.get", {"name": "Limit"}, outputs={"value": "limit"}),
        step("assets.get", {"name": "Prices"}, outputs={"value": "prices"}),
    ], orchestrator=orch)
    assert result.status == "succeeded", result.error
    assert h.vars["portal"] == "https://vendors.example"
    assert h.vars["limit"] == 250
    assert Path(h.vars["prices"]).name == "prices.csv"
    assert Path(h.vars["prices"]).read_bytes() == b"item,price\nA,1\n"

    result = h.run([step("assets.get", {"name": "Nope"})], orchestrator=orch)
    assert result.status == "failed" and "Nope" in result.error["message"]


def test_without_an_orchestrator_the_step_says_how_to_connect(h):
    result = h.run([step("assets.get", {"name": "Limit"})])
    assert result.status == "failed"
    assert "Orchestrator is not available" in result.error["message"]
    assert "Settings" in result.error["hint"]


def test_fill_a_queue_from_a_table_then_work_through_it(h):
    orch = FakeOrchestrator()
    rows = [{"Invoice": "INV-1", "Amount": 10}, {"Invoice": "INV-2", "Amount": -5}, {"Invoice": "INV-3", "Amount": 7}]
    # Producer: one item per row, the invoice number as reference.
    result = h.run([
        step("control.for_each", {"items": "{{rows}}", "item_variable": "row"}, blocks={"body": [
            step("queue.add", {"queue": "Invoices", "row": "{{row}}", "values": {"Source": "mail"},
                               "reference": '{{row["Invoice"]}}'}),
        ]}),
        step("queue.count", {"queue": "Invoices"}, outputs={"count": "waiting"}),
    ], variables=[{"name": "rows", "default": rows}], orchestrator=orch)
    assert result.status == "succeeded", result.error
    assert h.vars["waiting"] == 3
    assert orch.items[0]["data"] == {"Invoice": "INV-1", "Amount": 10, "Source": "mail"}
    assert orch.items[0]["reference"] == "INV-1"

    # Worker: a negative amount fails the item; the loop goes on with the next one.
    result = h.run([
        step("queue.for_each", {"queue": "Invoices", "on_failure": "failed"}, blocks={"body": [
            step("control.if", {"condition": '{{queue_item["Amount"]}} < 0'}, blocks={"then": [
                step("control.fail", {"message": "Negative amount on {{queue_item_reference}}"}),
            ]}),
            step("control.log", {"message": "Entered {{queue_item_reference}}"}),
        ]}),
    ], orchestrator=orch)
    assert result.status == "succeeded", result.error
    assert [i["status"] for i in orch.items] == ["done", "failed", "done"]
    assert orch.items[1]["error"] == "Negative amount on INV-2"
    assert "Entered INV-3" in h.logs()
    assert "Worked on 3 item(s) of the queue 'Invoices'." in h.logs()


def test_get_next_and_finish_by_hand(h):
    orch = FakeOrchestrator()
    orch({"op": "queue.add", "queue": "Q", "reference": "A", "data": {"n": 1}})
    result = h.run([
        step("queue.next", {"queue": "Q"}, outputs={"item": "it", "found": "got", "reference": "ref"}),
        step("queue.finish", {"outcome": "done", "result": {"Booked": "yes"}}),
        step("queue.next", {"queue": "Q"}, outputs={"found": "again"}),
    ], orchestrator=orch)
    assert result.status == "succeeded", result.error
    assert (h.vars["it"], h.vars["got"], h.vars["ref"], h.vars["again"]) == ({"n": 1}, True, "A", False)
    assert orch.items[0]["status"] == "done" and orch.items[0]["result"] == {"Booked": "yes"}

    result = h.run([step("queue.finish", {})], orchestrator=orch)
    assert result.status == "failed" and "no queue item to finish" in result.error["message"]


def test_a_failing_item_can_go_back_to_the_queue_or_stop_the_run(h):
    orch = FakeOrchestrator()
    orch({"op": "queue.add", "queue": "Q", "reference": "A", "data": {}})
    body = {"body": [step("control.fail", {"message": "portal down"})]}
    result = h.run([step("queue.for_each", {"queue": "Q", "max_items": 1}, blocks=body)], orchestrator=orch)
    assert result.status == "succeeded"
    assert orch.items[0]["status"] == "new"  # tried again later

    result = h.run([step("queue.for_each", {"queue": "Q", "on_failure": "stop"}, blocks=body)], orchestrator=orch)
    assert result.status == "failed" and result.error["message"] == "portal down"
    assert orch.items[0]["status"] == "failed"
