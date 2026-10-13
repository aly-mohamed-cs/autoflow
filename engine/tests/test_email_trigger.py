"""Email triggers: the robot's mailbox check, and reading the one email that started a run."""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime
from types import SimpleNamespace

from autoflow_engine import cli
from autoflow_engine.activities import email
from autoflow_engine.errors import ActivityError


def _message(id_: str, subject: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=id_, subject=subject, is_read=False, text_body=" Please pay \n",
        sender=SimpleNamespace(name="Vendor", email_address="vendor@example.com"),
        datetime_received=datetime(2026, 10, 13, 8, 0, tzinfo=UTC), attachments=[SimpleNamespace(name="inv.pdf")],
    )


def test_check_mail_prints_new_messages_as_one_json_line(monkeypatch, capsys):
    seen: dict = {}

    def fake_connect(server, username, password, mailbox):
        seen["login"] = (server, username, password, mailbox)
        return "account"

    def fake_find(account, folder, **kw):
        seen["search"] = (account, folder, kw)
        return [_message("AAMk1", "Invoice 42")]

    monkeypatch.setattr(email, "connect", fake_connect)
    monkeypatch.setattr(email, "find_messages", fake_find)
    settings = {"server": "mail.local", "username": "u@c.local", "password": "pw", "mailbox": "", "folder": "Inbox",
                "subject_contains": "Invoice", "from_contains": "", "unread_only": True,
                "since": "2026-10-13T07:00:00Z", "max": 50}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(settings) + "\n"))
    assert cli.main(["check-mail"]) == 0
    reply = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert reply == {"messages": [{"id": "AAMk1", "from": "vendor@example.com", "subject": "Invoice 42",
                                   "received": "2026-10-13T08:00:00+00:00", "text": "Please pay",
                                   "attachments": "inv.pdf"}]}
    assert seen["login"] == ("mail.local", "u@c.local", "pw", "")
    assert seen["search"][2]["since"] == datetime(2026, 10, 13, 7, 0, tzinfo=UTC)
    assert seen["search"][2]["subject_contains"] == "Invoice"


def test_check_mail_reports_sign_in_problems_plainly(monkeypatch, capsys):
    def refuse(*_a):
        raise ActivityError("Exchange rejected the username or password.", "Check the credential.")

    monkeypatch.setattr(email, "connect", refuse)
    monkeypatch.setattr("sys.stdin", io.StringIO("{}\n"))
    assert cli.main(["check-mail"]) == 1
    assert json.loads(capsys.readouterr().out) == {"error": "Exchange rejected the username or password.",
                                                   "hint": "Check the credential."}


def test_read_emails_can_open_the_one_that_started_the_run(h, monkeypatch):
    asked: list = []

    class FakeAccount:
        def fetch(self, ids):
            asked.append(ids)
            return iter([_message(ids[0][0], "Invoice 42")] if ids[0][0] == "AAMk1" else [Exception("not found")])

    monkeypatch.setattr(email, "connect", lambda *a: FakeAccount())
    creds = {"Box": SimpleNamespace(username="u@c.local", password="pw")}.__getitem__
    result = h.run([
        email_step := {"id": "r", "activity": "email.read", "outputs": {"messages": "mails"},
                       "params": {"server": "mail.local", "credential": "Box", "message_id": "{{trigger_email[\"id\"]}}"}},
    ], variables=[{"name": "trigger_email", "is_input": True, "default": {"id": "AAMk1"}}], credentials=creds)
    assert result.status == "succeeded", result.error
    assert asked == [[("AAMk1", None)]]
    assert h.vars["mails"].rows[0]["subject"] == "Invoice 42"

    email_step["params"]["message_id"] = "gone"
    result = h.run([email_step], credentials=creds)
    assert result.status == "failed" and result.error["message"] == "That email was not found in the mailbox."

