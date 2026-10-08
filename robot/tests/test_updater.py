"""Robot self-update: checking, downloading, verifying, unpacking and the folder swap."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from autoflow_robot import updater
from autoflow_robot.updater import Release, UpdateError, Updater


@pytest.fixture(autouse=True)
def robot_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOFLOW_ROBOT_HOME", str(tmp_path / "home"))


def robot_zip(version: str, extra: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Autoflow-Robot/python/python.exe", b"exe")
        zf.writestr("Autoflow-Robot/python/Lib/site.py", b"# python")
        zf.writestr("Autoflow-Robot/VERSION.txt", version)
        zf.writestr("Autoflow-Robot/install-robot.ps1", b"# installer")
        for name, data in (extra or {}).items():
            zf.writestr(name, data)
    return buf.getvalue()


def server(info: dict, package: bytes = b"") -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/robot/update":
            return httpx.Response(200, json=info)
        if request.url.path.startswith("/downloads/"):
            return httpx.Response(200, content=package)
        return httpx.Response(404)

    return httpx.Client(base_url="https://orchestrator.test", transport=httpx.MockTransport(handler))


def info_for(version: str, package: bytes, **extra) -> dict:
    return {"version": version, "url": f"/downloads/Autoflow-Robot-{version}.zip", "size": len(package),
            "sha256": hashlib.sha256(package).hexdigest(), "automatic": True, **extra}


def test_versions_compare_numerically():
    assert updater.is_newer("0.10.0", "0.9.9")
    assert updater.is_newer("1.0.0", "0.99.0")
    assert not updater.is_newer("0.2.0", "0.2.0")
    assert not updater.is_newer("0.1.9", "0.2.0")


def test_only_newer_versions_and_respects_the_settings(tmp_path):
    package = robot_zip("0.3.0")
    up = Updater(server(info_for("0.3.0", package)), tmp_path, version="0.2.0")
    assert up.check() == Release("0.3.0", "/downloads/Autoflow-Robot-0.3.0.zip", len(package),
                                 hashlib.sha256(package).hexdigest())
    assert Updater(server(info_for("0.3.0", package)), tmp_path, version="0.3.0").check() is None
    assert Updater(server({"version": None, "automatic": True}), tmp_path, version="0.2.0").check() is None

    # Automatic updates turned off: only when an administrator presses "Update now".
    manual = Updater(server(info_for("0.3.0", package, automatic=False)), tmp_path, version="0.2.0")
    assert manual.check() is None
    assert manual.check(force=True) is not None

    # A version that failed before is not retried by itself.
    updater.mark_failed("0.3.0", "did not start")
    assert up.check() is None
    assert up.check(force=True) is not None

    # A source checkout never updates itself.
    source = Updater(server(info_for("0.3.0", package)), None, version="0.2.0")
    assert source.check() is None
    with pytest.raises(UpdateError, match="git"):
        source.check(force=True)


def test_downloads_verifies_and_unpacks(tmp_path, monkeypatch):
    monkeypatch.setattr(Updater, "_smoke_test", staticmethod(lambda target, version: None))
    package = robot_zip("0.3.0")
    up = Updater(server(info_for("0.3.0", package), package), tmp_path, version="0.2.0")
    staged = up.prepare(up.check())
    assert staged == tmp_path / ".update" / "0.3.0"
    assert (staged / "python" / "python.exe").read_bytes() == b"exe"
    assert (staged / "VERSION.txt").read_text() == "0.3.0"
    assert not list((tmp_path / ".update").glob("*.zip"))  # the download is removed once unpacked


def test_rejects_damaged_or_unsafe_packages(tmp_path, monkeypatch):
    monkeypatch.setattr(Updater, "_smoke_test", staticmethod(lambda target, version: None))
    package = robot_zip("0.3.0")
    damaged = Updater(server(info_for("0.3.0", package), package + b"x"), tmp_path, version="0.2.0")
    with pytest.raises(UpdateError, match="checksum"):
        damaged.prepare(damaged.check())
    assert not list((tmp_path / ".update").glob("*.zip"))

    evil = robot_zip("0.3.0", {"Autoflow-Robot/../../evil.txt": b"x"})
    unsafe = Updater(server(info_for("0.3.0", evil), evil), tmp_path, version="0.2.0")
    with pytest.raises(UpdateError, match="unsafe"):
        unsafe.prepare(unsafe.check())
    assert not (tmp_path.parent / "evil.txt").exists()

    monkeypatch.setattr(updater.shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(10, 10, 0))
    full = Updater(server(info_for("0.3.0", package), package), tmp_path, version="0.2.0")
    with pytest.raises(UpdateError, match="disk space"):
        full.prepare(full.check())


def test_smoke_test_runs_the_new_python(tmp_path):
    target = tmp_path / "staged"
    (target / "python").mkdir(parents=True)
    with pytest.raises(UpdateError, match="incomplete"):
        Updater._smoke_test(target, "0.3.0")


def test_marks_the_running_version_for_the_update_script():
    updater.mark_started()
    state = updater.read_state()
    assert state["running_version"] == updater.__version__
    updater.mark_failed("9.9.9", "nope")
    assert updater.failed_versions() == {"9.9.9": "nope"}
    assert updater.read_state()["running_version"] == updater.__version__


# -- apply-update.ps1 -------------------------------------------------------------------------

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="PowerShell update script")
SCRIPT = Path(updater.__file__).with_name("apply-update.ps1")


def make_install(root: Path, staged: Path) -> None:
    """Old and new installs whose python(w).exe are harmless Windows programs."""
    harmless = Path(r"C:\Windows\System32\where.exe")
    for folder, marker in ((root / "python", "old"), (staged / "python", "new")):
        folder.mkdir(parents=True)
        for exe in ("python.exe", "pythonw.exe"):
            shutil.copy(harmless, folder / exe)
        (folder / f"{marker}.txt").write_text(marker)
    (root / "VERSION.txt").write_text("0.2.0")
    (staged / "VERSION.txt").write_text("0.3.0")


def run_script(root: Path, staged: Path, state: Path, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
         "-Root", str(root), "-Staged", str(staged), "-Version", "0.3.0", "-StateFile", str(state),
         "-HealthTimeoutSec", str(timeout), "-TaskName", "Autoflow Robot test (does not exist)"],
        capture_output=True, text=True, timeout=120,
    )


@windows_only
def test_update_script_swaps_versions_once_the_new_one_starts(tmp_path):
    root, staged = tmp_path / "Robot", tmp_path / "Robot" / ".update" / "0.3.0"
    make_install(root, staged)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"running_version": "0.2.0"}))

    def new_robot_reports_in():  # what the new robot does when it starts
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not (root / "python" / "new.txt").exists():
            time.sleep(0.2)
        state.write_text(json.dumps({"running_version": "0.3.0"}))

    threading.Thread(target=new_robot_reports_in, daemon=True).start()
    result = run_script(root, staged, state, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "python" / "new.txt").exists()
    assert not (root / "python.previous").exists() and not staged.exists()
    assert not (root / ".update" / "previous-files").exists()
    assert (root / "VERSION.txt").read_text() == "0.3.0"
    assert "Version 0.3.0 is running" in (root / ".update" / "update.log").read_text(encoding="utf-8-sig")


@windows_only
def test_update_script_goes_back_when_the_new_version_does_not_start(tmp_path):
    root, staged = tmp_path / "Robot", tmp_path / "Robot" / ".update" / "0.3.0"
    make_install(root, staged)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"running_version": "0.2.0"}))
    result = run_script(root, staged, state, timeout=3)
    assert result.returncode == 2, result.stdout + result.stderr
    assert (root / "python" / "old.txt").exists()  # the previous version is back
    assert (root / "VERSION.txt").read_text() == "0.2.0"
    assert (root / ".update" / "failed-0.3.0" / "new.txt").exists()
    assert not staged.exists() and not (root / ".update" / "previous-files").exists()
    saved = json.loads(state.read_text(encoding="utf-8-sig"))
    assert "did not start" in saved["failed"]["0.3.0"]


def test_update_messages_from_the_server():
    from autoflow_robot.agent import Agent

    agent = Agent.__new__(Agent)  # only the message handling is under test
    asked: list[bool] = []
    agent._check_for_update = asked.append
    agent._handle({"type": "robot.update"})  # an administrator pressed "Update now"
    agent._handle({"type": "robot.update", "force": False})  # a new package was copied to the server
    assert asked == [True, False]
