"""Windows and system helpers (Brity "System" library): commands and scripts, the clipboard,
special folders, opening files, the registry; waiting on files; JSON / XML; encryption and Base64.

Steps that can run any code ("Run command", "Run Python script", "Write registry value") are
marked `requires="scripts"`: the Orchestrator only accepts automations with them from
administrators (or from builders when an administrator allows it).
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Literal

from ..catalog import NoParams, OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import Deadline, RunContext, wait
from ..values import Table, to_jsonable, to_text

S = "System"


# -- commands and scripts --------------------------------------------------------------------------


class CommandParams(Params):
    command: str = Param(title="Command", ui="code", placeholder='robocopy "C:\\In" "D:\\Backup" /MIR')
    shell: Literal["cmd", "powershell"] = Param("cmd", title="Run with", labels={"cmd": "Command prompt", "powershell": "PowerShell"})
    folder: str = Param("", title="In folder", ui="folder", advanced=True)
    timeout: float = Param(300, title="Stop it after (seconds)", ge=1, le=86_400, ui="duration", advanced=True)
    fail_on_error: bool = Param(True, title="Fail when it reports an error (exit code not 0)", advanced=True)


@activity(
    "system.run_command",
    title="Run command",
    category=S,
    icon="square-terminal",
    sentence="Run {command}",
    description="Run a command or PowerShell script and keep what it printed (Brity ExecuteCmd). "
    "Only administrators can publish automations with this step.",
    params=CommandParams,
    outputs=[
        OutputDef("output", "Output", "text", default_variable="command_output"),
        OutputDef("exit_code", "Exit code", "number", default_variable="exit_code"),
    ],
    requires="scripts",
)
def run_command(ctx: RunContext, p: CommandParams) -> dict[str, Any]:
    command = to_text(p.command).strip()
    if not command:
        raise ActivityError("There is no command to run.")
    if p.shell == "powershell":
        args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
    else:
        args = ["cmd.exe", "/d", "/s", "/c", command]
    folder = to_text(p.folder).strip() or None
    result = _run(ctx, args, p.timeout, cwd=folder)
    output = (result.stdout + (("\n" + result.stderr) if result.stderr.strip() else "")).strip()
    if p.fail_on_error and result.returncode != 0:
        raise ActivityError(f"The command failed (exit code {result.returncode}): {output[-500:] or 'no output'}")
    return {"output": output, "exit_code": result.returncode}


def _run(ctx: RunContext, args: list[str], timeout: float, *, cwd: str | None = None,
         stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run a process; Stop still works while it runs, and it is ended after the timeout."""
    try:
        process = subprocess.Popen(
            args, cwd=cwd, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise ActivityError(f"Could not start it: {exc}") from None
    deadline = Deadline(timeout)
    try:
        if stdin is not None:
            process.stdin.write(stdin)  # type: ignore[union-attr]
            process.stdin.close()  # type: ignore[union-attr]
        while process.poll() is None:
            if ctx.control.cancelled or deadline.passed:
                process.kill()
                if deadline.passed:
                    raise ActivityError(f"It did not finish within {timeout:g} seconds and was stopped.")
                break
            wait(0.1)
        stdout, stderr = process.communicate(timeout=10)
    finally:
        if process.poll() is None:
            process.kill()
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


class PythonParams(Params):
    code: str = Param(
        title="Python code", ui="code",
        placeholder="total = sum(row['Amount'] for row in inputs['rows'])\nresult = round(total, 2)",
        description="Values handed over are in `inputs`; put the answer in `result`.",
    )
    inputs: dict[str, Any] = Param(default_factory=dict, title="Values to hand to it", ui="key_values")
    timeout: float = Param(120, title="Stop it after (seconds)", ge=1, le=86_400, ui="duration", advanced=True)


_RUNNER = r"""
import json, sys
data = json.loads(sys.stdin.read())
scope = {"inputs": data["inputs"], "result": None}
exec(compile(data["code"], "<step>", "exec"), scope)
sys.stdout.write("\n__AUTOFLOW_RESULT__" + json.dumps(scope.get("result"), default=str))
"""


@activity(
    "system.run_python",
    title="Run Python script",
    category=S,
    icon="file-code",
    sentence="Run a Python script",
    description="For what no step does: run a few lines of Python in a separate process (Brity ExecuteScript / "
    "Python library). Only administrators can publish automations with this step.",
    params=PythonParams,
    outputs=[OutputDef("result", "Result", "any", default_variable="script_result")],
    requires="scripts",
)
def run_python(ctx: RunContext, p: PythonParams) -> Any:
    payload = json.dumps({"code": to_text(p.code), "inputs": _plain(p.inputs)}, default=str)
    result = _run(ctx, [sys.executable, "-I", "-c", _RUNNER], p.timeout, stdin=payload)
    out, marker, value = result.stdout.rpartition("\n__AUTOFLOW_RESULT__")
    for line in (out if marker else result.stdout).strip().splitlines()[-20:]:
        ctx.log(f"script: {line}")
    if result.returncode != 0 or not marker:
        error = result.stderr.strip().splitlines()
        raise ActivityError(f"The script failed: {error[-1] if error else 'no result'}",
                            "The full error is in the run log." if len(error) > 1 else None)
    if result.stderr.strip():
        ctx.log(result.stderr.strip()[-2000:], "warning")
    return json.loads(value)


def _plain(value: Any) -> Any:
    """Values as a script sees them: tables become lists of rows (dicts), dates become text."""
    if isinstance(value, Table):
        return [{k: _plain(v) for k, v in dict(row).items()} for row in value.rows]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    if value is None or isinstance(value, bool | int | float | str):
        return value
    return to_text(value)


# -- clipboard, folders, files -----------------------------------------------------------------------


@activity(
    "system.get_clipboard",
    title="Get clipboard text",
    category=S,
    icon="clipboard-paste",
    sentence="Get the text on the clipboard",
    description="The text that was copied last (Ctrl+C), e.g. after copying from a program.",
    outputs=[OutputDef("text", "Text", "text", default_variable="clipboard")],
)
def get_clipboard(ctx: RunContext, p: NoParams) -> str:
    return _clipboard()


class SetClipboardParams(Params):
    text: str = Param(title="Text", ui="multiline")


@activity(
    "system.set_clipboard",
    title="Set clipboard text",
    category=S,
    icon="clipboard-copy",
    sentence="Put {text} on the clipboard",
    description="Put text on the clipboard, e.g. to paste it into a program with Ctrl+V.",
    params=SetClipboardParams,
)
def set_clipboard(ctx: RunContext, p: SetClipboardParams) -> None:
    _clipboard(to_text(p.text))


def _clipboard(text: str | None = None) -> str:
    """Read (text=None) or write the clipboard as Unicode text, retrying while another program holds it."""
    import ctypes
    from ctypes import wintypes

    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    cf_unicode = 13
    for _ in range(20):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise ActivityError("Another program is using the clipboard.", "Try again in a moment.")
    try:
        if text is None:
            handle = user32.GetClipboardData(cf_unicode)
            if not handle:
                return ""
            pointer = kernel32.GlobalLock(handle)
            try:
                return ctypes.wstring_at(pointer)
            finally:
                kernel32.GlobalUnlock(handle)
        data = text.encode("utf-16-le") + b"\x00\x00"
        handle = kernel32.GlobalAlloc(0x0042, len(data))  # GMEM_MOVEABLE | GMEM_ZEROINIT
        pointer = kernel32.GlobalLock(handle)
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        user32.EmptyClipboard()
        if not user32.SetClipboardData(cf_unicode, handle):
            raise ActivityError("The text could not be put on the clipboard.")
        return text
    finally:
        user32.CloseClipboard()


_FOLDERS = {
    "desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
}


class SpecialFolderParams(Params):
    folder: Literal["desktop", "documents", "downloads", "pictures", "temp", "appdata", "home"] = Param(
        "desktop", title="Folder",
        labels={"desktop": "Desktop", "documents": "Documents", "downloads": "Downloads", "pictures": "Pictures",
                "temp": "Temporary files", "appdata": "AppData (Roaming)", "home": "User folder"},
    )


@activity(
    "system.special_folder",
    title="Get special folder",
    category=S,
    icon="folder-cog",
    sentence="Get the {folder} folder",
    description="Where Windows keeps the Desktop, Documents, Downloads... of the account that runs the automation "
    "(Brity GetSpecialFolder) - so it works on every PC and robot.",
    params=SpecialFolderParams,
    outputs=[OutputDef("path", "Folder", "file", default_variable="folder")],
)
def special_folder(ctx: RunContext, p: SpecialFolderParams) -> str:
    if p.folder == "temp":
        import tempfile

        return tempfile.gettempdir()
    if p.folder == "appdata":
        return os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
    if p.folder == "home":
        return str(Path.home())
    return _known_folder(_FOLDERS[p.folder]) or str(Path.home() / p.folder.capitalize())


def _known_folder(guid: str) -> str | None:
    import ctypes
    import uuid
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                    ("Data4", wintypes.BYTE * 8)]

    raw = uuid.UUID(guid).bytes_le
    folder_id = GUID.from_buffer_copy(raw)
    path = ctypes.c_wchar_p()
    try:
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(folder_id), 0, None, ctypes.byref(path)) != 0:
            return None
        return path.value
    finally:
        ctypes.windll.ole32.CoTaskMemFree(path)


class OpenFileParams(Params):
    file: str = Param(title="File", ui="file")


@activity(
    "system.open_file",
    title="Open file with its program",
    category=S,
    icon="external-link",
    sentence="Open {file}",
    description="Open a file with the program Windows uses for it, like a double-click (Brity ExecuteFile).",
    params=OpenFileParams,
)
def open_file(ctx: RunContext, p: OpenFileParams) -> None:
    path = Path(to_text(p.file).strip().strip('"')).expanduser()
    if not path.exists():
        raise ActivityError(f"The file '{path}' does not exist.")
    os.startfile(path)  # type: ignore[attr-defined]  # Windows only


class RegistryParams(Params):
    key: str = Param(title="Key", placeholder="HKEY_CURRENT_USER\\Software\\Company\\App")
    name: str = Param("", title="Value name", placeholder="(the default value)")


_HIVES = {
    "HKEY_CURRENT_USER": "HKEY_CURRENT_USER", "HKCU": "HKEY_CURRENT_USER",
    "HKEY_LOCAL_MACHINE": "HKEY_LOCAL_MACHINE", "HKLM": "HKEY_LOCAL_MACHINE",
    "HKEY_CLASSES_ROOT": "HKEY_CLASSES_ROOT", "HKCR": "HKEY_CLASSES_ROOT",
    "HKEY_USERS": "HKEY_USERS", "HKU": "HKEY_USERS",
}


def _key(path: str) -> tuple[Any, str]:
    import winreg

    hive, _, sub = to_text(path).strip().replace("/", "\\").partition("\\")
    name = _HIVES.get(hive.upper())
    if not name:
        raise ActivityError(f"'{path}' is not a registry key.", "Start it with HKEY_CURRENT_USER\\ or HKEY_LOCAL_MACHINE\\.")
    return getattr(winreg, name), sub


@activity(
    "system.read_registry",
    title="Read registry value",
    category=S,
    icon="list-tree",
    sentence="Read {name} from {key}",
    description="Read a setting from the Windows registry (Brity GetRegistryValue).",
    params=RegistryParams,
    outputs=[OutputDef("value", "Value", "any", default_variable="registry_value")],
)
def read_registry(ctx: RunContext, p: RegistryParams) -> Any:
    import winreg

    hive, sub = _key(p.key)
    try:
        with winreg.OpenKey(hive, sub) as key:
            value, _kind = winreg.QueryValueEx(key, to_text(p.name))
            return value
    except FileNotFoundError:
        raise ActivityError(f"There is no value '{p.name or '(default)'}' in {p.key}.") from None


class WriteRegistryParams(RegistryParams):
    value: str = Param(title="Value")
    kind: Literal["text", "number"] = Param("text", title="Kind", labels={"text": "Text", "number": "Number (DWORD)"})


@activity(
    "system.write_registry",
    title="Write registry value",
    category=S,
    icon="list-tree",
    sentence="Write {value} to {name} in {key}",
    description="Change a setting in the Windows registry (Brity SetRegistryValue). Only administrators can "
    "publish automations with this step.",
    params=WriteRegistryParams,
    requires="scripts",
)
def write_registry(ctx: RunContext, p: WriteRegistryParams) -> None:
    import winreg

    hive, sub = _key(p.key)
    try:
        with winreg.CreateKeyEx(hive, sub, 0, winreg.KEY_SET_VALUE) as key:
            if p.kind == "number":
                winreg.SetValueEx(key, to_text(p.name), 0, winreg.REG_DWORD, int(float(to_text(p.value))))
            else:
                winreg.SetValueEx(key, to_text(p.name), 0, winreg.REG_SZ, to_text(p.value))
    except PermissionError:
        raise ActivityError(f"Not allowed to change {p.key}.", "Keys under HKEY_LOCAL_MACHINE need administrator rights.") from None
    except ValueError:
        raise ActivityError(f"'{p.value}' is not a whole number.") from None


# -- waiting on files (Brity IsFileLock / WaitFileUnLock / WaitFileDelete) ---------------------------------


class WaitFileParams(Params):
    file: str = Param(title="File", ui="file")
    until: Literal["free", "gone"] = Param(
        "free", title="Wait until it", labels={"free": "is no longer in use", "gone": "is deleted"},
    )
    timeout: float = Param(120, title="Wait up to (seconds)", ge=0, le=86_400, ui="duration")


@activity(
    "files.wait_until",
    title="Wait until file is free",
    category="Files",
    icon="file-clock",
    sentence="Wait until {file} {until}",
    description="Wait until another program has finished writing a file (or until it is deleted), "
    "e.g. a report that is still being exported.",
    params=WaitFileParams,
)
def wait_until(ctx: RunContext, p: WaitFileParams) -> None:
    path = Path(to_text(p.file).strip().strip('"')).expanduser()
    deadline = Deadline(p.timeout)
    while True:
        done = not path.exists() if p.until == "gone" else (path.exists() and not _locked(path))
        if done:
            return
        if deadline.passed:
            what = "was not deleted" if p.until == "gone" else ("does not exist" if not path.exists() else "is still in use")
            raise ActivityError(f"'{path.name}' {what} after {p.timeout:g} seconds.")
        wait(0.5)


def _locked(path: Path) -> bool:
    try:
        with open(path, "r+b"):
            pass
    except PermissionError:
        return True
    except OSError:
        return True
    return False


# -- JSON and XML (Brity DataConverter Json_* / Xml_*) ------------------------------------------------------


class JsonReadParams(Params):
    text: Any = Param(title="JSON", placeholder='{{response["body"]}}', description="JSON text (e.g. from a web service).")
    path: str = Param("", title="Value to get", placeholder="customer.address.city   or   items[0].price",
                      description="Leave empty for all of it.")


@activity(
    "data.json_read",
    title="Read JSON",
    category="Data",
    icon="braces",
    sentence="Read {path} from JSON",
    description="Turn JSON text into values and pick one out, e.g. customer.address.city or items[0].price. "
    "A list of objects becomes a table.",
    params=JsonReadParams,
    outputs=[OutputDef("value", "Value", "any", default_variable="json_value")],
)
def json_read(ctx: RunContext, p: JsonReadParams) -> Any:
    value = p.text
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ActivityError(f"This is not valid JSON: {exc.msg} (line {exc.lineno}).") from None
    for part in _path_parts(to_text(p.path)):
        try:
            value = value[part] if isinstance(part, int) or not isinstance(value, list) else value[int(part)]
        except (KeyError, IndexError, TypeError, ValueError):
            raise ActivityError(f"The JSON has no '{p.path}'.", "Check the spelling; names are case-sensitive.") from None
    if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
        return Table(rows=value)
    return value


def _path_parts(path: str) -> list[str | int]:
    import re

    parts: list[str | int] = []
    for token in re.findall(r"[^.\[\]]+|\[\d+\]", path.strip()):
        parts.append(int(token[1:-1]) if token.startswith("[") else token)
    return parts


class ToJsonParams(Params):
    value: Any = Param(title="Value", ui="variable")
    pretty: bool = Param(True, title="Easy to read (indented)")


@activity(
    "data.to_json",
    title="Make JSON",
    category="Data",
    icon="braces",
    sentence="Turn {value} into JSON",
    description="Turn a table, list or value into JSON text, e.g. to send to a web service.",
    params=ToJsonParams,
    outputs=[OutputDef("json", "JSON", "text", default_variable="json_text")],
)
def to_json(ctx: RunContext, p: ToJsonParams) -> str:
    value = p.value
    if isinstance(value, Table):
        value = [dict(row) for row in value.rows]
    return json.dumps(to_jsonable(value, row_limit=1_000_000), indent=2 if p.pretty else None, ensure_ascii=False, default=str)


class XmlParams(Params):
    xml: Any = Param(title="XML", placeholder="{{response}}", description="XML text, or an XML file.")
    xpath: str = Param(title="XPath", placeholder="//Invoice/Total   or   //Line/@sku")


@activity(
    "data.xml_read",
    title="Read XML",
    category="Data",
    icon="code-xml",
    sentence="Read {xpath} from XML",
    description="Pick values out of XML with an XPath (Brity Xml_GetValueByXpath). Gives a list.",
    params=XmlParams,
    outputs=[OutputDef("values", "Values", "list", default_variable="xml_values")],
)
def xml_read(ctx: RunContext, p: XmlParams) -> list[str]:
    from lxml import etree

    text = to_text(p.xml).strip()
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        if text.startswith("<"):
            root = etree.fromstring(text.encode("utf-8"), parser)
        else:
            root = etree.parse(str(Path(text).expanduser()), parser).getroot()
    except (etree.XMLSyntaxError, OSError) as exc:
        raise ActivityError(f"This is not valid XML: {exc}") from None
    try:
        found = root.xpath(to_text(p.xpath))
    except etree.XPathError as exc:
        raise ActivityError(f"'{p.xpath}' is not a valid XPath: {exc}") from None
    items = found if isinstance(found, list) else [found]
    return [(item.text or "").strip() if hasattr(item, "text") else to_text(item) for item in items]


# -- encryption and Base64 (Brity Encrypt / Decrypt / Base64) ----------------------------------------------


class CryptParams(Params):
    text: str = Param(title="Text")
    key: str = Param(title="Key", ui="credential",
                     description="A saved credential: its password is the key (never stored in the automation).")


def _fernet(ctx: RunContext, credential: str) -> Any:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    secret = str(ctx.credential(credential).password).encode("utf-8")
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b"autoflow.encrypt.v1", iterations=200_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(secret)))


@activity(
    "text.encrypt",
    title="Encrypt text",
    category="Text",
    icon="lock",
    sentence="Encrypt {text}",
    description="Scramble text with a key from Credentials, so only automations with the same key can read it.",
    params=CryptParams,
    outputs=[OutputDef("encrypted", "Encrypted text", "text", default_variable="encrypted")],
)
def encrypt(ctx: RunContext, p: CryptParams) -> str:
    return _fernet(ctx, p.key).encrypt(to_text(p.text).encode("utf-8")).decode("ascii")


@activity(
    "text.decrypt",
    title="Decrypt text",
    category="Text",
    icon="lock-open",
    sentence="Decrypt {text}",
    description="Read text that 'Encrypt text' scrambled, with the same key.",
    params=CryptParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="decrypted")],
)
def decrypt(ctx: RunContext, p: CryptParams) -> str:
    from cryptography.fernet import InvalidToken

    try:
        return _fernet(ctx, p.key).decrypt(to_text(p.text).strip().encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        raise ActivityError("This text can't be decrypted with that key.", "Use the key it was encrypted with.") from None


class Base64Params(Params):
    action: Literal["encode", "decode"] = Param("encode", title="Do", labels={"encode": "Encode", "decode": "Decode"})
    value: str = Param(title="Text or file", description="Encode: text, or a file path. Decode: Base64 text.")
    file: str = Param("", title="Save decoded bytes as", ui="save_file", advanced=True,
                      placeholder="(give the decoded text)")


@activity(
    "text.base_encoding",
    title="Base64",
    category="Text",
    icon="binary",
    sentence="Base64 {action} {value}",
    description="Turn text or a file into Base64 (e.g. for a web service), or back (Brity Base64__EncodeFile).",
    params=Base64Params,
    outputs=[OutputDef("result", "Result", "text", default_variable="base64_result")],
)
def base64_step(ctx: RunContext, p: Base64Params) -> str:
    value = to_text(p.value)
    if p.action == "encode":
        path = Path(value.strip().strip('"'))
        data = path.read_bytes() if len(value) < 260 and path.is_file() else value.encode("utf-8")
        return base64.b64encode(data).decode("ascii")
    try:
        data = base64.b64decode(value.strip(), validate=False)
    except ValueError:
        raise ActivityError("This is not Base64 text.") from None
    if to_text(p.file).strip():
        target = Path(to_text(p.file)).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return str(target)
    return data.decode("utf-8", errors="replace")
