"""Keeps the robot connected to the Orchestrator and hands jobs to the runner."""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import socket
import time
from collections import deque
from pathlib import Path
from typing import Any

import httpx
import websockets

from .config import RobotConfig, __version__, home
from .runner import JobRunner
from .updater import UpdateError, Updater, install_root, mark_failed

log = logging.getLogger("autoflow.robot")

HEARTBEAT_S = 15
UPDATE_CHECK_S = 6 * 3600
MAX_BUFFER = 5000


class Agent:
    def __init__(self, config: RobotConfig):
        self.config = config
        self._token = config.token
        self._ssl = config.ssl_context()
        self._ws: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._outbox: deque[dict[str, Any]] = deque(maxlen=MAX_BUFFER)
        self._stop = asyncio.Event()
        self.http = httpx.Client(
            base_url=config.server_url,
            headers={"Authorization": f"Bearer {self._token}", "User-Agent": f"AutoflowRobot/{__version__}"},
            verify=self._ssl if self._ssl else True,
            timeout=30,
        )
        self.runner = JobRunner(home() / "runs", self.send_threadsafe, self.upload, self.fetch_credentials,
                                repair=self.request_repair, ai=self.request_ai,
                                orchestrator=self.request_orchestrator)
        self.updater = Updater(self.http, install_root())
        self._update_task: asyncio.Task | None = None
        self._updating = False  # downloading or installing: no new jobs
        self._update_waiting: bool | None = None  # found while busy (value: forced by an admin)
        self._last_update_check = 0.0

    # -- called from the runner thread ---------------------------------------------------
    def send_threadsafe(self, message: dict[str, Any]) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._queue, message)

    def upload(self, job_id: str, path: Path, step_id: str | None) -> str | None:
        try:
            with path.open("rb") as fh:
                r = self.http.post(
                    f"/api/robot/jobs/{job_id}/artifacts",
                    params={"name": path.name, "step_id": step_id or "", "kind": "screenshot"},
                    content=fh.read(),
                    headers={"Content-Type": "application/octet-stream"},
                )
            r.raise_for_status()
            return r.json().get("id")
        except Exception as exc:
            log.warning("could not upload %s: %s", path.name, exc)
            return None

    def fetch_credentials(self, job_id: str) -> dict[str, Any]:
        r = self.http.get(f"/api/robot/jobs/{job_id}/credentials")
        r.raise_for_status()
        return r.json().get("credentials", {})

    def request_repair(self, job_id: str, failure: dict[str, Any]) -> dict[str, Any]:
        # A model without a GPU can take minutes; the Orchestrator stops waiting after 10.
        r = self.http.post(f"/api/robot/jobs/{job_id}/repair", json=failure, timeout=660)
        r.raise_for_status()
        return r.json()

    def request_ai(self, job_id: str, task: dict[str, Any]) -> dict[str, Any]:
        """The AI step of a running job: the Orchestrator asks the company's model."""
        r = self.http.post(f"/api/robot/jobs/{job_id}/ai", json=task, timeout=660)
        if r.status_code >= 400:
            try:
                message = r.json().get("error") or r.text
            except ValueError:
                message = r.text
            raise RuntimeError(message[:300])
        return r.json()

    def request_orchestrator(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]:
        """Shared values and queue steps of a running job."""
        r = self.http.post(f"/api/robot/jobs/{job_id}/orchestrator", json=request, timeout=120)
        if r.status_code >= 400:
            try:
                message = r.json().get("error") or r.text
            except ValueError:
                message = r.text
            raise RuntimeError(message[:500])
        return r.json()

    # -- connection loop ----------------------------------------------------------------
    def _queue(self, message: dict[str, Any]) -> None:
        self._outbox.append(message)
        asyncio.ensure_future(self._flush())

    async def _flush(self) -> None:
        ws = self._ws
        while ws is not None and self._outbox:
            message = self._outbox[0]
            try:
                await ws.send(json.dumps(message, default=str))
            except Exception:
                return  # keep it; sent after reconnecting
            self._outbox.popleft()

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(
                    self.config.ws_url,
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    ssl=self._ssl,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=16 * 1024 * 1024,
                ) as ws:
                    log.info("connected to %s", self.config.server_url)
                    backoff = 1.0
                    self._ws = ws
                    await ws.send(json.dumps(self._hello()))
                    await self._flush()
                    heartbeat = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for raw in ws:
                            self._handle(json.loads(raw))
                    finally:
                        heartbeat.cancel()
                        self._ws = None
            except websockets.InvalidStatus as exc:
                status = exc.response.status_code
                log.error("server refused the connection (%s). Is the robot still enrolled and enabled?", status)
                backoff = 60.0 if status in (401, 403) else backoff
            except (OSError, websockets.ConnectionClosed, websockets.InvalidURI, TimeoutError) as exc:
                log.warning("connection lost: %s", exc)
            if self._stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    def stop(self) -> None:
        self._stop.set()

    async def _heartbeat(self, ws: Any) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            await ws.send(json.dumps({"type": "heartbeat", "busy_job_id": self.runner.job_id}))
            if self._update_waiting is not None and not self.runner.busy:
                self._check_for_update(self._update_waiting)
            elif time.monotonic() - self._last_update_check > UPDATE_CHECK_S:
                self._check_for_update(False)

    # -- self-update (see updater.py) -----------------------------------------------------
    def _check_for_update(self, force: bool) -> None:
        if self._update_task is None or self._update_task.done():
            self._update_task = asyncio.ensure_future(self._update(force))

    async def _update(self, force: bool) -> None:
        self._last_update_check = time.monotonic()
        try:
            release = await asyncio.to_thread(self.updater.check, force)
        except UpdateError as exc:
            self._queue({"type": "robot.update_failed", "version": "", "error": str(exc)})
            return
        except Exception as exc:  # the server may be busy or older; try again later
            log.warning("could not check for updates: %s", exc)
            return
        if release is None:
            self._update_waiting = None
            return
        if self.runner.busy:
            log.info("version %s is available; installing it after the current run", release.version)
            self._update_waiting = force
            return
        self._update_waiting = None
        self._updating = True
        log.info("updating to version %s", release.version)
        self._queue({"type": "robot.updating", "version": release.version})
        try:
            staged = await asyncio.to_thread(self.updater.prepare, release)
            self.updater.hand_over(staged, release.version)
        except Exception as exc:
            reason = str(exc) if isinstance(exc, UpdateError) else f"{type(exc).__name__}: {exc}"
            log.error("update to %s failed: %s", release.version, reason)
            mark_failed(release.version, reason)
            self._queue({"type": "robot.update_failed", "version": release.version, "error": reason})
            self._updating = False
            return
        log.info("handing over to version %s; this robot restarts in a moment", release.version)
        await self._flush()
        self.stop()
        if self._ws is not None:
            await self._ws.close()

    def _hello(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "version": __version__,
            "capabilities": self.config.capabilities,
            "machine": f"{socket.gethostname()} ({platform.platform(terse=True)})",
            "busy_job_id": self.runner.job_id,
        }

    def _handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "welcome":
            log.info("server knows this robot as %s", message.get("robot_id"))
            self._check_for_update(False)
        elif kind == "robot.update":
            # An administrator's "Update now" (force), or the server announcing a new package.
            self._check_for_update(bool(message.get("force", True)))
        elif kind == "job.assign":
            job = message["job"]
            if self._updating:
                self._queue({"type": "job.rejected", "job_id": job["id"], "reason": "updating"})
            elif self.runner.start(job):
                log.info("running job %s (%s v%s)", job["id"], job["flow"].get("name"), job.get("version"))
            else:
                self._queue({"type": "job.rejected", "job_id": job["id"], "reason": "busy"})
        elif kind == "job.cancel":
            self.runner.cancel(message["job_id"])


def enroll(server_url: str, key: str, name: str | None = None, trust_certificate: bool = False) -> RobotConfig:
    """Exchange a one-time enrollment key for a robot token and save the settings."""
    import ssl

    from .config import protect, ssl_context

    server_url = server_url.rstrip("/")
    pinned: str | None = None
    if server_url.startswith("https"):
        try:
            httpx.get(f"{server_url}/health", timeout=10).raise_for_status()
        except httpx.ConnectError as exc:
            if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
                raise
            if not trust_certificate:
                raise SystemExit(
                    "The server uses its own (self-signed) certificate.\n"
                    f"Fingerprint: {server_fingerprint(server_url)}\n"
                    "Compare it with the one shown in the dashboard (Robots > Add robot), then run the same\n"
                    "command again with --trust-certificate."
                ) from None
            host, port = _host_port(server_url)
            pinned = ssl.get_server_certificate((host, port))
    ctx = ssl_context(server_url, pinned)
    machine = f"{socket.gethostname()} ({platform.platform(terse=True)})"
    response = httpx.post(
        f"{server_url}/api/robot/enroll",
        json={"key": key.strip(), "name": name or socket.gethostname(), "machine": machine},
        verify=ctx if ctx else True,
        timeout=30,
    )
    if response.status_code >= 400:
        raise SystemExit(f"Enrollment failed: {response.json().get('error', response.text)}")
    data = response.json()
    config = RobotConfig(
        server_url=server_url,
        robot_id=data["robotId"],
        name=name or socket.gethostname(),
        token_protected=protect(data["token"]),
        pool=data.get("pool", "default"),
        pinned_cert=pinned,
    )
    config.save()
    return config


def server_fingerprint(server_url: str) -> str:
    import hashlib
    import ssl

    host, port = _host_port(server_url)
    pem = ssl.get_server_certificate((host, port))
    der = ssl.PEM_cert_to_DER_cert(pem)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def _host_port(url: str) -> tuple[str, int]:
    from urllib.parse import urlparse

    u = urlparse(url)
    return u.hostname or "localhost", u.port or (443 if u.scheme == "https" else 80)
