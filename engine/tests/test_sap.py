"""SAP GUI steps, against a stand-in for SAP GUI Scripting's object model (there is no SAP system
in the tests). Ids, method and property names follow SAP's GUI Scripting API."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import step

from autoflow_engine.activities import sap
from autoflow_engine.values import Credential


class Coll:
    def __init__(self, items: list[Any]):
        self.items = items

    @property
    def Count(self) -> int:  # noqa: N802 - SAP's names
        return len(self.items)

    def Item(self, i: Any) -> Any:  # noqa: N802
        return self.items[i]

    ElementAt = Item


class Control:
    def __init__(self, type_: str, text: str = "", **extra: Any):
        self.Type, self.Text, self.SubType = type_, text, extra.pop("SubType", "")
        self.pressed = 0
        self.__dict__.update(extra)

    def Press(self) -> None:  # noqa: N802
        self.pressed += 1

    def Select(self) -> None:  # noqa: N802
        self.selected_by_select = True

    def SetFocus(self) -> None:  # noqa: N802
        self.focused = True


class Grid(Control):
    """An ALV grid that, like SAP's, only knows rows after they were scrolled into view."""

    def __init__(self, rows: list[dict[str, str]], titles: dict[str, str]):
        super().__init__("GuiShell", SubType="GridView")
        self.rows, self.titles, self.loaded = rows, titles, set()
        self.ColumnOrder = Coll(list(titles))
        self.RowCount, self.VisibleRowCount = len(rows), 2
        self._first = 0
        self.calls: list[tuple] = []

    @property
    def FirstVisibleRow(self) -> int:  # noqa: N802
        return self._first

    @FirstVisibleRow.setter
    def FirstVisibleRow(self, row: int) -> None:  # noqa: N802
        self._first = row
        self.loaded.update(range(row, row + self.VisibleRowCount))

    def GetColumnTitles(self, column: str) -> Coll:  # noqa: N802
        return Coll([self.titles[column]])

    def GetCellValue(self, row: int, column: str) -> str:  # noqa: N802
        assert row in self.loaded, f"row {row} was never scrolled into view"
        return self.rows[row][column]

    def SetCurrentCell(self, row: int, column: str) -> None:  # noqa: N802
        self.calls.append(("current", row, column))

    def DoubleClickCurrentCell(self) -> None:  # noqa: N802
        self.calls.append(("double_click",))

    def ClickCurrentCell(self) -> None:  # noqa: N802
        self.calls.append(("click",))

    def PressToolbarButton(self, button: str) -> None:  # noqa: N802
        self.calls.append(("toolbar", button))

    def ModifyCell(self, row: int, column: str, value: str) -> None:  # noqa: N802
        self.rows[row][column] = value


class Tree(Control):
    def __init__(self) -> None:
        super().__init__("GuiShell", SubType="Tree")
        self.nodes = {"1": ("Favorites", ""), "2": ("Sales", "1"), "3": ("VA01", "2"), "4": ("VA01", "1")}
        self.calls: list[tuple] = []

    def GetAllNodeKeys(self) -> Coll:  # noqa: N802
        return Coll(list(self.nodes))

    def GetNodeTextByKey(self, key: str) -> str:  # noqa: N802
        return self.nodes[key][0]

    def GetParent(self, key: str) -> str:  # noqa: N802
        return self.nodes[key][1]

    def ExpandNode(self, key: str) -> None:  # noqa: N802
        self.calls.append(("expand", key))

    def SelectNode(self, key: str) -> None:  # noqa: N802
        self.calls.append(("select", key))

    def DoubleClickNode(self, key: str) -> None:  # noqa: N802
        self.calls.append(("double_click", key))


class Window(Control):
    def __init__(self, session: Session):
        super().__init__("GuiMainWindow", "SAP Easy Access")
        self.session = session

    def sendVKey(self, key: int) -> None:  # noqa: N802
        self.session.keys.append(key)
        self.session.on_key(key)


class Session:
    def __init__(self) -> None:
        self.keys: list[int] = []
        self.Busy = False
        self.transactions: list[str] = []
        self.sbar = Control("GuiStatusbar", "", MessageType="")
        self.controls: dict[str, Any] = {"wnd[0]": Window(self), "wnd[0]/sbar": self.sbar}
        self.Info = type("Info", (), {"SystemName": "PRD", "Client": "100", "User": "ROBOT1", "Transaction": "SESSION_MANAGER"})()
        self.on_key = lambda key: None

    def findById(self, cid: str) -> Any:  # noqa: N802
        if cid not in self.controls:
            raise RuntimeError(f"The control could not be found by id. ({cid})")
        return self.controls[cid]

    def StartTransaction(self, code: str) -> None:  # noqa: N802
        self.transactions.append(code)
        self.Info.Transaction = code

    def status(self, text: str, kind: str) -> None:
        self.sbar.Text, self.sbar.MessageType = text, kind


class Connection:
    def __init__(self, description: str, sessions: list[Session]):
        self.Description = description
        self.Children = Coll(sessions)
        self.closed = False

    def CloseConnection(self) -> None:  # noqa: N802
        self.closed = True


class App:
    def __init__(self, connections: list[Connection]):
        self.Children = Coll(connections)
        self.opened: list[Connection] = []

    def OpenConnection(self, name: str, sync: bool) -> Connection:  # noqa: N802
        session = Session()
        for field in ("txtRSYST-MANDT", "txtRSYST-BNAME", "pwdRSYST-BCODE", "txtRSYST-LANGU"):
            session.controls[f"wnd[0]/usr/{field}"] = Control("GuiTextField")
        connection = Connection(name, [session])
        self.opened.append(connection)
        return connection


@pytest.fixture
def sapgui(monkeypatch):
    session = Session()
    app = App([Connection("QAS - Quality", [Session()]), Connection("PRD - Production", [session])])
    monkeypatch.setattr(sap, "_gui_application", lambda: app)
    return app, session


def test_fields_buttons_dropdowns_and_the_status_bar(h, sapgui):
    _app, session = sapgui
    order_type = session.controls["wnd[0]/usr/ctxtVBAK-AUART"] = Control("GuiCTextField")
    org = session.controls["wnd[0]/usr/cmbVBAK-VKORG"] = Control(
        "GuiComboBox", Key="", Entries=Coll([type("E", (), {"Key": "1000", "Value": "Germany"})(), type("E", (), {"Key": "2000", "Value": "Egypt"})()]))
    rush = session.controls["wnd[0]/usr/chkRUSH"] = Control("GuiCheckBox", Selected=False)
    tab = session.controls["wnd[0]/usr/tabsTAXI/tabpT\\02"] = Control("GuiTab")
    save = session.controls["wnd[0]/tbar[0]/btn[11]"] = Control("GuiButton")
    session.controls["wnd[0]/usr/txtVBAK-VBELN"] = Control("GuiTextField", " 12345 ")
    session.on_key = lambda key: session.status("Standard Order 12345 has been saved", "S") if key == 0 else None

    result = h.run([
        step("sap.connect", {"connection": "prd"}, outputs={"info": "sap"}),
        step("sap.transaction", {"code": "/VA01"}),
        step("sap.set_text", {"field": "usr/ctxtVBAK-AUART", "text": "OR", "press_enter": True}),
        step("sap.select", {"control": "wnd[0]/usr/cmbVBAK-VKORG", "value": "Egypt"}),
        step("sap.select", {"control": "usr/chkRUSH", "value": "yes"}),
        step("sap.select", {"control": "usr/tabsTAXI/tabpT\\02"}),
        step("sap.press", {"button": "wnd[0]/tbar[0]/btn[11]"}),
        step("sap.read", {"control": "usr/txtVBAK-VBELN"}, outputs={"text": "order"}),
        step("sap.status", {}, outputs={"text": "message", "kind": "kind"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["sap"] == {"system": "PRD", "client": "100", "user": "ROBOT1", "transaction": "SESSION_MANAGER"}
    assert session.transactions == ["VA01"]
    assert order_type.Text == "OR" and session.keys == [0]
    assert org.Key == "2000" and rush.Selected is True and tab.selected_by_select and save.pressed == 1
    assert (h.vars["order"], h.vars["message"], h.vars["kind"]) == ("12345", "Standard Order 12345 has been saved", "success")
    assert "SAP: Standard Order 12345 has been saved" in h.logs()


def test_an_sap_error_message_stops_the_run_unless_told_otherwise(h, sapgui):
    app, session = sapgui
    session.on_key = lambda key: session.status("Fill in all required entry fields", "E")
    result = h.run([step("sap.connect", {"connection": "PRD"}), step("sap.press", {"what": "key", "key": "save"})])
    assert result.status == "failed"
    assert result.error["message"] == "SAP shows an error: Fill in all required entry fields"
    assert session.keys == [11]

    # Without a name: the first connection's first window.
    assert h.run([step("sap.connect", {}), step("sap.press", {"what": "key", "key": "enter"})]).status == "succeeded"
    assert app.Children.Item(0).Children.Item(0).keys == [0]

    result = h.run([step("sap.connect", {"connection": "PRD"}),
                    step("sap.press", {"what": "key", "key": "save", "stop_on_error": False})])
    assert result.status == "succeeded"


def test_a_missing_field_says_what_sap_shows(h, sapgui):
    _app, session = sapgui
    session.status("Transaction VA99 does not exist", "E")
    result = h.run([step("sap.connect", {"connection": "PRD"}), step("sap.set_text", {"field": "usr/txtNOPE", "text": "x"})])
    assert result.status == "failed"
    assert result.error["message"] == "The SAP field or button 'wnd[0]/usr/txtNOPE' is not on this screen."
    assert "SAP says: Transaction VA99 does not exist" in result.error["hint"]

    result = h.run([step("sap.read", {"control": "usr/txtX"})])
    assert result.error["message"] == "No SAP session is open in this run."


def test_log_on_with_a_credential_and_close_the_connection_at_the_end(h, sapgui):
    app, _ = sapgui
    creds = {"SAP robot": Credential("SAP robot", "ROBOT1", "S3cret!")}.__getitem__
    result = h.run([step("sap.connect", {"mode": "logon", "connection": "PRD - Production", "credential": "SAP robot",
                                         "client": "100"})], credentials=creds)
    assert result.status == "succeeded", result.error
    connection = app.opened[0]
    fields = connection.Children.Item(0).controls
    assert fields["wnd[0]/usr/txtRSYST-BNAME"].Text == "ROBOT1"
    assert fields["wnd[0]/usr/pwdRSYST-BCODE"].Text == "S3cret!"
    assert fields["wnd[0]/usr/txtRSYST-MANDT"].Text == "100"
    assert connection.Children.Item(0).keys == [0]
    assert connection.closed  # cleaned up when the run ended
    assert "S3cret!" not in str(h.events)


def test_read_an_alv_grid_with_all_rows_and_work_with_it(h, sapgui):
    _app, session = sapgui
    rows = [{"MATNR": f"M-{i}", "MENGE": str(i * 10)} for i in range(5)]
    grid = session.controls["wnd[0]/usr/cntlGRID1/shellcont/shell"] = Grid(rows, {"MATNR": "Material", "MENGE": "Quantity"})
    result = h.run([
        step("sap.connect", {"connection": "PRD"}),
        step("sap.read_table", {"table": "usr/cntlGRID1/shellcont/shell"}, outputs={"rows": "materials"}),
        step("sap.read_table", {"table": "usr/cntlGRID1/shellcont/shell", "column_names": "technical", "max_rows": 2},
             outputs={"rows": "first"}),
        step("sap.table_action", {"table": "usr/cntlGRID1/shellcont/shell", "action": "select_rows", "rows": "1, 3-4"}),
        step("sap.table_action", {"table": "usr/cntlGRID1/shellcont/shell", "action": "double_click", "row": 2,
                                  "column": "MATNR"}),
        step("sap.table_action", {"table": "usr/cntlGRID1/shellcont/shell", "action": "toolbar", "button": "&MB_EXPORT"}),
    ])
    assert result.status == "succeeded", result.error
    table = h.vars["materials"]
    assert table.columns == ["Material", "Quantity"]
    assert [r["Material"] for r in table.rows] == ["M-0", "M-1", "M-2", "M-3", "M-4"]
    assert h.vars["first"].columns == ["MATNR", "MENGE"] and len(h.vars["first"].rows) == 2
    assert grid.SelectedRows == "0,2,3"
    assert grid.calls == [("current", 1, "MATNR"), ("double_click",), ("toolbar", "&MB_EXPORT")]

    result = h.run([step("sap.connect", {"connection": "PRD"}),
                    step("sap.table_action", {"table": "usr/cntlGRID1/shellcont/shell", "rows": "2-x"})])
    assert result.error["message"] == "'2-x' is not a row number."


def test_read_a_table_control_page_by_page(h, sapgui):
    _app, session = sapgui
    data = [[f"10{i}", f"Item {i}"] for i in range(5)]
    tid = "wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG"

    class TableControl(Control):
        def __init__(self, first: int):
            super().__init__("GuiTableControl")
            self.first = first
            self.Columns = Coll([type("C", (), {"Title": "Item", "Name": "RV45A-POSNR"})(),
                                 type("C", (), {"Title": "Description", "Name": "VBAP-ARKTX"})()])
            self.RowCount, self.VisibleRowCount = len(data), 2
            scrollbar = type("S", (), {})()
            control = self

            class Bar:
                @property
                def Position(self) -> int:  # noqa: N802
                    return control.first

                @Position.setter
                def Position(self, row: int) -> None:  # noqa: N802
                    session.controls[tid] = TableControl(row)  # SAP draws a new screen when scrolled

            self.VerticalScrollbar = Bar()
            del scrollbar

        def GetCell(self, row: int, column: int) -> Control:  # noqa: N802
            return Control("GuiTextField", data[self.first + row][column])

    session.controls[tid] = TableControl(0)
    result = h.run([step("sap.connect", {"connection": "PRD"}), step("sap.read_table", {"table": tid}, outputs={"rows": "items"})])
    assert result.status == "succeeded", result.error
    assert h.vars["items"].columns == ["Item", "Description"]
    assert [r["Description"] for r in h.vars["items"].rows] == [f"Item {i}" for i in range(5)]


def test_trees_by_path(h, sapgui):
    _app, session = sapgui
    tree = session.controls["wnd[0]/shellcont/shell/shellcont[0]/shell"] = Tree()
    result = h.run([
        step("sap.connect", {"connection": "PRD"}),
        step("sap.tree", {"tree": "wnd[0]/shellcont/shell/shellcont[0]/shell", "path": "Favorites / Sales / va01"}),
        step("sap.tree", {"tree": "wnd[0]/shellcont/shell/shellcont[0]/shell", "action": "read"}, outputs={"nodes": "names"}),
    ])
    assert result.status == "succeeded", result.error
    # The VA01 under Sales (key 3), not the one directly under Favorites (key 4).
    assert tree.calls == [("expand", "1"), ("expand", "2"), ("double_click", "3")]
    assert h.vars["names"] == ["Favorites", "Sales", "VA01", "VA01"]

    result = h.run([step("sap.connect", {"connection": "PRD"}),
                    step("sap.tree", {"tree": "wnd[0]/shellcont/shell/shellcont[0]/shell", "path": "Favorites/Nope"})])
    assert result.error["message"] == "The SAP tree has no node 'favorites/nope'."


def test_wait_for_a_field_while_sap_is_busy(h, sapgui, monkeypatch):
    _app, session = sapgui
    session.Busy = True
    ticks = {"n": 0}

    def sleep(_s):
        ticks["n"] += 1
        if ticks["n"] == 3:
            session.Busy = False
            session.controls["wnd[0]/usr/txtRESULT"] = Control("GuiTextField", "done")

    monkeypatch.setattr(sap.time, "sleep", sleep)
    result = h.run([step("sap.connect", {"connection": "PRD"}),
                    step("sap.wait", {"until": "field", "field": "usr/txtRESULT", "timeout": 30})])
    assert result.status == "succeeded", result.error
    assert ticks["n"] == 3

    session.Busy = True
    monkeypatch.setattr(sap.time, "sleep", lambda _s: None)
    monkeypatch.setattr(sap, "Deadline", lambda _s: type("D", (), {"passed": True})())
    result = h.run([step("sap.connect", {"connection": "PRD"}), step("sap.wait", {"timeout": 1})])
    assert result.error["message"] == "Waited 1 seconds for SAP to finish."


def test_no_sap_gui_running_is_explained(h, monkeypatch):
    import comtypes.client

    def fail(*_a, **_k):
        raise OSError("Operation unavailable")

    monkeypatch.setattr(comtypes.client, "CoGetObject", fail)
    monkeypatch.setattr(comtypes.client, "CreateObject", fail)
    result = h.run([step("sap.connect", {})])
    assert result.error["message"] == "SAP GUI is not running, or scripting is turned off."
    assert "Start SAP Logon first" in result.error["hint"]


def test_studio_takes_the_id_of_the_sap_field_with_the_cursor(monkeypatch):
    focus = Control("GuiCTextField", "OR", Id="/app/con[0]/ses[1]/wnd[0]/usr/ctxtVBAK-AUART")
    window = type("W", (), {"GuiFocus": focus})()
    app = type("A", (), {"ActiveSession": type("S", (), {"ActiveWindow": window})()})()
    monkeypatch.setattr(sap, "_gui_application", lambda: app)
    assert sap.focused_control() == {"id": "wnd[0]/usr/ctxtVBAK-AUART", "type": "GuiCTextField", "text": "OR"}

    window.GuiFocus = None
    with pytest.raises(sap.ActivityError, match="No SAP field has the cursor"):
        sap.focused_control()
