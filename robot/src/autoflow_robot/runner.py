"""Runs one job: the engine in its own process, events streamed back to the Orchestrator."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger("autoflow.robot.runner")

SendFn = Callable[[dict[str, Any]], None]
UploadFn = Callable[[str, Path, str | None], str | None]  # (job_id, file, step_id) -> artifact id
CredentialsFn = Callable[[str], dict[str, Any]]
RepairFn = Callable[[str, dict[str, Any]], dict[str, Any]]  # (job_id, failure) -> AI fix from the Orchestrator
AiFn = Callable[[str, dict[str, Any]], dict[str, Any]]  # (job_id, task) -> the AI step's answer
# (job_id, request) -> the Orchestrator's answer for shared values and queue steps
OrchestratorFn = Callable[[str, dict[str, Any]], dict[str, Any]]
ORCHESTRATOR_STEPS = ("assets.get", "queue.add", "queue.next", "queue.finish", "queue.count", "queue.for_each")

KEEP_RUNS = 20
CANCEL_GRACE_S = 30


class JobRunner:
    """One job at a time. The engine runs in a child process so a crash can't take the robot down."""

    def __init__(self, runs_dir: Path, send: SendFn, upload: UploadFn, credentials: CredentialsFn,
                 python: str | None = None, repair: RepairFn | None = None, ai: AiFn | None = None,
                 orchestrator: OrchestratorFn | None = None):
        self.runs_dir = runs_dir
        self.send = send
        self.upload = upload
        self.credentials = credentials
        self.repair = repair
        self.ai = ai
        self.orchestrator = orchestrator
        self.python = python or sys.executable
        self.job_id: str | None = None
        self._process: subprocess.Popen | None = None
        self._cancel_file: Path | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._stdin_lock = threading.Lock()

    @property
    def busy(self) -> bool:
        return self.job_id is not None

    def start(self, job: dict[str, Any]) -> bool:
        with self._lock:
            if self.job_id:
                return False
            self.job_id = job["id"]
        self._thread = threading.Thread(target=self._run, args=(job,), name=f"job-{job['id']}", daemon=True)
        self._thread.start()
        return True

    def cancel(self, job_id: str) -> None:
        if job_id != self.job_id:
            return
        log.info("cancel requested for %s", job_id)
        if self._cancel_file:
            self._cancel_file.touch()
        proc = self._process
        if proc is not None:
            self._write_engine(proc, {"cancel": True})  # in case it is waiting for an AI fix
        threading.Timer(CANCEL_GRACE_S, self._kill).start()

    def _write_engine(self, process: subprocess.Popen, message: dict[str, Any]) -> None:
        with self._stdin_lock:
            try:
                if process.poll() is None and process.stdin and not process.stdin.closed:
                    process.stdin.write(json.dumps(message) + "\n")
                    process.stdin.flush()
            except (OSError, ValueError):
                pass  # the engine already stopped

    def _kill(self) -> None:
        proc = self._process
        if proc and proc.poll() is None:
            log.warning("engine did not stop in time; killing it")
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            else:
                proc.kill()

    def _run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        started = time.monotonic()
        work = self.runs_dir / job_id
        finished: dict[str, Any] | None = None
        stderr_tail: list[str] = []
        try:
            work.mkdir(parents=True, exist_ok=True)
            (work / "flow.json").write_text(json.dumps(job["flow"]), encoding="utf-8")
            (work / "inputs.json").write_text(json.dumps(job.get("inputs") or {}), encoding="utf-8")
            self._cancel_file = work / "cancel"
            secrets = self.credentials(job_id)
            env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
            flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
            repair = bool(job.get("repair")) and self.repair is not None
            ai = self.ai is not None and _uses(job["flow"], "ai.ask")
            orch = self.orchestrator is not None and any(_uses(job["flow"], a) for a in ORCHESTRATOR_STEPS)
            self._process = subprocess.Popen(
                [self.python, "-m", "autoflow_engine", "run", str(work / "flow.json"),
                 "--inputs", "@" + str(work / "inputs.json"), "--work-dir", str(work / "files"),
                 "--credentials-stdin", "--cancel-file", str(self._cancel_file),
                 *(["--repair-stdin"] if repair else []), *(["--ai-stdin"] if ai else []),
                 *(["--orchestrator-stdin"] if orch else [])],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=work, env=env, creationflags=flags, text=True, encoding="utf-8", errors="replace",
            )
            assert self._process.stdin and self._process.stdout and self._process.stderr
            self._process.stdin.write(json.dumps(secrets) + "\n")
            self._process.stdin.flush()
            if not repair and not ai and not orch:
                self._process.stdin.close()  # otherwise the answers to the engine's questions go here
            del secrets
            threading.Thread(target=_drain, args=(self._process.stderr, stderr_tail), daemon=True).start()
            timer = threading.Timer(max(int(job.get("timeout_s") or 3600), 10), lambda: self.cancel(job_id))
            timer.daemon = True
            timer.start()
            for line in self._process.stdout:
                event = _parse(line)
                if event is None:
                    continue
                if event.get("event") in ("repair_request", "ai_request", "orchestrator_request"):
                    # Asked off the reading loop so engine output keeps flowing while the model thinks.
                    threading.Thread(target=self._answer, args=(job_id, event, self._process),
                                     daemon=True).start()
                    continue
                if event.get("event") == "screenshot":
                    path = Path(event.pop("path", ""))
                    if path.exists():
                        event["artifact_id"] = self.upload(job_id, path, event.get("step_id"))
                if event.get("event") == "run_finished":
                    finished = event
                self.send({"type": "job.event", "job_id": job_id, "event": event})
            self._process.wait()
            timer.cancel()
            with self._stdin_lock:
                if not self._process.stdin.closed:
                    self._process.stdin.close()
        except Exception as exc:
            log.exception("job %s failed to run", job_id)
            stderr_tail.append(f"{type(exc).__name__}: {exc}")
        finally:
            duration = int((time.monotonic() - started) * 1000)
            if finished:
                result = {"status": finished.get("status", "failed"), "duration_ms": finished.get("duration_ms", duration),
                          "outputs": finished.get("outputs") or {}, "error": finished.get("error")}
            else:
                detail = "\n".join(stderr_tail[-5:])
                result = {"status": "failed", "duration_ms": duration, "outputs": {},
                          "error": {"message": "The automation engine stopped unexpectedly on the robot.",
                                    "hint": detail[-500:] or None}}
            self.send({"type": "job.finished", "job_id": job_id, **result})
            self._process = None
            self._cancel_file = None
            with self._lock:
                self.job_id = None
            _prune(self.runs_dir)


    def _answer(self, job_id: str, event: dict[str, Any], process: subprocess.Popen) -> None:
        """Ask the Orchestrator what the engine wants to know (an AI fix, the AI step's answer, a shared
        value or a queue item)."""
        answer: dict[str, Any] = {"id": event.get("id")}
        kind = event.get("event")
        handler = {"repair_request": self.repair, "ai_request": self.ai, "orchestrator_request": self.orchestrator}.get(
            str(kind))
        try:
            answer["reply"] = handler(job_id, event.get("request") or {}) if handler else None
        except Exception as exc:
            log.warning("%s failed: %s", kind, exc)
            answer["error"] = str(exc) if kind == "orchestrator_request" else f"Could not reach the AI assistant: {exc}"
        self._write_engine(process, answer)


def _parse(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def _drain(stream: Any, tail: list[str]) -> None:
    for line in stream:
        tail.append(line.rstrip())
        del tail[:-50]


def _prune(runs_dir: Path) -> None:
    try:
        runs = sorted((p for p in runs_dir.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
        for old in runs[:-KEEP_RUNS]:
            shutil.rmtree(old, ignore_errors=True)
    except OSError:
        pass


def _uses(flow: dict[str, Any], activity: str) -> bool:
    """Whether a flow (main process or a sub-process) has a step of this kind."""
    def visit(steps: list[Any]) -> bool:
        return any(
            s.get("activity") == activity or any(visit(b) for b in (s.get("blocks") or {}).values())
            for s in steps or [] if isinstance(s, dict)
        )

    return visit(flow.get("steps") or []) or any(visit(p.get("steps") or []) for p in flow.get("processes") or [])
