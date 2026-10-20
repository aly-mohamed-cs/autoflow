"""Downloads keep the website's file name: the Download file step, plain clicks and recording."""

from __future__ import annotations

import io
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from conftest import step
from openpyxl import Workbook

from autoflow_engine import downloads
from autoflow_engine.flow import Flow
from autoflow_engine.runtime.context import RunOptions
from autoflow_engine.runtime.interpreter import FlowRunner

BROWSER = "edge" if shutil.which("msedge") or Path(
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").exists() else "chromium"


def _xlsx() -> bytes:
    wb = Workbook()
    wb.active.append(["Region", "Sales"])
    wb.active.append(["North", 120])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# -- giving files the extension their contents need --------------------------------------


def _logged():
    lines: list[tuple[str, str]] = []
    return lines, lambda message, level="info": lines.append((level, message))


def _kind(tmp_path, data: bytes) -> str | None:
    f = tmp_path / "sample"
    f.write_bytes(data)
    return downloads.sniff(f)


def test_file_kinds_are_told_by_their_contents(tmp_path):
    assert _kind(tmp_path, _xlsx()) == ".xlsx"
    assert _kind(tmp_path, b"%PDF-1.7 ...") == ".pdf"
    assert _kind(tmp_path, b"<!DOCTYPE html><html><table></table></html>") == ".html"
    assert _kind(tmp_path, b"\xef\xbb\xbfRegion,Sales\nNorth,120\n") is None  # CSV: can't be sure
    assert _kind(tmp_path, b"PK\x03\x04 not really a zip") is None


def test_an_excel_file_without_extension_gets_one():
    lines, log = _logged()
    assert downloads.proper_name("export", ".xlsx", log) == "export.xlsx"
    assert "no extension" in lines[0][1]


def test_a_website_name_with_the_wrong_excel_extension_is_corrected():
    lines, log = _logged()
    assert downloads.proper_name("Sales Report.xls", ".xlsx", log) == "Sales Report.xlsx"
    assert lines[0][0] == "info"


def test_a_chosen_name_is_kept_with_a_warning():
    lines, log = _logged()
    assert downloads.proper_name("report.xls", ".xlsx", log, chosen=True) == "report.xls"
    assert lines[0][0] == "warning"


def test_a_web_page_called_xls_is_explained_and_other_files_are_left_alone():
    lines, log = _logged()
    assert downloads.proper_name("report.xls", ".html", log) == "report.xls"
    assert lines[0][0] == "warning" and "web page" in lines[0][1]
    assert downloads.proper_name("report.csv", None, log) == "report.csv"
    assert downloads.proper_name("book.xlsm", ".xlsx", log) == "book.xlsm"
    assert downloads.proper_name("archive.zip", ".xlsx", log) == "archive.zip"
    assert len(lines) == 1


def test_unique_names_like_a_browser(tmp_path):
    (tmp_path / "a.xlsx").write_bytes(b"x")
    (tmp_path / "a (1).xlsx").write_bytes(b"x")
    assert downloads.unique_path(tmp_path / "a.xlsx").name == "a (2).xlsx"
    assert downloads.unique_path(tmp_path / "b.xlsx").name == "b.xlsx"


# -- in the browser ------------------------------------------------------------------------


class _Portal(BaseHTTPRequestHandler):
    """A report portal: its export is an .xlsx file the website calls .xls; one link has no name."""

    def do_GET(self):
        if self.path.startswith("/export"):
            time.sleep(0.8)  # the portal builds the report
            self._file('attachment; filename="Sales Report.xls"')
        elif self.path.startswith("/download"):
            self._file(None)
        else:
            body = b'<a id="export" href="/export">Export to Excel</a> <a id="noname" href="/download">Get it</a>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

    def _file(self, disposition: str | None):
        body = _xlsx()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def export_url():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Portal)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture
def downloads_dir(tmp_path, monkeypatch):
    folder = tmp_path / "Downloads"
    monkeypatch.setattr(downloads, "downloads_folder", lambda: folder)
    return folder


ELEMENTS = [
    {"id": "export", "name": "Export to Excel link", "kind": "web", "selectors": [{"strategy": "css", "value": "#export"}]},
    {"id": "noname", "name": "Get it link", "kind": "web", "selectors": [{"strategy": "css", "value": "#noname"}]},
]


def run_flow(tmp_path, steps):
    events: list[dict] = []
    flow = Flow.model_validate({"id": "d", "name": "d", "elements": ELEMENTS, "steps": steps,
                                "settings": {"default_timeout": 10}})
    runner = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run", headless=True), events.append)
    return runner.run(), events, runner.ctx.variables


@pytest.mark.browser
def test_a_plain_click_saves_the_file_with_its_name_into_downloads(tmp_path, export_url, downloads_dir):
    result, events, variables = run_flow(tmp_path, [
        step("browser.open", {"url": export_url, "browser": BROWSER}),
        step("browser.click", {"element": "export"}),
        step("files.wait_for_file", {"folder": str(downloads_dir), "pattern": "*.xlsx", "timeout": 20},
             outputs={"file": "report"}),
        step("excel.read", {"file": "{{report}}"}, outputs={"table": "rows"}),
    ])
    assert result.status == "succeeded", result.error
    assert Path(variables["report"]).name == "Sales Report.xlsx"
    assert variables["rows"].rows[0]["Sales"] == 120
    assert [f.name for f in downloads_dir.iterdir()] == ["Sales Report.xlsx"]
    assert any("Saved the downloaded file" in e.get("message", "") for e in events)


@pytest.mark.browser
def test_a_download_started_by_the_last_click_is_saved_before_the_browser_closes(tmp_path, export_url, downloads_dir):
    result, _events, _ = run_flow(tmp_path, [
        step("browser.open", {"url": export_url, "browser": BROWSER}),
        step("browser.click", {"element": "noname"}),
    ])
    assert result.status == "succeeded", result.error
    assert [f.name for f in downloads_dir.iterdir()] == ["download.xlsx"]


@pytest.mark.browser
def test_recording_a_click_that_downloads_makes_a_download_step(export_url, downloads_dir):
    from autoflow_engine.design.session import DesignSession

    notes: list[tuple[str, dict]] = []
    session = DesignSession(lambda method, params: notes.append((method, params)), headless=True)
    try:
        answers: list[dict] = []
        session.record_start(export_url, lambda result=None, error=None: answers.append(result))
        _wait_for(lambda: answers)
        session.run(lambda page: page.click("#export")).result(15)
        _wait_for(lambda: any(m == "browser.downloaded" for m, _ in notes))
        session.record_stop(lambda result=None, error=None: answers.append(result))
        _wait_for(lambda: len(answers) == 2)
    finally:
        session.close()
    actions = answers[1]["actions"]
    assert [a["action"] for a in actions] == ["download"]
    assert actions[0]["element"]["kind"] == "web"
    assert any(m == "recorder.action" and p.get("replace_last") for m, p in notes)
    assert [f.name for f in downloads_dir.iterdir()] == ["Sales Report.xlsx"]


def _wait_for(predicate, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("condition not reached")


@pytest.mark.browser
def test_the_download_step_saves_one_copy_into_downloads_by_default(tmp_path, export_url, downloads_dir):
    result, _events, variables = run_flow(tmp_path, [
        step("browser.open", {"url": export_url, "browser": BROWSER}),
        step("browser.download", {"element": "export"}, outputs={"file": "report"}),
        step("browser.download", {"element": "export"}, outputs={"file": "again"}),
        step("browser.close"),
    ])
    assert result.status == "succeeded", result.error
    assert Path(variables["report"]) == downloads_dir / "Sales Report.xlsx"
    assert Path(variables["again"]) == downloads_dir / "Sales Report.xlsx"  # replaced (the default)
    assert [f.name for f in downloads_dir.iterdir()] == ["Sales Report.xlsx"]
