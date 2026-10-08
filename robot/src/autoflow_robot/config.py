"""Robot settings stored on the robot PC, with the robot token protected by Windows DPAPI."""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlparse

__version__ = "0.4.1"


def home() -> Path:
    base = os.environ.get("AUTOFLOW_ROBOT_HOME")
    if base:
        return Path(base)
    root = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(root) / "Autoflow" / "Robot"


@dataclass
class RobotConfig:
    server_url: str
    robot_id: str
    name: str
    token_protected: str  # DPAPI-protected (Windows) or base64 (elsewhere)
    pool: str = "default"
    pinned_cert: str | None = None  # PEM of a self-signed server certificate trusted at enrollment
    capabilities: list[str] = field(default_factory=lambda: ["browser", "excel", "files", "desktop"])

    @property
    def token(self) -> str:
        return unprotect(self.token_protected)

    def save(self, path: Path | None = None) -> Path:
        path = path or home() / "robot.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        tmp.replace(path)
        return path

    @classmethod
    def load(cls, path: Path | None = None) -> RobotConfig:
        path = path or home() / "robot.json"
        if not path.exists():
            raise FileNotFoundError(
                f"This robot is not enrolled yet ({path} is missing). Run: autoflow-robot enroll --server URL --key KEY"
            )
        return cls(**json.loads(path.read_text(encoding="utf-8")))

    @property
    def ws_url(self) -> str:
        u = urlparse(self.server_url)
        scheme = "wss" if u.scheme == "https" else "ws"
        return f"{scheme}://{u.netloc}/api/robot/connect"

    def ssl_context(self) -> ssl.SSLContext | None:
        return ssl_context(self.server_url, self.pinned_cert)


def ssl_context(server_url: str, pinned_pem: str | None) -> ssl.SSLContext | None:
    if not server_url.startswith("https"):
        return None
    if pinned_pem:
        # Trust exactly the certificate seen (and confirmed) at enrollment.
        ctx = ssl.create_default_context(cadata=pinned_pem)
        ctx.check_hostname = False
        return ctx
    return ssl.create_default_context()


# -- DPAPI -----------------------------------------------------------------------------


def protect(secret: str) -> str:
    if sys.platform != "win32":
        return "b64:" + base64.b64encode(secret.encode()).decode()
    return "dpapi:" + base64.b64encode(_dpapi(secret.encode(), protect=True)).decode()


def unprotect(stored: str) -> str:
    kind, _, data = stored.partition(":")
    raw = base64.b64decode(data)
    if kind == "b64":
        return raw.decode()
    if kind == "dpapi":
        return _dpapi(raw, protect=False).decode()
    raise ValueError("Unknown token format")


def _dpapi(data: bytes, protect: bool) -> bytes:
    """CryptProtectData / CryptUnprotectData for the current Windows user (no extra packages)."""
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buffer = ctypes.create_string_buffer(data, len(data))
    blob_in = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    blob_out = Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, None, None, None, 0x1, ctypes.byref(blob_out))  # 0x1: UI forbidden
    if not ok:
        raise OSError("Windows could not protect/unprotect the robot token (DPAPI).")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)
