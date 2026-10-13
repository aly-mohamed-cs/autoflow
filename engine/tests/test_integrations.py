"""Release E: answering emails, chat messages, FTP transfers (SFTP / SSH need a real server:
set AUTOFLOW_SSH_TEST=host,user,password to run those)."""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from conftest import step

from autoflow_engine.flow import Flow
from autoflow_engine.runtime.context import RunOptions
from autoflow_engine.runtime.interpreter import FlowRunner
from autoflow_engine.values import Credential


class FakeEmail:
    """Stands in for an exchangelib message read by 'Read emails'."""

    def __init__(self) -> None:
        self.subject, self.is_read, self.calls = "Invoice 42", False, []

    def reply(self, **kw):
        self.calls.append(("reply", kw))

    def reply_all(self, **kw):
        self.calls.append(("reply_all", kw))

    def forward(self, **kw):
        self.calls.append(("forward", kw))

    def move_to_trash(self):
        self.calls.append(("trash", {}))

    def save(self, update_fields):
        self.calls.append(("save", {"is_read": self.is_read, "fields": update_fields}))


def test_answering_emails(tmp_path):
    message = FakeEmail()
    steps = [
        step("email.reply", {"message": "{{mail}}", "body": "Thanks, received."}),
        step("email.reply", {"message": "{{mail}}", "body": "All", "everyone": True}),
        step("email.forward", {"message": "{{mail}}", "to": "ap@company.com; boss@company.com"}),
        step("email.mark", {"message": "{{mail}}", "action": "read"}),
        step("email.mark", {"message": "{{mail}}", "action": "delete"}),
    ]
    flow = Flow.model_validate({"id": "e", "name": "e", "steps": steps,
                                "variables": [{"name": "mail", "default": {"id": "m1"}}]})
    runner = FlowRunner(flow, RunOptions(work_dir=tmp_path), lambda e: None)
    runner.ctx.resources["ews_messages"] = {"m1": message}
    result = runner.run()
    assert result.status == "succeeded", result.error
    kinds = [c[0] for c in message.calls]
    assert kinds == ["reply", "reply_all", "forward", "save", "trash"]
    assert message.calls[0][1] == {"subject": "RE: Invoice 42", "body": "Thanks, received."}
    assert message.calls[2][1]["to_recipients"] == ["ap@company.com", "boss@company.com"]
    assert message.is_read is True


def test_chat_messages_to_teams_and_slack(h):
    received: list[dict] = []

    class Hook(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/hook"
    try:
        result = h.run([
            step("web.chat_message", {"service": "teams", "webhook": "hook", "title": "Done", "message": "3 invoices"}),
            step("web.chat_message", {"service": "slack", "webhook": "hook", "message": "Hello"}),
        ], credentials={"hook": Credential("hook", "", url)}.__getitem__)
    finally:
        server.shutdown()
    assert result.status == "succeeded", result.error
    card = received[0]["attachments"][0]["content"]
    assert [b["text"] for b in card["body"]] == ["Done", "3 invoices"]
    assert received[1] == {"text": "Hello"}


@pytest.fixture
def ftp_server(tmp_path):
    from pyftpdlib.authorizers import DummyAuthorizer
    from pyftpdlib.handlers import FTPHandler
    from pyftpdlib.servers import FTPServer

    root = tmp_path / "server"
    (root / "outgoing").mkdir(parents=True)
    (root / "outgoing" / "orders-1.csv").write_text("a,b\n1,2\n")
    (root / "outgoing" / "notes.txt").write_text("x")
    authorizer = DummyAuthorizer()
    authorizer.add_user("robot", "s3cret", str(root), perm="elradfmw")
    handler = type("Handler", (FTPHandler,), {"authorizer": authorizer})
    server = FTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"timeout": 0.2}, daemon=True)
    thread.start()
    yield server.address[1], root
    server.close_all()


def test_ftp_transfers(h, tmp_path, ftp_server):
    port, root = ftp_server
    common = {"protocol": "ftp", "host": "127.0.0.1", "port": port, "credential": "ftp"}
    upload = tmp_path / "invoice.pdf"
    upload.write_bytes(b"%PDF-1.4 test")
    result = h.run([
        step("ftp.list", {**common, "folder": "/outgoing", "pattern": "*.csv"}, outputs={"files": "csvs"}),
        step("ftp.download", {**common, "folder": "/outgoing", "pattern": "*.csv", "to_folder": str(tmp_path / "in"),
                              "delete_after": True}, outputs={"files": "got"}),
        step("ftp.upload", {**common, "files": str(upload), "folder": "/outgoing"}),
        step("ftp.delete", {**common, "file": "/outgoing/notes.txt"}),
    ], credentials={"ftp": Credential("ftp", "robot", "s3cret")}.__getitem__)
    assert result.status == "succeeded", result.error
    assert h.vars["csvs"] == ["orders-1.csv"]
    assert Path(h.vars["got"][0]).read_text() == "a,b\n1,2\n"
    assert sorted(p.name for p in (root / "outgoing").iterdir()) == ["invoice.pdf"]

    result = h.run([step("ftp.list", common)], credentials={"ftp": Credential("ftp", "robot", "wrong")}.__getitem__)
    assert result.status == "failed" and "refused" in result.error["message"]


ssh = os.environ.get("AUTOFLOW_SSH_TEST")


@pytest.mark.skipif(not ssh, reason="needs an SSH server (AUTOFLOW_SSH_TEST=host,user,password)")
def test_ssh_and_sftp(h, tmp_path):
    host, user, password = ssh.split(",", 2)
    result = h.run([
        step("ssh.run", {"host": host, "credential": "srv", "command": "echo hi"}, outputs={"output": "said"}),
        step("ftp.list", {"protocol": "sftp", "host": host, "credential": "srv", "folder": "."}, outputs={"files": "f"}),
    ], credentials={"srv": Credential("srv", user, password)}.__getitem__)
    assert result.status == "succeeded", result.error
    assert h.vars["said"] == "hi"


def test_the_ai_step_asks_the_assistant(h):
    asked: list[dict] = []

    def assistant(request: dict) -> dict:
        asked.append(request)
        return {"result": "Invoice" if request["task"] == "classify" else {"Total": "120.50"}}

    steps = [
        step("ai.ask", {"task": "classify", "text": "Please find attached invoice 42", "categories": ["Invoice", "Order"]},
             outputs={"result": "kind"}),
        step("ai.ask", {"task": "extract", "text": "Total due: 120.50", "fields": ["Total"]}, outputs={"result": "data"}),
    ]
    flow = Flow.model_validate({"id": "a", "name": "a", "steps": steps})
    runner = FlowRunner(flow, RunOptions(work_dir=Path("."), ai=assistant), lambda e: None)
    result = runner.run()
    assert result.status == "succeeded", result.error
    assert runner.ctx.variables["kind"] == "Invoice"
    assert runner.ctx.variables["data"] == {"Total": "120.50"}
    assert asked[0] == {"task": "classify", "text": "Please find attached invoice 42", "categories": ["Invoice", "Order"]}

    result = h.run([step("ai.ask", {"task": "summarize", "text": "x"})])
    assert result.status == "failed" and "not available" in result.error["message"]
