"""Element picker and recorder, driven like a user in a headless design browser."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from autoflow_engine.design.session import DesignSession
from autoflow_engine.flow import Element
from autoflow_engine.selectors.web import find

pytestmark = pytest.mark.browser


class Answer:
    def __init__(self):
        self.done = threading.Event()
        self.result: Any = None
        self.error: BaseException | None = None

    def __call__(self, result: Any = None, error: BaseException | None = None):
        self.result, self.error = result, error
        self.done.set()

    def get(self, timeout: float = 20) -> Any:
        assert self.done.wait(timeout), "no answer in time"
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def session():
    notes: list[tuple[str, dict]] = []
    s = DesignSession(lambda method, params: notes.append((method, params)), headless=True)
    s.notes = notes
    yield s
    s.close()


def test_pick_element_builds_verified_selectors(session, portal_url):
    answer = Answer()
    session.pick(portal_url, answer)
    session.run(lambda page: page.wait_for_selector("#username")).result(15)
    _wait_for(lambda: session.mode == "pick")
    session.run(lambda page: page.click("#password")).result(10)
    element = Element.model_validate(answer.get())

    assert element.name == "Password box"
    strategies = [s.strategy for s in element.selectors]
    assert strategies[0] == "label" and "css" in strategies
    assert element.screenshot and element.screenshot.startswith("data:image/png;base64,")
    assert element.context["url"].startswith(portal_url.split("/index")[0])
    # Picking swallowed the click: the field did not get focus from the page's point of view.
    assert session.mode == "off"
    # Every saved selector finds exactly this element.
    found = session.run(lambda page: find(page, element, timeout=2).locator.get_attribute("id")).result(10)
    assert found == "password"


def test_pick_cancel_with_escape(session, portal_url):
    answer = Answer()
    session.pick(portal_url, answer)
    _wait_for(lambda: session.mode == "pick")
    session.run(lambda page: page.keyboard.press("Escape")).result(10)
    assert answer.get() is None


def test_record_login_and_invoice_entry(session, portal_url):
    started = Answer()
    session.record_start(portal_url, started)
    started.get()

    def act(page):
        page.click("#username")
        page.keyboard.type("robot")
        page.click("#password")
        page.keyboard.type("demo123")
        page.keyboard.press("Enter")
        page.wait_for_selector("#invoice-no")
        page.click("#invoice-no")
        page.keyboard.type("INV-9")
        page.select_option("#currency", "USD")
        page.click("#urgent")
        page.click("text=Submit invoice")

    session.run(act).result(20)
    _wait_for(lambda: sum(1 for m, _ in session.notes if m == "recorder.action") >= 6)
    stopped = Answer()
    session.record_stop(stopped)
    actions = stopped.get()["actions"]

    kinds = [(a["action"], a["element"]["name"] if "element" in a else None) for a in actions]
    assert kinds == [
        ("type", "Username box"),
        ("type", "Password box"),
        ("type", "Invoice number box"),
        ("select", "Currency list"),
        ("check", "Urgent checkbox"),
        ("click", "Submit invoice button"),
    ]
    assert actions[0]["value"] == "robot"
    assert actions[1]["value"] is None and actions[1]["password"] and actions[1]["press_enter"]
    assert actions[3]["option"] == "US Dollar"
    assert actions[4]["checked"] is True
    assert "demo123" not in str(actions)


def _wait_for(predicate, timeout=10.0):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition not reached")


def test_rpc_pick_answers_later_while_other_requests_work(portal_url, monkeypatch):
    """picker.web replies only after the click; ping is answered meanwhile."""
    import io
    import json
    import os
    import time

    from autoflow_engine.rpc.server import EngineServer

    monkeypatch.setitem(os.environ, "AUTOFLOW_DESIGN_HEADLESS", "1")
    r_fd, w_fd = os.pipe()
    reader = os.fdopen(r_fd, "r", encoding="utf-8")
    to_server = os.fdopen(w_fd, "w", encoding="utf-8")
    out = io.StringIO()
    server = EngineServer(reader, out)
    thread = threading.Thread(target=server.serve, daemon=True)
    thread.start()

    def send(msg):
        to_server.write(json.dumps(msg) + "\n")
        to_server.flush()

    def replies():
        return {m["id"]: m for m in map(json.loads, out.getvalue().splitlines()) if "id" in m}

    send({"jsonrpc": "2.0", "id": 1, "method": "picker.web", "params": {"url": portal_url}})
    _wait_for(lambda: server._design is not None and server._design.mode == "pick", timeout=20)
    send({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    _wait_for(lambda: 2 in replies())
    assert 1 not in replies()  # still waiting for the user
    server.design.run(lambda page: page.get_by_role("button", name="Sign in").click()).result(10)
    _wait_for(lambda: 1 in replies(), timeout=20)
    element = replies()[1]["result"]
    assert element["name"] == "Sign in button"
    assert element["selectors"][0] == {"strategy": "role", "value": "button", "options": {"name": "Sign in"}}
    to_server.close()
    thread.join(10)
    time.sleep(0.1)
