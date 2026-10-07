"""Browser activities against the demo portal in testbed/portal (headless Edge or Chromium)."""

from __future__ import annotations

import functools
import http.server
import shutil
import threading
from pathlib import Path

import pytest
from conftest import step
from openpyxl import Workbook, load_workbook

from autoflow_engine.flow import Flow
from autoflow_engine.runtime.context import RunOptions
from autoflow_engine.runtime.interpreter import FlowRunner
from autoflow_engine.values import Credential

PORTAL = Path(__file__).resolve().parents[2] / "testbed" / "portal"
BROWSER = "edge" if shutil.which("msedge") or Path(
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").exists() else "chromium"

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def portal_url():
    handler = functools.partial(_QuietHandler, directory=str(PORTAL))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/index.html"
    server.shutdown()


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


ELEMENTS = [
    {"id": "user", "name": "Username box", "kind": "web",
     "selectors": [{"strategy": "label", "value": "Username"}, {"strategy": "css", "value": "#username"}]},
    {"id": "pass", "name": "Password box", "kind": "web",
     "selectors": [{"strategy": "label", "value": "Password"}]},
    {"id": "signin", "name": "Sign in button", "kind": "web",
     "selectors": [{"strategy": "role", "value": "button", "options": {"name": "Sign in"}}]},
    {"id": "invoice", "name": "Invoice number box", "kind": "web",
     # First selector is deliberately stale, to exercise the fallback.
     "selectors": [{"strategy": "css", "value": "#old-invoice-field"}, {"strategy": "label", "value": "Invoice number"}]},
    {"id": "customer", "name": "Customer box", "kind": "web", "selectors": [{"strategy": "label", "value": "Customer"}]},
    {"id": "amount", "name": "Amount box", "kind": "web", "selectors": [{"strategy": "label", "value": "Amount"}]},
    {"id": "currency", "name": "Currency list", "kind": "web", "selectors": [{"strategy": "label", "value": "Currency"}]},
    {"id": "urgent", "name": "Urgent checkbox", "kind": "web", "selectors": [{"strategy": "label", "value": "Urgent"}]},
    {"id": "submit", "name": "Submit invoice button", "kind": "web",
     "selectors": [{"strategy": "role", "value": "button", "options": {"name": "Submit invoice"}}]},
    {"id": "reference", "name": "Reference number", "kind": "web", "selectors": [{"strategy": "css", "value": "#reference"}]},
    {"id": "reports_link", "name": "Reports link", "kind": "web",
     "selectors": [{"strategy": "role", "value": "link", "options": {"name": "Reports"}}]},
    {"id": "table", "name": "Invoices table", "kind": "web", "selectors": [{"strategy": "css", "value": "#invoices-table"}]},
    {"id": "download", "name": "Download report button", "kind": "web",
     "selectors": [{"strategy": "text", "value": "Download CSV report"}]},
    {"id": "error", "name": "Login error", "kind": "web", "selectors": [{"strategy": "css", "value": "#login-error"}]},
]


def run_flow(tmp_path, steps, variables=None, credentials=None):
    events: list[dict] = []
    flow = Flow.model_validate({"id": "f", "name": "f", "elements": ELEMENTS, "steps": steps,
                                "variables": variables or [], "settings": {"default_timeout": 10}})
    options = RunOptions(work_dir=tmp_path / "run", headless=True, credentials=credentials)
    runner = FlowRunner(flow, options, events.append)
    return runner.run(), events, runner.ctx.variables


def test_excel_to_portal_entry_scenario(tmp_path, portal_url):
    xlsx = tmp_path / "invoices.xlsx"
    wb = Workbook()
    wb.active.append(["Invoice No", "Customer", "Amount", "Currency"])
    wb.active.append(["INV-501", "Acme", 1500.25, "USD"])
    wb.active.append(["INV-502", "Initech", 99, "EGP"])
    wb.save(xlsx)
    downloads = tmp_path / "downloads"

    creds = {"portal": Credential("portal", "robot", "demo123")}
    result, events, variables = run_flow(tmp_path, [
        step("excel.read", {"file": str(xlsx)}, outputs={"table": "invoices"}),
        step("control.get_credential", {"credential": "portal"}, outputs={"credential": "login"}),
        step("browser.open", {"url": portal_url, "browser": BROWSER}),
        step("browser.type", {"element": "user", "text": "{{login.username}}"}),
        step("browser.type", {"element": "pass", "text": "{{login.password}}", "press_enter": True}),
        step("control.for_each", {"items": "{{invoices}}", "item_variable": "row", "index_variable": "n"}, blocks={"body": [
            step("browser.type", {"element": "invoice", "text": '{{row["Invoice No"]}}'}),
            step("browser.type", {"element": "customer", "text": '{{row["Customer"]}}'}),
            step("browser.type", {"element": "amount", "text": '{{row["Amount"]}}'}),
            step("browser.select", {"element": "currency", "option": '{{row["Currency"]}}'}),
            step("browser.check", {"element": "urgent", "checked": True}),
            step("browser.click", {"element": "submit"}),
            step("browser.wait_for", {"element": "reference"}),
            step("browser.get_text", {"element": "reference"}, outputs={"text": "ref"}),
            step("excel.update_row", {"file": str(xlsx), "row_number": "{{n}}", "values": {"Reference": "{{ref}}"}}),
        ]}),
        step("browser.click", {"element": "reports_link"}),
        step("browser.extract_table", {"element": "table"}, outputs={"table": "portal_rows"}),
        step("browser.download", {"element": "download", "folder": str(downloads)}, outputs={"file": "report"}),
        step("files.read_csv", {"file": "{{report}}"}, outputs={"table": "report_rows"}),
        step("browser.close"),
    ], credentials=lambda name: creds[name])

    assert result.status == "succeeded", result.error
    ws = load_workbook(xlsx).active
    assert [ws["E1"].value, ws["E2"].value, ws["E3"].value] == ["Reference", "REF-1003", "REF-1004"]
    assert len(variables["portal_rows"]) == 4
    assert variables["portal_rows"].rows[-1]["Invoice"] == "INV-502"
    assert variables["report_rows"].rows[2]["Amount"] == "1500.25"
    assert Path(variables["report"]).name == "invoices-report.csv"
    logs = [e["message"] for e in events if e["event"] == "log"]
    assert any("backup method" in m for m in logs)  # stale first selector fell back to the label
    assert "demo123" not in str(events)


def test_missing_element_fails_with_screenshot(tmp_path, portal_url):
    result, events, _ = run_flow(tmp_path, [
        step("browser.open", {"url": portal_url, "browser": BROWSER}),
        step("browser.click", {"selector": "#does-not-exist", "timeout": 1}, id="bad"),
    ])
    assert result.status == "failed"
    assert result.error["step_id"] == "bad"
    assert "Couldn't find" in result.error["message"]
    shots = [e for e in events if e["event"] == "screenshot"]
    assert shots and Path(shots[0]["path"]).exists()


def test_element_exists_and_wait_for_disappear(tmp_path, portal_url):
    result, _events, variables = run_flow(tmp_path, [
        step("browser.open", {"url": portal_url, "browser": BROWSER}),
        step("browser.element_exists", {"element": "error"}, outputs={"exists": "error_before"}),
        step("browser.type", {"element": "user", "text": "wrong"}),
        step("browser.click", {"element": "signin"}),
        step("browser.element_exists", {"element": "error"}, outputs={"exists": "error_after"}),
        step("browser.page_info", outputs={"title": "title"}),
    ])
    assert result.status == "succeeded", result.error
    assert variables["error_before"] is False
    assert variables["error_after"] is True
    assert variables["title"] == "Demo Vendor Portal"
