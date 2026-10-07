"""Deployment-like setup: HTTPS with a self-signed certificate and a DPAPI-protected vault key.

Mirrors what install-server.ps1 creates, without touching the Windows certificate
store: the certificate comes from openssl, the vault key is protected with DPAPI
(machine scope) exactly like the installer does it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "apps" / "server" / "dist" / "index.js"
OPENSSL = shutil.which("openssl") or r"C:\Program Files\Git\usr\bin\openssl.exe"

pytestmark = [
    pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows-only"),
    pytest.mark.skipif(not SERVER.exists(), reason="build the server first"),
    pytest.mark.skipif(not Path(OPENSSL).exists(), reason="openssl not found"),
]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _dpapi_machine_protect(data: bytes) -> str:
    script = (
        "Add-Type -AssemblyName System.Security; "
        f"$b=[Convert]::FromBase64String('{base64.b64encode(data).decode()}'); "
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); "
        "[Convert]::ToBase64String($p)"
    )
    return subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def tls_server(tmp_path):
    data = tmp_path / "data"
    (data / "tls").mkdir(parents=True)
    subprocess.run(
        [OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
         "-keyout", str(data / "tls" / "key.pem"), "-out", str(data / "tls" / "cert.pem")],
        check=True, capture_output=True,
    )
    (data / "vault.key.dpapi").write_text(_dpapi_machine_protect(os.urandom(32)))
    port = _free_port()
    (data / "config.json").write_text(json.dumps({
        "port": port, "host": "127.0.0.1", "publicUrl": f"https://127.0.0.1:{port}",
        "tls": {"cert": str(data / "tls" / "cert.pem"), "key": str(data / "tls" / "key.pem")},
    }))
    env = {k: v for k, v in os.environ.items() if not k.startswith("AUTOFLOW_")}
    env["AUTOFLOW_DATA_DIR"] = str(data)
    proc = subprocess.Popen(["node", "--disable-warning=ExperimentalWarning", str(SERVER)], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = f"https://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/health", verify=False, timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        pytest.fail("server did not start:\n" + (proc.stdout.read() if proc.stdout else ""))
    yield url
    proc.terminate()
    proc.wait(10)


def test_self_signed_tls_and_dpapi_vault(tls_server, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOFLOW_ROBOT_HOME", str(tmp_path / "robot"))
    api = httpx.Client(base_url=tls_server, verify=False, timeout=10)
    api.post("/api/setup", json={"username": "admin", "displayName": "Admin", "password": "a long admin password"}).raise_for_status()
    token = api.post("/api/auth/login", json={"username": "admin", "password": "a long admin password"}).json()["token"]
    api.headers["Authorization"] = f"Bearer {token}"

    # The vault works with the DPAPI-protected key.
    api.put("/api/credentials", json={"name": "Portal", "username": "u", "password": "p4ss-word"}).raise_for_status()
    fingerprint = api.get("/api/server-info").json()["fingerprint"]
    assert fingerprint and len(fingerprint.split(":")) == 32

    flow = {"id": "flow_tls", "name": "TLS check", "steps": [
        {"id": "c", "activity": "control.get_credential", "params": {"credential": "Portal"}, "outputs": {"credential": "login"}},
        {"id": "l", "activity": "control.log", "params": {"message": "user {{login.username}}"}}]}
    api.post("/api/flows/flow_tls/versions", json={"flow": flow}).raise_for_status()

    from autoflow_robot.agent import Agent, enroll, server_fingerprint
    from autoflow_robot.config import RobotConfig

    # The robot sees the same fingerprint the dashboard shows.
    assert server_fingerprint(tls_server) == fingerprint

    key = api.post("/api/robots/enrollment-keys", json={}).json()["key"]
    with pytest.raises(SystemExit) as refused:
        enroll(tls_server, key, name="TLS robot")  # not trusted yet
    assert fingerprint in str(refused.value)
    enroll(tls_server, key, name="TLS robot", trust_certificate=True)
    config = RobotConfig.load()
    assert config.pinned_cert and "BEGIN CERTIFICATE" in config.pinned_cert

    agent = Agent(config)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_until_complete, args=(agent.run(),), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 20
        while not api.get("/api/robots").json()["robots"][0]["online"]:
            assert time.monotonic() < deadline, "robot never came online over wss"
            time.sleep(0.2)
        job = api.post("/api/flows/flow_tls/run", json={}).json()["job"]
        deadline = time.monotonic() + 60
        while (status := api.get(f"/api/jobs/{job['id']}").json()["job"]["status"]) not in ("succeeded", "failed"):
            assert time.monotonic() < deadline
            time.sleep(0.3)
        detail = api.get(f"/api/jobs/{job['id']}").json()
        assert status == "succeeded", detail["job"]["error"]
        assert [e["message"] for e in detail["events"] if e["event"] == "log"] == ["user u"]
    finally:
        loop.call_soon_threadsafe(agent.stop)
        thread.join(5)
