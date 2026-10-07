"""PDF, web service, database and email (SMTP) activities."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from conftest import step

from autoflow_engine.values import Credential, Table

SAMPLES = Path(__file__).resolve().parents[2] / "testbed" / "samples"
INVOICE = SAMPLES / "invoice-INV-2026-0042.pdf"


@pytest.fixture(scope="module", autouse=True)
def samples():
    if not INVOICE.exists():
        import runpy

        runpy.run_path(str(SAMPLES.parent / "make_samples.py"), run_name="__main__")


def test_invoice_pdf_scenario(h, tmp_path):
    """Scenario 3 shape: read fields and line items from an invoice PDF, write them to Excel."""
    out = tmp_path / "invoices.xlsx"
    result = h.run([
        step("pdf.extract_fields", {"file": str(INVOICE), "fields": [
            {"name": "Number", "after": "Invoice No:"},
            {"name": "Date", "after": "Invoice Date:", "find": "date"},
            {"name": "Customer", "after": "Customer:"},
            {"name": "Total", "after": "Total due:", "find": "number"},
            {"name": "PO", "after": "PO number:"},
        ]}, outputs={"fields": "invoice"}),
        step("pdf.extract_tables", {"file": str(INVOICE)}, outputs={"table": "items"}),
        step("data.add_column", {"table": "{{items}}", "column": "Invoice", "value": '{{invoice["Number"]}}'},
             outputs={"table": "items"}),
        step("excel.write_table", {"table": "{{items}}", "file": str(out), "sheet": "Items"}),
        step("pdf.page_count", {"file": str(INVOICE)}, outputs={"count": "pages"}),
    ])
    assert result.status == "succeeded", result.error
    invoice = h.vars["invoice"]
    assert invoice == {"Number": "INV-2026-0042", "Date": "15/03/2026", "Customer": "Globex Corporation",
                       "Total": 9599.5, "PO": None}
    assert any("Not found in the PDF: PO" in m for m in h.logs())
    items: Table = h.vars["items"]
    assert items.columns == ["Description", "Qty", "Unit price", "Amount", "Invoice"]
    assert [r["Description"] for r in items] == ["Printer paper A4 (box)", "Toner cartridge", "Desk lamp"]
    assert h.vars["pages"] == 1
    assert out.exists()


def test_pdf_merge_split_and_text(h, tmp_path):
    files = sorted(str(p) for p in SAMPLES.glob("invoice-*.pdf"))
    result = h.run([
        step("pdf.merge", {"files": files, "output": str(tmp_path / "all.pdf")}, outputs={"file": "merged"}),
        step("pdf.page_count", {"file": "{{merged}}"}, outputs={"count": "pages"}),
        step("pdf.split", {"file": "{{merged}}", "folder": str(tmp_path / "pages")}, outputs={"files": "parts"}),
        step("pdf.read_text", {"file": '{{parts[1]}}'}, outputs={"text": "second"}),
        step("text.extract_between", {"text": "{{second}}", "after": "Invoice No:"}, outputs={"result": "no"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["pages"] == len(files) == 2
    assert h.vars["no"] == "INV-2026-0043"


def test_pdf_missing_file_is_friendly(h, tmp_path):
    result = h.run([step("pdf.read_text", {"file": str(tmp_path / "none.pdf")})])
    assert result.status == "failed" and "does not exist" in result.error["message"]


class _Api(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/orders"):
            body = json.dumps([{"id": 1, "status": "open"}, {"id": 2, "status": "paid"}])
            self.send_response(200)
        else:
            body = json.dumps({"error": "nope"})
            self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        data = json.loads(self.rfile.read(length))
        auth = self.headers.get("Authorization", "")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"received": data, "auth": auth.split(" ")[0]}).encode())


@pytest.fixture
def api_url():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_http_requests(h, api_url):
    creds = {"api": Credential("api", "svc", "pw")}
    result = h.run([
        step("http.request", {"url": f"{api_url}/orders", "query": {"status": "all"}},
             outputs={"response": "orders", "status": "code"}),
        step("http.request", {"method": "POST", "url": f"{api_url}/orders",
                              "body": '{"customer": "{{who}}"}', "credential": "api"},
             outputs={"response": "created"}),
        step("http.request", {"url": f"{api_url}/missing", "fail_on_error": False}, outputs={"status": "missing"}),
    ], variables=[{"name": "who", "default": "Acme"}], credentials=lambda n: creds[n])
    assert result.status == "succeeded", result.error
    assert isinstance(h.vars["orders"], Table) and len(h.vars["orders"]) == 2
    assert h.vars["code"] == 200
    assert h.vars["created"] == {"received": {"customer": "Acme"}, "auth": "Basic"}
    assert h.vars["missing"] == 404
    failing = h.run([step("http.request", {"url": f"{api_url}/missing"})])
    assert failing.status == "failed" and "404" in failing.error["message"]


def test_database_query_and_execute(h, tmp_path):
    db = f"sqlite:///{(tmp_path / 'shop.db').as_posix()}"
    result = h.run([
        step("db.execute", {"connection": db, "sql": "CREATE TABLE orders (id INTEGER, customer TEXT, total REAL)"}),
        step("db.execute", {"connection": db, "sql": "INSERT INTO orders VALUES (1, 'Acme', 10.5), (2, 'Globex', 99)"},
             outputs={"count": "inserted"}),
        step("db.query", {"connection": db, "sql": "SELECT * FROM orders WHERE total > :min ORDER BY id",
                          "parameters": {"min": 20}}, outputs={"table": "big"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["inserted"] == 2
    assert h.vars["big"].rows == [{"id": 2, "customer": "Globex", "total": 99.0}]
    bad = h.run([step("db.query", {"connection": db, "sql": "SELECT * FROM nope"})])
    assert bad.status == "failed" and "no such table" in bad.error["message"]


def test_send_email_via_smtp(h, tmp_path):
    from aiosmtpd.controller import Controller

    received = []

    class Handler:
        async def handle_DATA(self, server, session, envelope):  # noqa: N802 - aiosmtpd API
            received.append(envelope)
            return "250 OK"

    import socket

    with socket.socket() as probe:  # aiosmtpd's start-up check can't use port 0
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    controller = Controller(Handler(), hostname="127.0.0.1", port=port)
    controller.start()
    try:
        report = tmp_path / "report.csv"
        report.write_text("a,b\n1,2\n")
        result = h.run([step("email.send", {
            "via": "smtp", "server": "127.0.0.1", "port": port, "sender": "robot@company.local",
            "to": "boss@company.local; team@company.local", "subject": "Daily report {{day}}",
            "body": "Hello,\nthe report is attached.", "attachments": [str(report)],
        })], variables=[{"name": "day", "default": "2026-03-15"}])
        assert result.status == "succeeded", result.error
        assert len(received) == 1
        envelope = received[0]
        assert envelope.rcpt_tos == ["boss@company.local", "team@company.local"]
        text = envelope.content.decode()
        assert "Subject: Daily report 2026-03-15" in text and 'filename="report.csv"' in text
    finally:
        controller.stop()
