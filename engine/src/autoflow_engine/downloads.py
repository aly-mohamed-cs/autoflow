"""Files a website downloads, with the website's own file name.

Left to Playwright, a download is kept in a temporary folder under a random name without an
extension, and deleted when the browser closes. So Autoflow lets the browser save downloads
itself, with their real names, straight into the Downloads folder (its own download list then
opens them) - see BrowserDownloads. If that can't be switched on, Autoflow copies each download
out of Playwright's folder instead (save()).
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

Log = Callable[[str, str], None]
Existing = Literal["replace", "fail", "keep_both"]

_EXCEL = {".xls", ".xlsx", ".xlsm"}
PARTIAL = (".crdownload", ".tmp", ".part", ".download")


class BrowserDownloads:
    """The browser saves downloads itself, with their real names, into a folder Autoflow chooses."""

    def __init__(self, context: Any):
        browser = context.browser
        if browser is None:
            raise RuntimeError("no browser")
        self._cdp = browser.new_browser_cdp_session()
        # A persistent context (a normal, not private, window) is the browser's default context.
        self._contexts = self._cdp.send("Target.getBrowserContexts").get("browserContextIds") or [None]
        self.folder = downloads_folder()
        self.save_into(self.folder)

    def save_into(self, folder: Path) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        for context_id in self._contexts:
            params: dict[str, Any] = {"behavior": "allow", "downloadPath": str(folder), "eventsEnabled": True}
            if context_id:
                params["browserContextId"] = context_id
            self._cdp.send("Browser.setDownloadBehavior", params)
        self.folder = folder


def located(download: Any, folder: Path) -> Path:
    """Wait until the browser has saved `download` into `folder`; the file."""
    from .errors import ActivityError

    failure = download.failure()  # waits for the end of the download
    if failure:
        raise ActivityError(f"The download failed: {failure}")
    path = folder / download.suggested_filename
    if path.is_file():
        return path
    # The browser changed the name (a character Windows doesn't allow...): the newest file then.
    recent = [
        f for f in folder.iterdir()
        if f.is_file() and not f.name.lower().endswith(PARTIAL) and time.time() - f.stat().st_mtime < 120
    ]
    if not recent:
        raise ActivityError(f"The downloaded file '{download.suggested_filename}' was not found in {folder}.")
    return max(recent, key=lambda f: f.stat().st_mtime)


def target_name(chosen: str, website: str, kind: str | None, log: Log) -> str:
    """The name to keep: the person's (with the website's extension if it has none) or the website's."""
    name = chosen.strip() or website or "download"
    own_extension = bool(Path(chosen.strip()).suffix)  # "orders" lets the contents decide
    if not Path(name).suffix and Path(website).suffix:
        name += Path(website).suffix
    return proper_name(name, kind, log, chosen=own_extension)


def place(source: Path, target: Path, existing: Existing) -> Path:
    """Move a downloaded file to `target` (replacing, refusing or keeping both if one is there)."""
    from .errors import ActivityError

    if os.path.normcase(str(source)) == os.path.normcase(str(target)):
        return source
    if target.exists():
        if existing == "fail":
            raise ActivityError(f"'{target}' already exists.")
        if existing == "replace":
            target.unlink()
        else:
            target = unique_path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return target


def downloads_folder() -> Path:
    """The Downloads folder of the account running the automation (also on robots)."""
    from .activities.system import _FOLDERS, _known_folder

    try:
        found = _known_folder(_FOLDERS["downloads"])
    except Exception:  # not Windows
        found = None
    return Path(found) if found else Path.home() / "Downloads"


def unique_path(path: Path) -> Path:
    """`path`, or "name (1).ext", "name (2).ext"... like a browser, when it already exists."""
    n = 1
    candidate = path
    while candidate.exists():
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        n += 1
    return candidate


def save(
    download: Any,
    folder: Path,
    name: str = "",
    *,
    existing: Existing,
    log: Log,
) -> Path:
    """Copy a download out of Playwright's folder into `folder` (the website's name unless `name` is given)."""
    from .errors import ActivityError

    folder.mkdir(parents=True, exist_ok=True)
    # First under a temporary name ("Wait for file" skips .part files): the contents decide the
    # final name, and replacing / keeping both applies to that name.
    part = folder / f".autoflow-{uuid.uuid4().hex[:12]}.part"
    try:
        download.save_as(str(part))
        failure = download.failure()
        if failure:
            raise ActivityError(f"The download failed: {failure}")
        name = target_name(name, download.suggested_filename or "download", sniff(part), log)
        return place(part, folder / name, existing)
    finally:
        part.unlink(missing_ok=True)


def proper_name(name: str, kind: str | None, log: Log, *, chosen: bool = False) -> str:
    """The file name with the extension its contents (`kind`) need, so Excel opens it without a warning.

    A missing extension is added. A website's name with the wrong Excel extension (an .xlsx file
    called .xls) is corrected; a name the person chose is kept, with a warning.
    """
    suffix = Path(name).suffix.lower()
    if kind is None or kind == suffix or (kind == ".xlsx" and suffix == ".xlsm"):
        return name
    if kind == ".html":
        if suffix in _EXCEL:
            log(
                f"'{name}' is really a web page (an HTML table) with an Excel name, so Excel warns that the "
                "format and extension don't match. Open it in Excel and save it as .xlsx, or read the table from "
                "the website with 'Extract table'.",
                "warning",
            )
        return name
    if suffix and not (suffix in _EXCEL and kind in _EXCEL):
        return name  # e.g. a .csv: its contents can't be told apart reliably
    if chosen and suffix:
        log(f"'{name}' is an {kind} file, so Excel may warn that the format and extension don't match.", "warning")
        return name
    fixed = (Path(name).stem if suffix else name) + kind
    told = f"called the file '{name}'" if suffix else "gave the file no extension"
    log(f"The website {told}, but it is an {kind} file, so it was saved as '{fixed}'.", "info")
    return fixed


def sniff(path: Path) -> str | None:
    """The extension a file's contents say it should have (only kinds that are certain)."""
    try:
        with path.open("rb") as f:
            head = f.read(2 * 1024 * 1024)
    except OSError:
        return None
    if head.startswith(b"%PDF"):
        return ".pdf"
    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
        except (zipfile.BadZipFile, OSError):
            return None
        for prefix, ext in (("xl/", ".xlsx"), ("word/", ".docx"), ("ppt/", ".pptx")):
            if any(n.startswith(prefix) for n in names):
                return ext
        return ".zip"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):  # old Office file: its main part says which
        for part, ext in (("WordDocument", ".doc"), ("PowerPoint Document", ".ppt"), ("Workbook", ".xls"), ("Book", ".xls")):
            if part.encode("utf-16-le") in head:
                return ext
        return None
    start = head.lstrip(b"\xef\xbb\xbf \t\r\n")[:512].lower()
    if start.startswith((b"<!doctype html", b"<html", b"<table")) or (start.startswith(b"<") and b"<table" in head[:8192].lower()):
        return ".html"
    return None
