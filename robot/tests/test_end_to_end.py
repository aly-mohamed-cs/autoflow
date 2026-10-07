"""Orchestrator + robot + engine together: publish, enroll, run unattended, see results.

Starts the real built server (apps/server/dist) with a temporary data folder.
"""

from __future__ import annotations

import asyncio
import base64
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "apps" / "server" / "dist" / "index.js"

pytestmark = pytest.mark.skipif(not SERVER.exists() or not shutil.which("node"), reason="build the server first (pnpm --filter @autoflow/server build)")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path):
    port = _free_port()
    env = {
        **os.environ,
        "AUTOFLOW_DATA_DIR": str(tmp_path / "server"),
        "AUTOFLOW_INSECURE_HTTP": "1",
        "AUTOFLOW_PORT": str(port),
        "AUTOFLOW_HOST": "127.0.0.1",
        "AUTOFLOW_PUBLIC_URL": f"http://127.0.0.1:{port}",
        "AUTOFLOW_VAULT_KEY": base64.b64encode(os.urandom(32)).decode(),
        "AUTOFLOW_DASHBOARD_DIR": str(tmp_path / "none"),
    }
    proc = subprocess.Popen(["node", "--disable-warning=ExperimentalWarning", str(SERVER)], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        pytest.fail("server did not start:\n" + (proc.stdout.read() if proc.stdout else ""))
    yield url
    proc.terminate()
    proc.wait(10)


def test_unattended_run(server, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOFLOW_ROBOT_HOME", str(tmp_path / "robot"))
    out_file = tmp_path / "out" / "result.txt"

    api = httpx.Client(base_url=server, timeout=10)
    api.post("/api/setup", json={"username": "admin", "displayName": "Admin", "password": "a long admin password"}).raise_for_status()
    token = api.post("/api/auth/login", json={"username": "admin", "password": "a long admin password"}).json()["token"]
    api.headers["Authorization"] = f"Bearer {token}"

    flow = {
        "id": "flow_e2e",
        "name": "Write a greeting",
        "variables": [{"name": "who", "type": "text", "is_input": True}],
        "steps": [
            {"id": "c", "activity": "control.get_credential", "params": {"credential": "Portal"}, "outputs": {"credential": "login"}},
            {"id": "w", "activity": "files.write_text",
             "params": {"file": str(out_file), "text": "Hello {{who}} from {{login.username}}"}},
            {"id": "l", "activity": "control.log", "params": {"message": "Password is {{login.password}}"}},
        ],
    }
    api.post("/api/flows/flow_e2e/versions", json={"flow": flow, "notes": "e2e"}).raise_for_status()
    api.put("/api/credentials", json={"name": "Portal", "username": "robot-user", "password": "Hunter2!x"}).raise_for_status()
    key = api.post("/api/robots/enrollment-keys", json={"pool": "default", "hours": 1}).json()["key"]

    from autoflow_robot.agent import Agent, enroll
    from autoflow_robot.config import RobotConfig

    enroll(server, key, name="Test robot")
    config = RobotConfig.load()
    assert config.token.startswith("afr_")
    assert "afr_" not in (tmp_path / "robot" / "robot.json").read_text()  # token is protected at rest

    agent = Agent(config)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_until_complete, args=(agent.run(),), daemon=True)
    thread.start()
    try:
        _wait(lambda: api.get("/api/robots").json()["robots"][0]["online"], "robot online")
        job = api.post("/api/flows/flow_e2e/run", json={"inputs": {"who": "Mona"}}).json()["job"]
        _wait(lambda: api.get(f"/api/jobs/{job['id']}").json()["job"]["status"] in ("succeeded", "failed"), "job finished", 60)
        detail = api.get(f"/api/jobs/{job['id']}").json()
        assert detail["job"]["status"] == "succeeded", detail["job"]["error"]
        assert detail["job"]["robotName"] == "Test robot"
        assert out_file.read_text(encoding="utf-8") == "Hello Mona from robot-user"
        logs = [e["message"] for e in detail["events"] if e["event"] == "log"]
        assert logs == ["Password is ••••••"]
        assert "Hunter2" not in str(detail)
        kinds = [e["event"] for e in detail["events"]]
        assert kinds[0] == "run_started" and kinds[-1] == "run_finished"
    finally:
        loop.call_soon_threadsafe(agent.stop)
        thread.join(5)


def _wait(check, what, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (httpx.HTTPError, KeyError, IndexError):
            pass
        time.sleep(0.2)
    raise AssertionError(f"timed out waiting for {what}")
