"""Event triggers on the robot: folder and mailbox watching."""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from autoflow_robot import watchers
from autoflow_robot.watchers import FolderCheck, MailCheck, WatchError, Watchers


def _spec(folder: Path, since: datetime | None, **config) -> dict:
    return {"id": "trg_1", "kind": "file", "since": since.isoformat().replace("+00:00", "Z") if since else None,
            "config": {"folder": str(folder), "pattern": "*.pdf", "intervalS": 10, **config}}


def test_new_files_count_once_they_are_complete(tmp_path):
    inbox = tmp_path / "in"
    inbox.mkdir()
    check = FolderCheck(_spec(inbox, datetime.now(UTC) - timedelta(seconds=1)), tmp_path / "state")
    assert check() == []
    (inbox / "a.pdf").write_bytes(b"part")
    (inbox / "notes.txt").write_text("not a pdf")
    assert check() == []  # first seen: maybe still being copied
    (inbox / "a.pdf").write_bytes(b"partly written")
    assert check() == []  # still growing
    found = check()
    assert [d for _, d in found] == [{"path": str(inbox / "a.pdf"), "name": "a.pdf"}]
    assert found[0][0].startswith(str(inbox / "a.pdf") + "|")


def test_files_from_before_the_trigger_do_not_count_even_after_a_restart(tmp_path):
    inbox, state = tmp_path / "in", tmp_path / "state"
    (inbox / "sub").mkdir(parents=True)
    old = inbox / "old.pdf"
    old.write_bytes(b"old")
    time.sleep(0.05)
    since = datetime.now(UTC)  # the trigger is created after old.pdf arrived
    time.sleep(0.05)
    check = FolderCheck(_spec(inbox, since), state)
    check(), check()
    assert check() == []
    # A file that arrives while the robot is off still counts after the restart.
    (inbox / "new.pdf").write_bytes(b"new")
    restarted = FolderCheck(_spec(inbox, since), state)
    restarted()
    assert [d["name"] for _, d in restarted()] == ["new.pdf"]
    # "Include existing files", and subfolders.
    (inbox / "sub" / "deep.pdf").write_bytes(b"x")
    everything = FolderCheck({**_spec(inbox, None, subfolders=True), "id": "trg_2"}, state)
    everything()
    assert sorted(d["name"] for _, d in everything()) == ["deep.pdf", "new.pdf", "old.pdf"]


@pytest.mark.skipif(os.name != "nt", reason="Windows refuses to open a file another program is writing")
def test_a_file_still_held_open_for_writing_waits(tmp_path):
    import ctypes
    from ctypes import wintypes

    inbox = tmp_path / "in"
    inbox.mkdir()
    check = FolderCheck(_spec(inbox, None), tmp_path / "state")
    (inbox / "big.pdf").write_bytes(b"data")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(str(inbox / "big.pdf"), 0x40000000, 0, None, 3, 0x80, None)  # write, no sharing
    try:
        check()
        assert check() == []
    finally:
        kernel32.CloseHandle(handle)
    assert [d["name"] for _, d in check()] == ["big.pdf"]


def test_a_missing_folder_is_reported(tmp_path):
    with pytest.raises(WatchError, match="was not found"):
        FolderCheck(_spec(tmp_path / "nope", None), tmp_path / "state")()


def _wait(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def test_watchers_report_each_file_once_and_problems_while_they_last(tmp_path, monkeypatch):
    monkeypatch.setattr(watchers, "MIN_INTERVAL_S", 0.05)
    inbox = tmp_path / "in"
    reports: list[dict] = []
    w = Watchers(tmp_path / "state", reports.append, lambda _id: {})
    spec = _spec(inbox, None, intervalS=0.05)
    w.update([spec])
    assert w.watching == ["trg_1"]
    _wait(lambda: any(r["type"] == "trigger.status" for r in reports))
    assert reports[0]["error"].startswith("The folder")

    inbox.mkdir()
    (inbox / "a.pdf").write_bytes(b"a")
    _wait(lambda: any(r["type"] == "trigger.fired" for r in reports))
    time.sleep(0.3)  # several more rounds: still reported once, and the problem only once
    assert [r["data"]["name"] for r in reports if r["type"] == "trigger.fired"] == ["a.pdf"]
    statuses = [r["error"] for r in reports if r["type"] == "trigger.status"]
    assert len(statuses) == 2 and statuses[1] is None
    w.update([])
    assert w.watching == []


def test_mail_check_asks_the_engine_with_the_mailbox_password_on_stdin(monkeypatch):
    calls: list[dict] = []

    def fake_run(cmd, input, **kw):
        calls.append({"cmd": cmd, "settings": json.loads(input)})
        if len(calls) == 2:
            return subprocess.CompletedProcess(cmd, 1, json.dumps({"error": "Exchange rejected the username or password.",
                                                                   "hint": "Check the credential."}) + "\n", "")
        messages = [{"id": "AAMk1", "subject": "Invoice 42", "from": "a@b.c"}, {"subject": "no id"}]
        return subprocess.CompletedProcess(cmd, 0, "noise\n" + json.dumps({"messages": messages}) + "\n", "")

    monkeypatch.setattr(watchers.subprocess, "run", fake_run)
    logins = []
    spec = {"id": "trg_m", "kind": "email", "since": "2026-10-13T08:00:00Z",
            "config": {"server": "mail.local", "credential": "Box", "subjectContains": "Invoice", "intervalS": 60}}
    check = MailCheck(spec, lambda trigger_id: logins.append(trigger_id) or {"username": "u@c.local", "password": "pw"},
                      "python")
    assert check() == [("AAMk1", {"id": "AAMk1", "subject": "Invoice 42", "from": "a@b.c"})]
    assert calls[0]["cmd"][1:] == ["-m", "autoflow_engine", "check-mail"]
    assert calls[0]["settings"] == {"server": "mail.local", "username": "u@c.local", "password": "pw", "mailbox": "",
                                    "folder": "Inbox", "subject_contains": "Invoice", "from_contains": "",
                                    "unread_only": True, "since": "2026-10-13T08:00:00Z", "max": 50}
    with pytest.raises(WatchError, match="rejected the username or password. Check the credential."):
        check()
    check()
    assert logins == ["trg_m", "trg_m"]  # asked again after a sign-in failure
