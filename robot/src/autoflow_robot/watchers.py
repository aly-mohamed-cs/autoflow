"""Event triggers the Orchestrator gave this robot to watch: "a new file appears in a folder" and "a
new email arrives". Each new file or email is reported once; the Orchestrator starts the runs
(and ignores anything it has already seen, e.g. after this robot restarted)."""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("autoflow.robot.watchers")

ReportFn = Callable[[dict[str, Any]], None]
MailCredentialFn = Callable[[str], dict[str, Any]]  # trigger id -> {"username", "password"}
MAX_PER_ROUND = 100
MIN_INTERVAL_S = 5.0
CREDENTIAL_CACHE_S = 600


class WatchError(Exception):
    """A problem the dashboard shows on the trigger (folder missing, mailbox sign-in failed...)."""


class Watchers:
    def __init__(self, state_dir: Path, report: ReportFn, mail_credential: MailCredentialFn,
                 python: str | None = None):
        self.state_dir = state_dir
        self.report = report
        self.mail_credential = mail_credential
        self.python = python or sys.executable
        self._watches: dict[str, _Watch] = {}
        self._lock = threading.Lock()

    def update(self, triggers: list[dict[str, Any]]) -> None:
        """The full list of triggers to watch now (sent by the Orchestrator)."""
        wanted = {str(t["id"]): t for t in triggers}
        with self._lock:
            for trigger_id, watch in list(self._watches.items()):
                if wanted.get(trigger_id) != watch.spec:
                    watch.stop()
                    del self._watches[trigger_id]
            for trigger_id, spec in wanted.items():
                if trigger_id not in self._watches:
                    check = self._checker(spec)
                    watch = _Watch(spec, check, self.report)
                    self._watches[trigger_id] = watch
                    watch.start()
                    log.info("watching %s trigger %s", spec.get("kind"), trigger_id)

    def stop(self) -> None:
        self.update([])

    @property
    def watching(self) -> list[str]:
        return sorted(self._watches)

    def _checker(self, spec: dict[str, Any]) -> Callable[[], list[tuple[str, dict[str, Any]]]]:
        if spec.get("kind") == "file":
            return FolderCheck(spec, self.state_dir)
        return MailCheck(spec, self.mail_credential, self.python)


class _Watch(threading.Thread):
    def __init__(self, spec: dict[str, Any], check: Callable[[], list[tuple[str, dict[str, Any]]]], report: ReportFn):
        super().__init__(name=f"watch-{spec['id']}", daemon=True)
        self.spec = spec
        self.check = check
        self.report = report
        self._stopped = threading.Event()
        self._reported: set[str] = set()
        self._error: str | None = None

    def stop(self) -> None:
        self._stopped.set()

    def run(self) -> None:
        interval = max(float((self.spec.get("config") or {}).get("intervalS") or 30), MIN_INTERVAL_S)
        while not self._stopped.is_set():
            try:
                found = self.check()
                self._set_error(None)
                for key, data in found[:MAX_PER_ROUND]:
                    if self._stopped.is_set():
                        break
                    if key not in self._reported:
                        self._reported.add(key)
                        self.report({"type": "trigger.fired", "trigger_id": self.spec["id"], "key": key, "data": data})
            except WatchError as exc:
                self._set_error(str(exc))
            except Exception as exc:  # keep watching; show the problem in the dashboard
                log.exception("trigger %s check failed", self.spec["id"])
                self._set_error(f"{type(exc).__name__}: {exc}")
            self._stopped.wait(interval)

    def _set_error(self, error: str | None) -> None:
        if error != self._error:
            self._error = error
            self.report({"type": "trigger.status", "trigger_id": self.spec["id"], "error": error})


def _since(spec: dict[str, Any]) -> float | None:
    since = spec.get("since")
    return datetime.fromisoformat(str(since).replace("Z", "+00:00")).timestamp() if since else None


class FolderCheck:
    """New files in a folder. A file counts once it is the same size in two checks in a row and no
    program holds it open for writing (so a file still being copied in isn't taken too early).

    Files already there when the trigger was created don't count (unless "include existing" is on):
    the first check remembers them in a small file, so a robot restart doesn't count them either -
    while files that arrived while the robot was off still do.
    """

    def __init__(self, spec: dict[str, Any], state_dir: Path):
        self.config = spec.get("config") or {}
        self.since = _since(spec)
        self._sizes: dict[str, tuple[int, int]] = {}
        # Per folder setting: pointing the trigger at another folder starts a new baseline.
        where = json.dumps([self.config.get("folder"), self.config.get("pattern"), self.config.get("subfolders")])
        self._baseline_file = state_dir / f"{spec['id']}-{hashlib.sha256(where.encode()).hexdigest()[:12]}.json"
        self._baseline: set[str] | None = None if self.since is not None else set()

    def __call__(self) -> list[tuple[str, dict[str, Any]]]:
        folder = Path(str(self.config.get("folder") or ""))
        if not folder.is_dir():
            raise WatchError(f"The folder {folder} was not found, or this robot can't open it.")
        pattern = str(self.config.get("pattern") or "*")
        try:
            files = [f for f in (folder.rglob(pattern) if self.config.get("subfolders") else folder.glob(pattern))
                     if f.is_file()]
        except OSError as exc:
            raise WatchError(f"Could not read the folder {folder}: {exc}") from None
        current: dict[str, tuple[int, int]] = {}
        for f in files:
            try:
                st = f.stat()
            except OSError:
                continue  # just moved away
            current[str(f)] = (st.st_size, st.st_mtime_ns)
        if self._baseline is None:
            self._baseline = self._load_baseline(current)
        found = []
        for path, signature in sorted(current.items()):
            key = f"{path}|{signature[1]}|{signature[0]}"
            if key in self._baseline or self._sizes.get(path) != signature or not _free(Path(path)):
                continue
            found.append((key, {"path": path, "name": Path(path).name}))
        self._sizes = current
        return found

    def _load_baseline(self, current: dict[str, tuple[int, int]]) -> set[str]:
        try:
            return set(json.loads(self._baseline_file.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        # First check of this trigger on this robot: files from before the trigger was made don't count.
        assert self.since is not None
        baseline = set()
        for path, (size, mtime_ns) in current.items():
            try:
                st = Path(path).stat()
                created = getattr(st, "st_birthtime", st.st_ctime)  # copies keep their modified time
            except OSError:
                continue
            if max(mtime_ns / 1e9, created) < self.since:
                baseline.add(f"{path}|{mtime_ns}|{size}")
        try:
            self._baseline_file.parent.mkdir(parents=True, exist_ok=True)
            self._baseline_file.write_text(json.dumps(sorted(baseline)), encoding="utf-8")
        except OSError as exc:
            log.warning("could not save the trigger baseline: %s", exc)
        return baseline


def _free(path: Path) -> bool:
    """False while another program writes the file (Windows refuses to open it then)."""
    try:
        with path.open("rb"):
            return True
    except OSError:
        return False


class MailCheck:
    """New emails in an Exchange mailbox, through the engine (the same code as 'Read emails')."""

    def __init__(self, spec: dict[str, Any], credential: MailCredentialFn, python: str):
        self.spec = spec
        self.config = spec.get("config") or {}
        self.credential = credential
        self.python = python
        self._login: dict[str, Any] | None = None
        self._login_at = 0.0

    def __call__(self) -> list[tuple[str, dict[str, Any]]]:
        if self._login is None or time.monotonic() - self._login_at > CREDENTIAL_CACHE_S:
            try:
                self._login = self.credential(str(self.spec["id"]))
            except Exception as exc:
                raise WatchError(f"Could not get the mailbox sign-in from the Orchestrator: {exc}") from None
            self._login_at = time.monotonic()
        settings = {
            "server": self.config.get("server", ""),
            "username": self._login.get("username", ""),
            "password": self._login.get("password", ""),
            "mailbox": self.config.get("mailbox", ""),
            "folder": self.config.get("folder") or "Inbox",
            "subject_contains": self.config.get("subjectContains", ""),
            "from_contains": self.config.get("fromContains", ""),
            "unread_only": self.config.get("unreadOnly", True),
            "since": self.spec.get("since"),
            "max": 50,
        }
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            done = subprocess.run(
                [self.python, "-m", "autoflow_engine", "check-mail"], input=json.dumps(settings) + "\n",
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, creationflags=flags,
            )
        except subprocess.TimeoutExpired:
            raise WatchError("The mail server did not answer within 2 minutes.") from None
        reply = _last_json(done.stdout)
        if reply is None:
            raise WatchError(f"Checking the mailbox failed: {(done.stderr or 'no answer').strip()[-300:]}")
        if reply.get("error"):
            self._login = None  # e.g. the password was changed in the Orchestrator: fetch it again
            raise WatchError(" ".join(filter(None, [reply.get("error"), reply.get("hint")])))
        return [(str(m["id"]), m) for m in reply.get("messages") or [] if m.get("id")]


def _last_json(text: str) -> dict[str, Any] | None:
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None
