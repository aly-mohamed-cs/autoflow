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


def test_ai_repair_repicks_a_desktop_control(tmp_path, demo_erp):
    """A control whose id changed is found again from the window's controls (AI self-repair)."""
    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner

    requests: list[dict] = []

    def assistant(req):
        requests.append(req)
        edit = next(c for c in req["screen"]["controls"] if c.get("automation_id") == "txtCustomer")
        return {"explanation": "The customer box has a new id.",
                "selectors": [{"strategy": "uia", "value": "Edit #txtCustomer",
                               "options": {"automation_id": edit["automation_id"], "control_type": "Edit"}}]}

    stale = {"id": "customer", "name": "Customer box", "kind": "desktop", "context": WINDOW,
             "selectors": [{"strategy": "uia", "value": "Edit #txtClient",
                            "options": {"automation_id": "txtClient", "control_type": "Edit"}}]}
    steps = [
        step("desktop.launch", {"program": str(demo_erp), "window": "Demo ERP"}),
        step("desktop.type", {"element": "invoice", "text": "SECRET-TYPED"}),
        step("desktop.type", {"element": "customer", "text": "Initech"}, id="fixme"),
        step("desktop.get_text", {"element": "customer"}, outputs={"text": "typed"}),
        step("desktop.close_window", {"window": "Demo ERP"}),
    ]
    elements = [stale, *(e for e in ELEMENTS if e["id"] != "customer")]
    flow = Flow.model_validate({"id": "d", "name": "d", "elements": elements, "steps": steps,
                                "settings": {"default_timeout": 3}})
    events: list[dict] = []
    runner = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run", repair=assistant), events.append)
    result = runner.run()
    assert result.status == "succeeded", result.error
    assert runner.ctx.variables["typed"] == "Initech"  # later steps use the repaired element too
    screen = requests[0]["screen"]
    assert screen["kind"] == "desktop" and screen["process"] == "DemoErp.exe"
    assert "SECRET-TYPED" not in str(screen)  # what was typed into boxes is not sent
    assert [e["step_id"] for e in events if e["event"] == "step_repaired"] == ["fixme"]


def _steps_from_recording(actions: list[dict]) -> tuple[list[dict], list[dict]]:
    """What Studio does with recorded actions (lib/recording.ts), for replaying them here."""
    steps, elements = [], {}

    def el(action: dict) -> str:
        element = action["element"]
        key = repr(element["selectors"][0])
        elements.setdefault(key, element)
        return elements[key]["id"]

    for a in actions:
        kind = a["action"]
        if kind == "launch":
            steps.append(step("desktop.launch", {"program": a["program"], "window": a["window"]}))
        elif kind == "activate":
            steps.append(step("desktop.activate_window", {"window": a["window"]}))
        elif kind == "click":
            steps.append(step("desktop.click", {"element": el(a), "click": a.get("click", "single")}))
        elif kind == "type":
            steps.append(step("desktop.type", {"element": el(a), "text": a.get("value") or "",
                                               "press_enter": bool(a.get("press_enter"))}))
        elif kind == "select":
            steps.append(step("desktop.select", {"element": el(a), "option": a["option"]}))
        elif kind == "check":
            steps.append(step("desktop.check", {"element": el(a), "checked": a["checked"]}))
        elif kind == "keys":
            steps.append(step("desktop.send_keys", {"keys": a["keys"]}))
    return steps, list(elements.values())


def test_recorder_captures_work_in_any_program_and_replays_it(tmp_path, demo_erp):
    """Record a person filling in the demo ERP with the real mouse and keyboard, then replay it."""
    import os
    import threading
    import time

    import uiautomation as auto

    from autoflow_engine.design.desktop_recorder import DesktopRecorder
    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner

    app = subprocess.Popen([str(demo_erp)])
    try:
        window = auto.WindowControl(searchDepth=1, SubName="Demo ERP")
        assert window.Exists(15)
        notes: list[tuple[str, dict]] = []
        recorder = DesktopRecorder(lambda method, params: notes.append((method, params)), ignore_pids={os.getpid()})
        started = threading.Event()
        recorder.start(lambda result=None, error=None: started.set())
        assert started.wait(15)

        window.SetActive()
        time.sleep(0.5)
        for box, text in (("txtCustomer", "Initech"), ("txtInvoice", "INV-9"), ("txtAmount", "42.5")):
            window.EditControl(AutomationId=box).Click(simulateMove=False)
            time.sleep(0.3)
            auto.SendKeys(text, waitTime=0.05)
            time.sleep(0.3)
        window.ComboBoxControl(AutomationId="cboCurrency").Select("EUR", simulateMove=False)
        time.sleep(0.5)
        window.CheckBoxControl(AutomationId="chkUrgent").Click(simulateMove=False)
        time.sleep(0.5)
        window.ButtonControl(AutomationId="btnSave").Click(simulateMove=False)
        time.sleep(1.5)

        stopped: dict = {}
        done = threading.Event()
        recorder.stop(lambda result=None, error=None: (stopped.update(result or {}), done.set()))
        assert done.wait(30)
    finally:
        app.kill()

    actions = stopped["actions"]
    summary = [(a["action"], a.get("value") or a.get("option") or a.get("checked") or a.get("window") or a.get("click"))
               for a in actions]
    assert summary[0] == ("activate", "Demo ERP - Invoices"), summary
    assert [s for s in summary if s[0] != "activate"] == [
        ("type", "Initech"), ("type", "INV-9"), ("type", "42.5"), ("select", "EUR"), ("check", True), ("click", "single"),
    ], summary
    by_action = {a["action"]: a for a in actions}
    assert by_action["click"]["element"]["name"].lower().startswith("save")
    assert any(m == "recorder.action" for m, _ in notes)

    # Replay what was recorded on a fresh copy of the program.
    steps, elements = _steps_from_recording(actions)
    steps = [
        step("desktop.launch", {"program": str(demo_erp), "window": "Demo ERP"}),
        *[s for s in steps if s["activity"] != "desktop.activate_window"],
        step("desktop.wait_for", {"element": next(e["id"] for e in elements if "txtCustomer" in repr(e)),
                                  "state": "appears"}),
        step("desktop.close_window", {"window": "Demo ERP"}),
    ]
    status = {"id": "status", "name": "Status", "kind": "desktop", "context": WINDOW,
              "selectors": [{"strategy": "uia", "value": "Text #lblStatus",
                             "options": {"automation_id": "lblStatus", "control_type": "Text"}}]}
    steps.insert(-2, step("desktop.wait_for", {"element": "status", "state": "text contains", "text": "INV-9", "timeout": 10}))
    flow = Flow.model_validate({"id": "rec", "name": "rec", "elements": [*elements, status], "steps": steps,
                                "settings": {"default_timeout": 10}})
    result = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run"), lambda e: None).run()
    assert result.status == "succeeded", result.error


def test_stopping_from_the_recording_bar_tells_studio():
    import os
    import threading

    from autoflow_engine.design.desktop_recorder import DesktopRecorder

    notes: list[tuple[str, dict]] = []
    recorder = DesktopRecorder(lambda method, params: notes.append((method, params)), ignore_pids={os.getpid()})
    started = threading.Event()
    recorder.start(lambda result=None, error=None: started.set())
    assert started.wait(15)
    recorder._stop_from_bar()  # what the bar's "Stop recording" button does
    recorder._thread.join(10)
    assert ("recorder.stopped", {"count": 0}) in notes
    collected = threading.Event()
    recorder.stop(lambda result=None, error=None: collected.set())  # Studio then collects the steps
    assert collected.wait(10)


def test_title_similarity_handles_changing_window_titles():
    from autoflow_engine.selectors.desktop import _closest_window, title_similarity

    assert title_similarity("Book1 - Excel (Product Activation Failed)",
                            "Microsoft Excel (Product Activation Failed) - Book1") == 1.0
    assert title_similarity("*new 4 - Notepad++", "new 5 - Notepad++") == 1.0
    assert title_similarity("Invoices - Demo ERP", "Invoices.xlsx - Excel") < 0.5  # too different to count

    class W:
        def __init__(self, name):
            self.Name = name

    windows = [(W("Inbox - Outlook"), "Inbox - Outlook"), (W("new 5 - Notepad++"), "new 5 - Notepad++")]
    assert _closest_window(windows, "*new 4 - Notepad++", "").Name == "new 5 - Notepad++"
    assert _closest_window(windows, "Calculator", "") is None


def test_windows_are_found_when_their_title_changed(h, demo_erp):
    """Recorded titles go out of date (document names, states); the program finds the window."""
    stale = {"id": "customer", "name": "Customer box", "kind": "desktop",
             "context": {"window": "Old title of the invoice screen", "process": "DemoErp.exe"},
             "selectors": [{"strategy": "uia", "value": "Edit #txtCustomer",
                            "options": {"automation_id": "txtCustomer", "control_type": "Edit"}}]}
    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner

    events: list[dict] = []
    flow = Flow.model_validate({"id": "t", "name": "t", "elements": [stale], "settings": {"default_timeout": 6}, "steps": [
        step("desktop.launch", {"program": str(demo_erp), "window": "Demo ERP - Old title", "close_at_end": True}),
        step("desktop.activate_window", {"window": "Some other title", "process": "DemoErp.exe"}),
        step("desktop.type", {"element": "customer", "text": "Found it"}),
        step("desktop.get_text", {"element": "customer"}, outputs={"text": "typed"}),
        # Closing only ever uses the exact title: a look-alike is left alone.
        step("desktop.close_window", {"window": "Demo ERP - Old title", "process": "DemoErp.exe", "timeout": 1}),
        step("desktop.activate_window", {"window": "Demo ERP - Invoices", "timeout": 2}),
    ]})
    runner = FlowRunner(flow, RunOptions(work_dir=h.tmp_path / "run"), events.append)
    result = runner.run()
    assert result.status == "succeeded", result.error
    assert runner.ctx.variables["typed"] == "Found it"
    warnings = [e["message"] for e in events if e["event"] == "log" and e.get("level") == "warning"]
    assert any("using 'Demo ERP - Invoices'" in w for w in warnings), warnings


def test_clicks_and_the_mouse_at_positions(tmp_path, demo_erp):
    import uiautomation as auto

    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner

    process = subprocess.Popen([str(demo_erp)])
    try:
        window = auto.WindowControl(searchDepth=1, Name="Demo ERP - Invoices")
        assert window.Exists(15)
        window.SetActive()
        frame = window.BoundingRectangle
        save = window.ButtonControl(AutomationId="btnSave").BoundingRectangle
        status = window.TextControl(AutomationId="lblStatus").BoundingRectangle
        # The Save button's centre, measured from the window's top-left corner.
        in_window = f"{(save.left + save.right) // 2 - frame.left}, {(save.top + save.bottom) // 2 - frame.top}"

        def fill(invoice: str) -> list[dict]:
            return [
                step("desktop.type", {"element": "customer", "text": "Initech"}),
                step("desktop.type", {"element": "invoice", "text": invoice}),
                step("desktop.type", {"element": "amount", "text": "5"}),
                step("desktop.select", {"element": "currency", "option": "USD"}),
            ]

        steps = [
            *fill("INV-90"),
            step("desktop.click_at", {"window": "Demo ERP", "position": in_window}),
            step("desktop.wait_for", {"element": "status", "state": "text contains", "text": "INV-90", "timeout": 10}),
            *fill("INV-91"),
            step("desktop.click", {"element": "save", "point": "6, 6"}),  # near its top-left corner
            step("desktop.wait_for", {"element": "status", "state": "text contains", "text": "INV-91", "timeout": 10}),
            step("desktop.move_mouse", {"relative_to": "screen", "position": f"{save.left + 3}, {save.top + 3}"}),
            step("desktop.move_mouse", {"position": "10, 10"}),  # in the window in front
            step("desktop.scroll", {"element": "grid", "times": 1}),
            step("desktop.hover", {"element": "status", "point": "2, 2"}),
        ]
        events: list[dict] = []
        flow = Flow.model_validate({"id": "m", "name": "m", "elements": ELEMENTS, "steps": steps,
                                    "settings": {"default_timeout": 10}})
        result = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run"), events.append).run()
        assert result.status == "succeeded", result.error
        assert len([e for e in events if e["event"] == "step_finished"]) == len(steps)
        assert auto.GetCursorPos() == (status.left + 2, status.top + 2)  # hovered 2 px inside the label
    finally:
        process.kill()


def test_position_picker_reports_screen_window_and_element_points(demo_erp):
    """Point somewhere and press Ctrl: the point on screen, in the window and inside an element."""
    import ctypes
    import threading
    import time

    from autoflow_engine.design.desktop_picker import DesktopPicker
    from autoflow_engine.selectors.desktop import find_window, uia

    app = subprocess.Popen([str(demo_erp)])
    answer: dict = {}
    done = threading.Event()
    try:
        auto = uia()
        with auto.UIAutomationInitializerInThread():
            window = find_window({"window": "Demo ERP"}, 15)
            window.SetActive(waitTime=0.3)
            frame = window.BoundingRectangle
            save = auto.ButtonControl(searchFromControl=window, AutomationId="btnSave").BoundingRectangle
        point = (save.left + 7, save.top + 5)

        def respond(result=None, error=None):
            answer.update(result=result, error=error)
            done.set()

        picker = DesktopPicker(lambda method, params: None, ignore_pids=set())
        save_element = next(e for e in ELEMENTS if e["id"] == "save")
        picker.pick_point(respond, save_element)
        user32 = ctypes.windll.user32
        user32.SetCursorPos(*point)
        time.sleep(1.0)  # the picker finds the element, then follows the mouse
        user32.keybd_event(0x11, 0, 0, 0)  # Ctrl down
        time.sleep(0.15)
        user32.keybd_event(0x11, 0, 2, 0)  # Ctrl up
        assert done.wait(10), "no position was picked"
        assert answer["error"] is None, answer["error"]
        picked = answer["result"]
        assert picked["screen"] == {"x": point[0], "y": point[1]}
        assert picked["element"] == {"x": 7, "y": 5}
        assert picked["window"]["title"] == "Demo ERP - Invoices"
        assert picked["window"]["process"] == "DemoErp.exe"
        assert (picked["window"]["x"], picked["window"]["y"]) == (point[0] - frame.left, point[1] - frame.top)
    finally:
        app.kill()


def test_menus_lists_details_pictures_and_text_on_screen(tmp_path, demo_erp):
    """Release C: Brity's App, ImageRecognition and OCR steps against the demo ERP."""
    import uiautomation as auto

    from autoflow_engine.flow import Flow
    from autoflow_engine.runtime.context import RunOptions
    from autoflow_engine.runtime.interpreter import FlowRunner
    from autoflow_engine.selectors import screen

    elements = [*ELEMENTS, el("customers", "Known customers", "lstCustomers", "List")]
    process = subprocess.Popen([str(demo_erp)])
    try:
        window = auto.WindowControl(searchDepth=1, Name="Demo ERP - Invoices")
        assert window.Exists(15)
        window.SetActive()
        save = window.ButtonControl(AutomationId="btnSave").BoundingRectangle
        # A picture of the Save button, as if captured in Studio.
        button = screen.to_png_data_uri(screen.grab((save.left, save.top, save.right, save.bottom)))

        def fill(invoice: str) -> list[dict]:
            return [
                step("desktop.type", {"element": "invoice", "text": invoice}),
                step("desktop.type", {"element": "amount", "text": "5"}),
                step("desktop.select", {"element": "currency", "option": "EUR"}),
            ]

        status = {"element": "status", "state": "text contains", "timeout": 10}
        steps = [
            step("desktop.select_menu", {"window": "Demo ERP", "menu": "Help > About"}),
            step("desktop.wait_for", {**status, "text": "Demo ERP 1.0"}),
            step("desktop.read_list", {"element": "customers"}, outputs={"items": "known"}),
            step("desktop.element_info", {"element": "save"}, outputs={"details": "save_info"}),
            step("desktop.element_exists", {"element": "save"}, outputs={"found": "has_save"}),
            *fill("INV-301"),
            step("screen.image_exists", {"image": button}, outputs={"found": "seen"}),
            step("screen.click_image", {"image": button}),
            step("desktop.wait_for", {**status, "text": "INV-301"}),
            step("screen.read_text", {"look_in": "window", "window": "Demo ERP"}, outputs={"text": "words"}),
            *fill("INV-302"),
            step("screen.click_text", {"text": "Save invoice", "look_in": "window", "window": "Demo ERP"}),
            step("screen.wait_text", {"text": "INV-302", "look_in": "window", "window": "Demo ERP", "timeout": 15}),
            step("screen.capture", {"look_in": "window", "window": "Demo ERP", "file": str(tmp_path / "erp")},
                 outputs={"file": "shot"}),
            step("desktop.select_menu", {"window": "Demo ERP", "menu": "File > Clear form"}),
            step("desktop.wait_for", {**status, "text": "Form cleared"}),
            step("desktop.close_program", {"program": "DemoErp.exe"}),
        ]
        flow = Flow.model_validate({"id": "c", "name": "c", "elements": elements, "steps": steps,
                                    "settings": {"default_timeout": 10}})
        runner = FlowRunner(flow, RunOptions(work_dir=tmp_path / "run"), lambda e: None)
        result = runner.run()
        assert result.status == "succeeded", result.error
        v = runner.ctx.variables
        assert v["known"] == ["Acme", "Globex", "Initech"]
        assert v["save_info"]["enabled"] is True and v["save_info"]["visible"] is True
        assert (v["save_info"]["x"], v["save_info"]["width"]) == (save.left, save.width())
        assert v["has_save"] is True and v["seen"] is True
        assert "Customer" in v["words"] and "Invoice number" in v["words"]
        assert Path(v["shot"]).suffix == ".png" and Path(v["shot"]).stat().st_size > 1000
        process.wait(15)  # "Close program" closed it
    finally:
        if process.poll() is None:
            process.kill()


def test_missing_pictures_fail_clearly(h):
    from autoflow_engine.selectors import screen
    from PIL import Image

    noise = Image.effect_noise((40, 30), 120).convert("RGB")  # nothing on screen looks like this
    picture = screen.to_png_data_uri(noise)
    result = h.run([
        step("screen.image_exists", {"image": picture, "timeout": 0}, outputs={"found": "seen"}),
        step("screen.click_image", {"image": picture, "timeout": 0.5}),
    ])
    assert h.vars["seen"] is False
    assert result.status == "failed"
    assert "not found on the screen" in result.error["message"]


def test_inspector_browses_a_window_and_capture_draws_a_box(demo_erp):
    import threading
    import time

    import uiautomation as auto

    from autoflow_engine.design import inspector
    from autoflow_engine.design.snip import Snipper

    process = subprocess.Popen([str(demo_erp)])
    try:
        window = auto.WindowControl(searchDepth=1, Name="Demo ERP - Invoices")
        assert window.Exists(15)
        window.SetActive()
        listed = next(w for w in inspector.windows() if w["title"] == "Demo ERP - Invoices")
        assert listed["process"] == "DemoErp.exe"

        # Walk the tree like the inspector dialog does, down to the Save button.
        def search(path: list[int], depth: int = 0) -> list[int] | None:
            for child in inspector.children(listed["handle"], path):
                if child["automation_id"] == "btnSave":
                    return [*path, child["index"]]
                if child["has_children"] and depth < 4:
                    found = search([*path, child["index"]], depth + 1)
                    if found:
                        return found
            return None

        path = search([])
        assert path is not None
        element = inspector.element(listed["handle"], path)
        assert element["name"] == "Save invoice button"
        assert element["selectors"][0]["options"]["automation_id"] == "btnSave"
        assert inspector.highlight(listed["handle"], path)["width"] > 10

        # Capture: the screen freezes and a box is drawn with the mouse.
        frame = window.BoundingRectangle
        answer: dict = {}
        done = threading.Event()
        snipper = Snipper()
        snipper.snip(lambda result=None, error=None: (answer.update(result=result, error=error), done.set()))
        time.sleep(1.5)
        x0, y0 = frame.left + 20, frame.top + 60
        auto.PressMouse(x0, y0, waitTime=0.1)
        auto.MoveTo(x0 + 120, y0 + 50, moveSpeed=1, waitTime=0.1)
        auto.ReleaseMouse(waitTime=0.1)
        assert done.wait(10), "the capture never finished"
        assert answer["error"] is None, answer["error"]
        shot = answer["result"]
        assert shot["image"].startswith("data:image/png;base64,")
        assert abs(shot["width"] - 120) <= 2 and abs(shot["height"] - 50) <= 2
        assert (shot["x"], shot["y"]) == (x0, y0)
        assert shot["window"]["title"] == "Demo ERP - Invoices"
    finally:
        process.kill()
