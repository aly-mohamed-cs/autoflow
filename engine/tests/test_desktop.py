"""Desktop steps against testbed/desktop-erp (a WinForms app), like scenario 4.

Needs an interactive Windows desktop and the .NET SDK to build the demo app.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import step
from openpyxl import Workbook

APP_DIR = Path(__file__).resolve().parents[2] / "testbed" / "desktop-erp"
APP = APP_DIR / "out" / "DemoErp.exe"

pytestmark = [
    pytest.mark.desktop,
    pytest.mark.skipif(sys.platform != "win32", reason="Windows only"),
]


@pytest.fixture(scope="module")
def demo_erp() -> Path:
    if not APP.exists():
        if not shutil.which("dotnet"):
            pytest.skip(".NET SDK not installed; cannot build the demo ERP")
        subprocess.run(["dotnet", "build", "-c", "Release", "-o", "out", "-v", "quiet"], cwd=APP_DIR, check=True)
    return APP


WINDOW = {"window": "Demo ERP - Invoices", "process": "DemoErp.exe"}


def el(id_: str, name: str, automation_id: str, control_type: str) -> dict:
    return {
        "id": id_, "name": name, "kind": "desktop", "context": WINDOW,
        "selectors": [
            {"strategy": "uia", "value": f"{control_type} #old_{automation_id}",
             "options": {"automation_id": f"old_{automation_id}", "control_type": control_type}},
            {"strategy": "uia", "value": f"{control_type} #{automation_id}",
             "options": {"automation_id": automation_id, "control_type": control_type}},
        ],
    }


ELEMENTS = [
    el("customer", "Customer box", "txtCustomer", "Edit"),
    el("invoice", "Invoice number box", "txtInvoice", "Edit"),
    el("amount", "Amount box", "txtAmount", "Edit"),
    el("currency", "Currency list", "cboCurrency", "ComboBox"),
    el("urgent", "Urgent checkbox", "chkUrgent", "CheckBox"),
    el("save", "Save invoice button", "btnSave", "Button"),
    el("status", "Status", "lblStatus", "Text"),
    el("grid", "Saved invoices table", "gridInvoices", "DataGrid"),
]


def test_excel_into_desktop_erp(h, tmp_path, demo_erp):
    xlsx = tmp_path / "invoices.xlsx"
    wb = Workbook()
    wb.active.append(["Invoice", "Customer", "Amount", "Currency"])
    wb.active.append(["INV-71", "Acme", 120.5, "USD"])
    wb.active.append(["INV-72", "Globex", 99, "EGP"])
    wb.save(xlsx)

    steps = [
        step("excel.read", {"file": str(xlsx)}, outputs={"table": "rows"}),
        step("desktop.launch", {"program": str(demo_erp), "window": "Demo ERP"}),
        step("control.for_each", {"items": "{{rows}}", "item_variable": "row", "index_variable": "n"}, blocks={"body": [
            step("desktop.type", {"element": "customer", "text": '{{row["Customer"]}}'}),
            step("desktop.type", {"element": "invoice", "text": '{{row["Invoice"]}}'}),
            step("desktop.type", {"element": "amount", "text": '{{row["Amount"]}}'}),
            step("desktop.select", {"element": "currency", "option": '{{row["Currency"]}}'}),
            step("desktop.check", {"element": "urgent", "checked": True}),
            step("desktop.click", {"element": "save"}),
            step("desktop.wait_for", {"element": "status", "state": "text contains", "text": '{{row["Invoice"]}}',
                                      "timeout": 10}),
            step("desktop.get_text", {"element": "status"}, outputs={"text": "status"}),
            step("excel.update_row", {"file": str(xlsx), "row_number": "{{n}}",
                                      "values": {"Document": '{{REGEXEXTRACT(status, "DOC-[0-9]+")}}'}}),
        ]}),
        step("desktop.read_table", {"element": "grid"}, outputs={"table": "saved"}),
        step("desktop.close_window", {"window": "Demo ERP"}),
    ]
    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner

    events: list[dict] = []
    flow = Flow.model_validate({"id": "d", "name": "d", "elements": ELEMENTS, "steps": steps,
                                "settings": {"default_timeout": 10}})
    runner = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run"), events.append)
    result = runner.run()
    assert result.status == "succeeded", result.error
    variables = runner.ctx.variables
    assert variables["status"] == "Saved INV-72 as DOC-1002"
    saved = variables["saved"]
    assert [r["Invoice"] for r in saved] == ["INV-71", "INV-72"]
    assert [r["Document"] for r in saved] == ["DOC-1001", "DOC-1002"]
    from openpyxl import load_workbook

    ws = load_workbook(xlsx).active
    assert [ws["E2"].value, ws["E3"].value] == ["DOC-1001", "DOC-1002"]
    logs = [e["message"] for e in events if e["event"] == "log"]
    assert any("backup method" in m for m in logs)  # the stale first selectors fell back


def test_desktop_picker_captures_a_control(tmp_path, demo_erp):
    """Point at the Save button and press Ctrl, like a user; then use the element in a flow."""
    import ctypes
    import threading
    import time

    from autoflow_engine.design.desktop_picker import DesktopPicker
    from autoflow_engine.flow import Element, Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner
    from autoflow_engine.selectors.desktop import find_window, uia

    app = subprocess.Popen([str(demo_erp)])
    hovers: list[dict] = []
    answer: dict = {}
    done = threading.Event()
    try:
        auto = uia()
        with auto.UIAutomationInitializerInThread():
            window = find_window({"window": "Demo ERP"}, 15)
            window.SetActive(waitTime=0.3)
            button = auto.ButtonControl(searchFromControl=window, AutomationId="btnSave")
            rect = button.BoundingRectangle
            center = ((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)

        def respond(result=None, error=None):
            answer.update(result=result, error=error)
            done.set()

        picker = DesktopPicker(lambda method, params: hovers.append(params), ignore_pids=set())
        picker.pick(respond)
        user32 = ctypes.windll.user32
        user32.SetCursorPos(*center)
        deadline = time.monotonic() + 5
        while not any("Save invoice" in h["name"] for h in hovers) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert hovers, "the picker never reported what is under the mouse"
        user32.keybd_event(0x11, 0, 0, 0)  # Ctrl down
        time.sleep(0.15)
        user32.keybd_event(0x11, 0, 2, 0)  # Ctrl up
        assert done.wait(10), "no element was picked"
        assert answer["error"] is None, answer["error"]
        element = Element.model_validate(answer["result"])
        assert element.name == "Save invoice button"
        assert element.kind == "desktop"
        assert element.context == {"window": "Demo ERP - Invoices", "process": "DemoErp.exe"}
        assert element.selectors[0].options == {"automation_id": "btnSave", "control_type": "Button"}
        assert element.screenshot and element.screenshot.startswith("data:image/png")

        flow = Flow.model_validate({"id": "p", "name": "p", "elements": [element.model_dump()], "steps": [
            {"id": "c", "activity": "desktop.click", "params": {"element": element.id}},
            {"id": "w", "activity": "desktop.wait_for",
             "params": {"element": element.id, "state": "is enabled", "timeout": 5}},
        ]})
        result = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run"), lambda e: None).run()
        assert result.status == "succeeded", result.error
    finally:
        app.kill()
