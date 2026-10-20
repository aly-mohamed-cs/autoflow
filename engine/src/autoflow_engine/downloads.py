"""Saving files a website downloads, with the website's own file name.

Playwright keeps every download in a temporary folder under a random name without an
extension, and deletes it when the browser closes. Autoflow saves each one with its real
name instead: the "Download file" step into the folder it was given, any other download
(a plain click on an "Export to Excel" button...) into the Downloads folder.
"""

from __future__ import annotations

import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

Log = Callable[[str, str], None]

_EXCEL = {".xls", ".xlsx", ".xlsm"}


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
    existing: Literal["replace", "fail", "keep_both"],
    log: Log,
) -> Path:
    """Save a Playwright download into `folder` (the website's file name unless `name` is given)."""
    from .errors import ActivityError

    suggested = download.suggested_filename or "download"
    chosen = bool(name.strip())
    name = name.strip() or suggested
    if not Path(name).suffix and Path(suggested).suffix:
        name += Path(suggested).suffix
    folder.mkdir(parents=True, exist_ok=True)
    # First under a temporary name ("Wait for file" skips .part files): the contents decide the
    # final name, and replacing / keeping both applies to that name.
    part = folder / f".autoflow-{uuid.uuid4().hex[:12]}.part"
    try:
        download.save_as(str(part))
        failure = download.failure()
        if failure:
            raise ActivityError(f"The download failed: {failure}")
        path = folder / proper_name(name, sniff(part), log, chosen=chosen)
        if path.exists():
            if existing == "fail":
                raise ActivityError(f"'{path}' already exists.")
            if existing == "replace":
                path.unlink()
            else:
                path = unique_path(path)
        part.replace(path)
    finally:
        part.unlink(missing_ok=True)
    return path


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
