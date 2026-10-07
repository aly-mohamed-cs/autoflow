"""Files and folders: copy, move, list, wait for, read/write text and CSV, ZIP."""

from __future__ import annotations

import csv
import datetime as dt
import fnmatch
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import Table, to_text

F = "Files"


def _path(value: Any, what: str = "file") -> Path:
    text = to_text(value).strip().strip('"')
    if not text:
        raise ActivityError(f"No {what} was given.", f"Choose a {what} in the step settings.")
    return Path(text).expanduser()


def _existing_file(value: Any) -> Path:
    path = _path(value)
    if not path.exists():
        raise ActivityError(f"The file '{path}' does not exist.", "Check the path, or add a 'Wait for file' step first.")
    if path.is_dir():
        raise ActivityError(f"'{path}' is a folder, not a file.")
    return path


def _existing_folder(value: Any) -> Path:
    path = _path(value, "folder")
    if not path.is_dir():
        raise ActivityError(f"The folder '{path}' does not exist.", "Check the path or create the folder first.")
    return path


def _target(source: Path, destination: Path, overwrite: bool) -> Path:
    # An existing folder, or a new path without an extension, means "into this folder".
    as_folder = destination.is_dir() or (not destination.exists() and not destination.suffix)
    target = destination / source.name if as_folder else destination
    if target.exists() and not overwrite:
        raise ActivityError(
            f"'{target}' already exists.", "Turn on 'Replace if it exists', or choose another destination."
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


class CopyMoveParams(Params):
    source: str = Param(title="File", ui="file")
    destination: str = Param(title="To folder or new file path", ui="folder")
    overwrite: bool = Param(False, title="Replace if it exists")


@activity(
    "files.copy",
    title="Copy file",
    category=F,
    icon="copy",
    sentence="Copy {source} to {destination}",
    params=CopyMoveParams,
    outputs=[OutputDef("file", "New file", "file", default_variable="copied_file")],
)
def copy_file(ctx: RunContext, p: CopyMoveParams) -> str:
    source = _existing_file(p.source)
    target = _target(source, _path(p.destination, "destination"), p.overwrite)
    shutil.copy2(source, target)
    return str(target)


@activity(
    "files.move",
    title="Move file",
    category=F,
    icon="file-output",
    sentence="Move {source} to {destination}",
    params=CopyMoveParams,
    outputs=[OutputDef("file", "New location", "file", default_variable="moved_file")],
)
def move_file(ctx: RunContext, p: CopyMoveParams) -> str:
    source = _existing_file(p.source)
    target = _target(source, _path(p.destination, "destination"), p.overwrite)
    if target.exists():
        target.unlink()
    shutil.move(str(source), target)
    return str(target)


class RenameParams(Params):
    file: str = Param(title="File", ui="file")
    new_name: str = Param(title="New name", placeholder="report-{{FORMATDATE(TODAY(), 'YYYY-MM-DD')}}.xlsx")
    keep_extension: bool = Param(True, title="Keep the file extension if none is given")


@activity(
    "files.rename",
    title="Rename file",
    category=F,
    icon="pencil",
    sentence="Rename {file} to {new_name}",
    params=RenameParams,
    outputs=[OutputDef("file", "Renamed file", "file", default_variable="renamed_file")],
)
def rename_file(ctx: RunContext, p: RenameParams) -> str:
    source = _existing_file(p.file)
    name = to_text(p.new_name).strip()
    if not name or any(c in name for c in '\\/:*?"<>|'):
        raise ActivityError(f"'{name}' is not a valid file name.", 'File names cannot contain \\ / : * ? " < > |')
    if p.keep_extension and not Path(name).suffix:
        name += source.suffix
    target = source.with_name(name)
    if target.exists():
        raise ActivityError(f"A file named '{name}' already exists in that folder.")
    source.rename(target)
    return str(target)


class DeleteParams(Params):
    path: str = Param(title="File or folder", ui="file")
    missing_ok: bool = Param(True, title="Don't fail if it doesn't exist")


@activity(
    "files.delete",
    title="Delete file or folder",
    category=F,
    icon="trash-2",
    sentence="Delete {path}",
    params=DeleteParams,
)
def delete(ctx: RunContext, p: DeleteParams) -> None:
    path = _path(p.path, "file or folder")
    if not path.exists():
        if p.missing_ok:
            return
        raise ActivityError(f"'{path}' does not exist.")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


class CreateFolderParams(Params):
    folder: str = Param(title="Folder", ui="folder")


@activity(
    "files.create_folder",
    title="Create folder",
    category=F,
    icon="folder-plus",
    sentence="Create folder {folder}",
    description="Creates the folder (and any missing parent folders). Does nothing if it already exists.",
    params=CreateFolderParams,
    outputs=[OutputDef("folder", "Folder", "file", default_variable="folder")],
)
def create_folder(ctx: RunContext, p: CreateFolderParams) -> str:
    path = _path(p.folder, "folder")
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


class ListFilesParams(Params):
    folder: str = Param(title="Folder", ui="folder")
    pattern: str = Param("*", title="Name pattern", placeholder="*.xlsx", description="* matches anything.")
    include_subfolders: bool = Param(False, title="Include subfolders")
    sort_by: Literal["name", "newest", "oldest"] = Param("name", title="Sort by")


@activity(
    "files.list",
    title="List files in folder",
    category=F,
    icon="folder-search",
    sentence="List {pattern} files in {folder}",
    params=ListFilesParams,
    outputs=[OutputDef("files", "Files", "list", default_variable="files")],
)
def list_files(ctx: RunContext, p: ListFilesParams) -> list[str]:
    folder = _existing_folder(p.folder)
    candidates = folder.rglob("*") if p.include_subfolders else folder.iterdir()
    patterns = [x.strip() for x in to_text(p.pattern).split(";") if x.strip()] or ["*"]
    found = [f for f in candidates if f.is_file() and any(fnmatch.fnmatch(f.name.lower(), x.lower()) for x in patterns)]
    if p.sort_by == "name":
        found.sort(key=lambda f: str(f).lower())
    else:
        found.sort(key=lambda f: f.stat().st_mtime, reverse=p.sort_by == "newest")
    return [str(f) for f in found]


class ExistsParams(Params):
    path: str = Param(title="File or folder", ui="file")


@activity(
    "files.exists",
    title="Check if file exists",
    category=F,
    icon="file-question",
    sentence="Check if {path} exists",
    params=ExistsParams,
    outputs=[OutputDef("exists", "Exists", "boolean", default_variable="file_exists")],
)
def exists(ctx: RunContext, p: ExistsParams) -> bool:
    return _path(p.path, "file or folder").exists()


class WaitForFileParams(Params):
    folder: str = Param(title="Folder", ui="folder")
    pattern: str = Param("*", title="Name pattern", placeholder="report*.xlsx")
    timeout: float = Param(60, title="Wait up to (seconds)", ge=1, le=86_400, ui="duration")
    newer_than_start: bool = Param(
        True, title="Only files created after this step started", description="Ignore files that were already there."
    )


@activity(
    "files.wait_for_file",
    title="Wait for file",
    category=F,
    icon="file-clock",
    sentence="Wait for {pattern} in {folder}",
    description="Wait until a file appears, for example a download or an export from another system.",
    params=WaitForFileParams,
    outputs=[OutputDef("file", "File", "file", default_variable="new_file")],
)
def wait_for_file(ctx: RunContext, p: WaitForFileParams) -> str:
    folder = _path(p.folder, "folder")
    started = time.time() - 1
    deadline = time.monotonic() + p.timeout
    partial = (".crdownload", ".tmp", ".part", ".download")
    while True:
        if folder.is_dir():
            for f in sorted(folder.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if not f.is_file() or f.name.lower().endswith(partial) or f.name.startswith("~$"):
                    continue
                if not fnmatch.fnmatch(f.name.lower(), to_text(p.pattern).lower()):
                    continue
                if p.newer_than_start and f.stat().st_mtime < started:
                    continue
                if _is_stable(f):
                    return str(f)
        if time.monotonic() >= deadline:
            raise ActivityError(
                f"No file matching '{p.pattern}' appeared in '{folder}' within {p.timeout:g} seconds.",
                "Check that the file is saved to this folder, or wait longer.",
            )
        ctx.sleep(0.5)


def _is_stable(path: Path) -> bool:
    """True when the file is no longer being written."""
    try:
        size = path.stat().st_size
        time.sleep(0.3)
        if path.stat().st_size != size:
            return False
        with path.open("rb"):
            return True
    except OSError:
        return False


class FileInfoParams(Params):
    file: str = Param(title="File", ui="file")


@activity(
    "files.info",
    title="Get file details",
    category=F,
    icon="info",
    sentence="Get details of {file}",
    params=FileInfoParams,
    outputs=[OutputDef("info", "Details (name, folder, extension, size_kb, modified)", "any", default_variable="file_info")],
)
def file_info(ctx: RunContext, p: FileInfoParams) -> dict[str, Any]:
    path = _existing_file(p.file)
    stat = path.stat()
    return {
        "name": path.name,
        "name_without_extension": path.stem,
        "extension": path.suffix.lstrip("."),
        "folder": str(path.parent),
        "size_kb": round(stat.st_size / 1024, 1),
        "modified": dt.datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0),
    }


class ReadTextParams(Params):
    file: str = Param(title="File", ui="file", file_types=["txt", "csv", "json", "xml", "log"])
    encoding: str = Param("utf-8", title="Encoding", advanced=True)


@activity(
    "files.read_text",
    title="Read text file",
    category=F,
    icon="file-text",
    sentence="Read text from {file}",
    params=ReadTextParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="file_text")],
)
def read_text(ctx: RunContext, p: ReadTextParams) -> str:
    return _existing_file(p.file).read_text(encoding=p.encoding, errors="replace")


class WriteTextParams(Params):
    file: str = Param(title="File", ui="save_file")
    text: str = Param(title="Text", ui="multiline")
    append: bool = Param(False, title="Add to the end instead of replacing")
    encoding: str = Param("utf-8", title="Encoding", advanced=True)


@activity(
    "files.write_text",
    title="Write text file",
    category=F,
    icon="file-pen",
    sentence="Write text to {file}",
    params=WriteTextParams,
)
def write_text(ctx: RunContext, p: WriteTextParams) -> None:
    path = _path(p.file)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a" if p.append else "w", encoding=p.encoding, newline="") as fh:
        fh.write(to_text(p.text))


class ReadCsvParams(Params):
    file: str = Param(title="CSV file", ui="file", file_types=["csv", "txt"])
    delimiter: str = Param("auto", title="Separator", description="auto, comma (,), semicolon (;), tab")
    has_header: bool = Param(True, title="First row has column names")
    encoding: str = Param("utf-8-sig", title="Encoding", advanced=True)


_DELIMITERS = {"comma": ",", "semicolon": ";", "tab": "\t", "pipe": "|"}


@activity(
    "files.read_csv",
    title="Read CSV file",
    category=F,
    icon="file-spreadsheet",
    sentence="Read CSV {file}",
    params=ReadCsvParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="csv_table")],
)
def read_csv(ctx: RunContext, p: ReadCsvParams) -> Table:
    path = _existing_file(p.file)
    text = path.read_text(encoding=p.encoding, errors="replace")
    delimiter = _DELIMITERS.get(p.delimiter.lower(), p.delimiter)
    if delimiter == "auto":
        try:
            delimiter = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    rows = list(csv.reader(text.splitlines(), delimiter=delimiter))
    return Table.from_matrix([r for r in rows if any(c.strip() for c in r)], p.has_header)


class WriteCsvParams(Params):
    table: Any = Param(title="Table", ui="variable")
    file: str = Param(title="CSV file", ui="save_file", file_types=["csv"])
    delimiter: str = Param(",", title="Separator")
    include_header: bool = Param(True, title="Write column names")
    encoding: str = Param("utf-8-sig", title="Encoding", advanced=True, description="utf-8-sig opens correctly in Excel.")


@activity(
    "files.write_csv",
    title="Write CSV file",
    category=F,
    icon="file-down",
    sentence="Write {table} to CSV {file}",
    params=WriteCsvParams,
)
def write_csv(ctx: RunContext, p: WriteCsvParams) -> None:
    if not isinstance(p.table, Table):
        raise ActivityError("The value to write is not a table.", "Pick a table variable, e.g. one read from Excel.")
    path = _path(p.file)
    path.parent.mkdir(parents=True, exist_ok=True)
    delimiter = _DELIMITERS.get(p.delimiter.lower(), p.delimiter)
    with path.open("w", encoding=p.encoding, newline="") as fh:
        writer = csv.writer(fh, delimiter=delimiter)
        for row in p.table.to_matrix(p.include_header):
            writer.writerow([to_text(c) for c in row])


class ZipParams(Params):
    source: str = Param(title="File or folder to compress", ui="folder")
    zip_file: str = Param(title="ZIP file", ui="save_file", file_types=["zip"])


@activity(
    "files.zip",
    title="Create ZIP",
    category=F,
    icon="file-archive",
    sentence="Compress {source} into {zip_file}",
    params=ZipParams,
    outputs=[OutputDef("file", "ZIP file", "file", default_variable="zip_file")],
)
def make_zip(ctx: RunContext, p: ZipParams) -> str:
    source = _path(p.source, "file or folder")
    if not source.exists():
        raise ActivityError(f"'{source}' does not exist.")
    target = _path(p.zip_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        if source.is_dir():
            for f in source.rglob("*"):
                if f.is_file() and f != target:
                    zf.write(f, f.relative_to(source))
        else:
            zf.write(source, source.name)
    return str(target)


class UnzipParams(Params):
    zip_file: str = Param(title="ZIP file", ui="file", file_types=["zip"])
    destination: str = Param(title="Extract to folder", ui="folder")


@activity(
    "files.unzip",
    title="Extract ZIP",
    category=F,
    icon="package-open",
    sentence="Extract {zip_file} to {destination}",
    params=UnzipParams,
    outputs=[OutputDef("files", "Extracted files", "list", default_variable="extracted_files")],
)
def unzip(ctx: RunContext, p: UnzipParams) -> list[str]:
    source = _existing_file(p.zip_file)
    dest = _path(p.destination, "folder").resolve()
    dest.mkdir(parents=True, exist_ok=True)
    extracted = []
    with zipfile.ZipFile(source) as zf:
        for member in zf.infolist():
            target = (dest / member.filename).resolve()
            if not target.is_relative_to(dest):  # block "zip slip" paths like ../../x
                raise ActivityError(f"The ZIP contains an unsafe path: {member.filename}")
            zf.extract(member, dest)
            if not member.is_dir():
                extracted.append(str(target))
    return extracted
