"""Self-update: robots install new versions published on the Orchestrator by themselves.

update-server.ps1 -Installers copies Autoflow-Robot-<version>.zip into the Orchestrator's
Downloads. When a newer version is there and no job is running, the robot:

  1. downloads it over its usual (certificate-pinned) connection and checks the SHA-256,
  2. unpacks it next to the current install and checks that the new Python starts,
  3. hands over to apply-update.ps1 and exits. The script swaps the folders, starts the
     robot again, and puts the old version back if the new one doesn't start.

Only installs made from the robot zip update themselves; a source checkout uses git.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

import httpx

from .config import __version__, home

log = logging.getLogger("autoflow.robot.update")

BUNDLE_FILES = ("install-robot.ps1", "ROBOT-SETUP.md", "VERSION.txt")


class UpdateError(Exception):
    """A problem worth showing in the dashboard ("Could not update to 0.3.0: ...")."""


@dataclass
class Release:
    version: str
    url: str
    size: int
    sha256: str


def install_root() -> Path | None:
    """The folder the robot zip was unpacked to (it holds python\\ and VERSION.txt), if any."""
    override = os.environ.get("AUTOFLOW_ROBOT_INSTALL_ROOT")
    if override:
        return Path(override)
    python_dir = Path(sys.executable).resolve().parent
    if python_dir.name.lower() == "python" and (python_dir.parent / "VERSION.txt").exists():
        return python_dir.parent
    return None


def version_key(version: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in version.split("."))
    except ValueError:
        return (0,)


def is_newer(candidate: str, current: str) -> bool:
    return version_key(candidate) > version_key(current)


# -- what the updater remembers between runs (shared with apply-update.ps1) -------------------


def state_file() -> Path:
    return home() / "update-state.json"


def read_state() -> dict[str, Any]:
    try:
        # PowerShell 5 writes a byte-order mark.
        return json.loads(state_file().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def write_state(state: dict[str, Any]) -> None:
    path = state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(path)


def mark_started() -> None:
    """Tells apply-update.ps1 that this version came up (called when the robot starts)."""
    state = read_state()
    state["running_version"] = __version__
    state["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_state(state)


def failed_versions() -> dict[str, str]:
    failed = read_state().get("failed")
    return failed if isinstance(failed, dict) else {}


def mark_failed(version: str, reason: str) -> None:
    state = read_state()
    state.setdefault("failed", {})[version] = reason[:300]
    write_state(state)


class Updater:
    def __init__(self, http: httpx.Client, root: Path | None, version: str = __version__):
        self.http = http
        self.root = root
        self.version = version

    @property
    def work_dir(self) -> Path:
        assert self.root is not None
        return self.root / ".update"

    def check(self, force: bool = False) -> Release | None:
        """A newer version to install, or None. ``force``: an administrator asked for it."""
        if self.root is None:
            if force:
                raise UpdateError("This robot runs from a source checkout; update it with git.")
            return None
        r = self.http.get("/api/robot/update")
        r.raise_for_status()
        data = r.json()
        version = data.get("version")
        if not version or not is_newer(version, self.version):
            return None
        if not force and not data.get("automatic", True):
            return None
        if not force and version in failed_versions():
            return None  # it failed before; an administrator can still press "Update now"
        return Release(version, data["url"], int(data.get("size") or 0), str(data["sha256"]).lower())

    def prepare(self, release: Release) -> Path:
        """Download, verify and unpack the new version; returns the folder holding its python\\."""
        try:
            self.work_dir.mkdir(exist_ok=True)
        except OSError as exc:
            raise UpdateError(f"The robot can't write to its install folder ({self.root}). "
                              "Reinstall it in a folder the robot account owns.") from exc
        needed = max(release.size, 1) * 4  # the zip plus the unpacked copy
        if shutil.disk_usage(self.work_dir).free < needed:
            raise UpdateError(f"Not enough free disk space (needs about {needed // 1_048_576} MB).")
        archive = self.work_dir / f"Autoflow-Robot-{release.version}.zip"
        self._download(release, archive)
        target = self.work_dir / release.version
        try:
            if target.exists():
                shutil.rmtree(target)
            _extract(archive, target)
        finally:
            archive.unlink(missing_ok=True)
        self._smoke_test(target, release.version)
        return target

    def _download(self, release: Release, archive: Path) -> None:
        digest = hashlib.sha256()
        with self.http.stream("GET", release.url, timeout=httpx.Timeout(60, read=300)) as r:
            r.raise_for_status()
            with archive.open("wb") as fh:
                for chunk in r.iter_bytes(1 << 20):
                    digest.update(chunk)
                    fh.write(chunk)
        if digest.hexdigest() != release.sha256:
            archive.unlink(missing_ok=True)
            raise UpdateError("The downloaded file is damaged (its checksum doesn't match). It will be tried again later.")

    @staticmethod
    def _smoke_test(target: Path, version: str) -> None:
        python = target / "python" / "python.exe"
        if not python.exists():
            raise UpdateError("The robot package is incomplete (python.exe is missing).")
        try:
            out = subprocess.run([str(python), "-m", "autoflow_robot.cli", "--version"], capture_output=True,
                                 text=True, timeout=120, creationflags=_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise UpdateError(f"The new version does not start: {exc}") from exc
        if version not in (out.stdout + out.stderr):
            raise UpdateError(f"The new version does not start properly: {(out.stderr or out.stdout).strip()[-300:]}")

    def hand_over(self, staged: Path, version: str) -> None:
        """Start apply-update.ps1 (from outside the folders it replaces); the robot must exit next."""
        script = self.work_dir / "apply-update.ps1"
        source = resources.files("autoflow_robot").joinpath("apply-update.ps1")
        script.write_bytes(source.read_bytes())
        command = [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
            "-File", str(script), "-Root", str(self.root), "-Staged", str(staged), "-Version", version,
            "-StateFile", str(state_file()), "-WaitPid", str(os.getpid()),
        ]
        _spawn_detached(command)

    def cleanup(self) -> None:
        """Remove leftovers of finished updates (not while apply-update.ps1 may still need them)."""
        if self.root is None or not self.work_dir.exists():
            return
        cutoff = time.time() - 86_400
        for entry in self.work_dir.iterdir():
            if entry.name in ("update.log", "apply-update.ps1"):
                continue
            with contextlib.suppress(OSError):
                if entry.stat().st_mtime >= cutoff:
                    continue
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _extract(archive: Path, target: Path) -> None:
    """Unpack the robot zip (whose files sit in an "Autoflow-Robot" folder) into ``target``."""
    target.mkdir(parents=True)
    base = target.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            parts = Path(member.filename.replace("\\", "/")).parts
            if parts and parts[0].lower() == "autoflow-robot":
                parts = parts[1:]
            if not parts:
                continue
            destination = (target.joinpath(*parts)).resolve()
            if not destination.is_relative_to(base):
                raise UpdateError("The robot package contains unsafe file names.")
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, destination.open("wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)


def _spawn_detached(command: list[str]) -> None:
    """Start a process that outlives the robot (and the scheduled task that started it)."""
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        try:
            subprocess.Popen(command, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
            return
        except OSError:
            pass  # the job object doesn't allow breaking away; the child still outlives the robot
    subprocess.Popen(command, creationflags=flags, close_fds=True)
