"""Release E: System steps (commands, scripts, clipboard, folders, registry, files, JSON / XML, crypto)."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest
from conftest import step

from autoflow_engine.values import Credential, Table

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows only")


def test_commands_and_python_scripts(h):
    result = h.run([
        step("system.run_command", {"command": "echo hello"}, outputs={"output": "said"}),
        step("system.run_command", {"command": "Write-Output (2 + 3)", "shell": "powershell"}, outputs={"output": "five"}),
        step("system.run_command", {"command": "exit /b 3", "fail_on_error": False}, outputs={"exit_code": "code"}),
        step("system.run_python", {
            "code": "print('working')\nresult = {'total': sum(r['Amount'] for r in inputs['rows']), 'n': inputs['n']}",
            "inputs": {"rows": "{{rows}}", "n": 2},
        }, outputs={"result": "answer"}),
    ], variables=[{"name": "rows", "type": "table", "is_input": True}],
       inputs={"rows": [{"Amount": 10}, {"Amount": 2.5}]})
    assert result.status == "succeeded", result.error
    assert h.vars["said"] == "hello"
    assert h.vars["five"] == "5"
    assert h.vars["code"] == 3
    assert h.vars["answer"] == {"total": 12.5, "n": 2}
    assert "script: working" in h.logs()

    result = h.run([step("system.run_command", {"command": "exit /b 4"})])
    assert result.status == "failed" and "exit code 4" in result.error["message"]
    result = h.run([step("system.run_python", {"code": "raise ValueError('bad input')"})])
    assert result.status == "failed" and "ValueError: bad input" in result.error["message"]


def test_scripts_are_marked_for_administrators():
    from autoflow_engine import catalog

    catalog.load_activities()
    marked = {a.id for a in catalog.REGISTRY.values() if a.requires == "scripts"}
    assert marked == {"system.run_command", "system.run_python", "system.write_registry", "ssh.run"}


def test_clipboard_folders_and_files(h, tmp_path):
    from autoflow_engine.activities.system import _clipboard

    before = _clipboard()
    try:
        result = h.run([
            step("system.set_clipboard", {"text": "Invoice ✓ 42"}),
            step("system.get_clipboard", outputs={"text": "copied"}),
            step("system.special_folder", {"folder": "desktop"}, outputs={"path": "desktop"}),
            step("system.special_folder", {"folder": "downloads"}, outputs={"path": "downloads"}),
        ])
    finally:
        _clipboard(before)
    assert result.status == "succeeded", result.error
    assert h.vars["copied"] == "Invoice ✓ 42"
    assert Path(h.vars["desktop"]).is_dir() and Path(h.vars["downloads"]).is_dir()

    report = tmp_path / "report.csv"
    report.write_text("a,b\n")
    threading.Timer(0.6, report.unlink).start()
    started = time.monotonic()
    result = h.run([
        step("files.wait_until", {"file": str(report), "until": "free", "timeout": 5}),
        step("files.wait_until", {"file": str(report), "until": "gone", "timeout": 5}),
    ])
    assert result.status == "succeeded", result.error
    assert time.monotonic() - started >= 0.5


def test_registry(h):
    import winreg

    key = r"HKEY_CURRENT_USER\Software\AutoflowTest"
    try:
        result = h.run([
            step("system.write_registry", {"key": key, "name": "Mode", "value": "fast"}),
            step("system.write_registry", {"key": key, "name": "Count", "value": "7", "kind": "number"}),
            step("system.read_registry", {"key": key, "name": "Mode"}, outputs={"value": "mode"}),
            step("system.read_registry", {"key": key.replace("HKEY_CURRENT_USER", "HKCU"), "name": "Count"},
                 outputs={"value": "count"}),
        ])
        assert result.status == "succeeded", result.error
        assert (h.vars["mode"], h.vars["count"]) == ("fast", 7)
        result = h.run([step("system.read_registry", {"key": key, "name": "Missing"})])
        assert result.status == "failed" and "no value 'Missing'" in result.error["message"]
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, r"Software\AutoflowTest")


def test_json_xml_encryption_and_base64(h, tmp_path):
    data = '{"customer": {"address": {"city": "Cairo"}}, "items": [{"price": 5}, {"price": 7}]}'
    xml = '<r><Line sku="A"/><Line sku="B"/><Total>12</Total></r>'
    picture = tmp_path / "logo.bin"
    picture.write_bytes(b"\x00\x01binary")
    result = h.run([
        step("data.json_read", {"text": data, "path": "customer.address.city"}, outputs={"value": "city"}),
        step("data.json_read", {"text": data, "path": "items[1].price"}, outputs={"value": "price"}),
        step("data.json_read", {"text": data, "path": "items"}, outputs={"value": "items"}),
        step("data.to_json", {"value": "{{items}}", "pretty": False}, outputs={"json": "again"}),
        step("data.xml_read", {"xml": xml, "xpath": "//Line/@sku"}, outputs={"values": "skus"}),
        step("data.xml_read", {"xml": xml, "xpath": "//Total"}, outputs={"values": "total"}),
        step("text.encrypt", {"text": "IBAN 1234", "key": "vault"}, outputs={"encrypted": "secret"}),
        step("text.decrypt", {"text": "{{secret}}", "key": "vault"}, outputs={"text": "plain"}),
        step("text.base_encoding", {"value": "héllo"}, outputs={"result": "b64"}),
        step("text.base_encoding", {"action": "decode", "value": "{{b64}}"}, outputs={"result": "back"}),
        step("text.base_encoding", {"value": str(picture)}, outputs={"result": "file_b64"}),
        step("text.base_encoding", {"action": "decode", "value": "{{file_b64}}", "file": str(tmp_path / "copy.bin")}),
    ], credentials={"vault": Credential("vault", "", "correct horse battery staple")}.__getitem__)
    assert result.status == "succeeded", result.error
    v = h.vars
    assert (v["city"], v["price"]) == ("Cairo", 7)
    assert isinstance(v["items"], Table) and v["items"].columns == ["price"]
    assert v["again"] == '[{"price": 5}, {"price": 7}]'
    assert v["skus"] == ["A", "B"] and v["total"] == ["12"]
    assert "IBAN" not in v["secret"] and v["plain"] == "IBAN 1234"
    assert v["back"] == "héllo"
    assert (tmp_path / "copy.bin").read_bytes() == b"\x00\x01binary"

    result = h.run([step("text.decrypt", {"text": "{{secret}}", "key": "other"})],
                   variables=[{"name": "secret", "default": v["secret"]}],
                   credentials={"other": Credential("other", "", "wrong key")}.__getitem__)
    assert result.status == "failed" and "can't be decrypted" in result.error["message"]
    result = h.run([step("data.json_read", {"text": data, "path": "customer.phone"})])
    assert result.status == "failed" and "no 'customer.phone'" in result.error["message"]
