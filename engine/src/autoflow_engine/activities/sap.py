"""SAP GUI for Windows (Brity's SAP library), through SAP GUI Scripting - the interface SAP provides
for automation. Scripting must be allowed on the SAP server (RZ11: sapgui/user_scripting = TRUE)
and in SAP GUI (Options > Accessibility & Scripting > Scripting).

Fields and buttons are found by their SAP id, e.g. ``wnd[0]/usr/ctxtVBAK-AUART``: SAP's own script
recorder (Customize Local Layout > Script Recording and Playback) shows them, and "Read SAP field"
accepts the short form ``usr/ctxtVBAK-AUART`` for the main window.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Literal

from ..catalog import NoParams, OutputDef, Param, Params, activity
from ..errors import ActivityError, RunCancelled
from ..runtime.context import Deadline, RunContext
from ..values import Table, to_text

S = "SAP"
_KEY = "sap.session"

# SAP virtual keys (GuiFrameWindow.sendVKey)
VKEYS = {"enter": 0, "f1": 1, "f2": 2, "f3": 3, "f4": 4, "f5": 5, "f6": 6, "f7": 7, "f8": 8, "f9": 9,
         "f12": 12, "save": 11, "back": 3, "exit": 15, "cancel": 12, "page_down": 82, "page_up": 81}
STATUS = {"S": "success", "W": "warning", "E": "error", "A": "abort", "I": "information"}


def _gui_application() -> Any:
    """The running SAP GUI (SAP Logon must be open)."""
    import comtypes.client

    try:
        return comtypes.client.CoGetObject("SAPGUI", dynamic=True).GetScriptingEngine
    except Exception:
        pass
    try:  # the wrapper SAP installs for programs that can't read the running object table directly
        wrapper = comtypes.client.CreateObject("SapROTWr.SapROTWrapper", dynamic=True)
        return wrapper.GetROTEntry("SAPGUI").GetScriptingEngine
    except Exception:
        raise ActivityError(
            "SAP GUI is not running, or scripting is turned off.",
            "Start SAP Logon first. Scripting must be allowed in SAP GUI (Options > Accessibility & Scripting) "
            "and on the SAP server (sapgui/user_scripting).",
        ) from None


def _com_for_run(ctx: RunContext) -> None:
    """SAP's objects are used by every SAP step of the run (all on the run's thread): set up COM there
    once, and release it after the SAP objects are dropped at the end of the run."""
    if ctx.resources.get("sap.com"):
        return
    import comtypes

    comtypes.CoInitialize()
    ctx.resources["sap.com"] = True

    def release() -> None:
        ctx.resources.pop(_KEY, None)
        import gc

        gc.collect()
        comtypes.CoUninitialize()

    ctx.add_cleanup("sap.com", release)


def focused_control() -> dict[str, str]:
    """For Studio: the SAP field (or button) that has the cursor in the SAP window used last."""
    import comtypes

    comtypes.CoInitialize()
    try:
        app = _gui_application()
        try:
            focus = app.ActiveSession.ActiveWindow.GuiFocus
            full = to_text(focus.Id)
        except Exception:
            raise ActivityError("No SAP field has the cursor.", "Click into the field in SAP, then try again.") from None
        short = full[full.find("wnd["):] if "wnd[" in full else full  # /app/con[0]/ses[0]/wnd[0]/... -> wnd[0]/...
        return {"id": short, "type": to_text(focus.Type), "text": to_text(getattr(focus, "Text", ""))[:100]}
    finally:
        comtypes.CoUninitialize()


def _session(ctx: RunContext) -> Any:
    session = ctx.resources.get(_KEY)
    if session is None:
        raise ActivityError("No SAP session is open in this run.", "Add 'Attach to SAP' before the SAP steps.")
    return session


def _full_id(control_id: str) -> str:
    cid = to_text(control_id).strip()
    if not cid:
        raise ActivityError("Enter the SAP id of the field or button.")
    return cid if cid.startswith("wnd[") or cid.startswith("/app/") else f"wnd[0]/{cid.lstrip('/')}"


def _find(ctx: RunContext, control_id: str) -> Any:
    session = _session(ctx)
    cid = _full_id(control_id)
    try:
        return session.findById(cid)
    except Exception:
        status = _status_text(session)
        raise ActivityError(
            f"The SAP field or button '{cid}' is not on this screen.",
            (f"SAP says: {status}. " if status else "")
            + "Check that the right screen is open; SAP's script recorder shows the ids.",
        ) from None


def _status(session: Any) -> tuple[str, str]:
    try:
        bar = session.findById("wnd[0]/sbar")
        return to_text(bar.Text), STATUS.get(to_text(bar.MessageType), "")
    except Exception:
        return "", ""


def _status_text(session: Any) -> str:
    return _status(session)[0]


def _wait_idle(ctx: RunContext, session: Any, seconds: float = 60) -> None:
    deadline = Deadline(seconds)
    while _busy(session):
        if ctx.control.cancelled:
            raise RunCancelled()
        if deadline.passed:
            raise ActivityError(f"SAP was still busy after {int(seconds)} seconds.")
        time.sleep(0.2)


def _busy(session: Any) -> bool:
    try:
        return bool(session.Busy)
    except Exception:
        return False


def _check(ctx: RunContext, session: Any, stop_on_error: bool) -> None:
    """After an action: wait until SAP is done, then stop if its status bar shows an error."""
    _wait_idle(ctx, session)
    text, kind = _status(session)
    if text:
        ctx.log(f"SAP: {text}", "warning" if kind in ("warning", "error", "abort") else "info")
    if stop_on_error and kind in ("error", "abort"):
        raise ActivityError(f"SAP shows an error: {text}", "Check the values entered on this screen.")


# -- session ------------------------------------------------------------------------------------


class AttachParams(Params):
    mode: Literal["attach", "logon"] = Param(
        "attach", title="SAP",
        labels={"attach": "Use the SAP window that is open", "logon": "Open a connection and log on"},
    )
    connection: str = Param(
        "", title="Connection", placeholder="PRD - Production",
        description="As it is called in SAP Logon. For 'use the open window', leave empty for the first one.",
    )
    session_number: int = Param(0, title="Session", ge=0, le=5, advanced=True,
                                description="Which window of the connection: 0 is the first.")
    credential: str = Param("", title="Credential", ui="credential", show_when={"mode": ["logon"]})
    client: str = Param("", title="Client", placeholder="100", show_when={"mode": ["logon"]})
    language: str = Param("EN", title="Language", show_when={"mode": ["logon"]}, advanced=True)
    close_at_end: bool = Param(True, title="Close the connection when the automation ends",
                               show_when={"mode": ["logon"]})


@activity(
    "sap.connect",
    title="Attach to SAP",
    category=S,
    icon="building",
    sentence="Attach to SAP {connection}",
    description="Use an open SAP GUI window, or open a connection from SAP Logon and log on with a saved "
    "credential. The SAP steps after it work in this window.",
    params=AttachParams,
    outputs=[OutputDef("info", "Session", "any")],
)
def connect(ctx: RunContext, p: AttachParams) -> dict[str, Any]:
    _com_for_run(ctx)
    app = _gui_application()
    name = to_text(p.connection).strip()
    if p.mode == "logon":
        if not name:
            raise ActivityError("Enter the connection's name as it is called in SAP Logon.")
        cred = ctx.credential(p.credential)
        try:
            connection = app.OpenConnection(name, True)
        except Exception as exc:
            raise ActivityError(f"SAP could not open the connection '{name}': {exc}",
                                "Check the name in SAP Logon (it must match exactly).") from None
        session = connection.Children.Item(0)
        _wait_idle(ctx, session)
        for field, value in (("wnd[0]/usr/txtRSYST-MANDT", to_text(p.client)), ("wnd[0]/usr/txtRSYST-BNAME", cred.username),
                             ("wnd[0]/usr/pwdRSYST-BCODE", str(cred.password)), ("wnd[0]/usr/txtRSYST-LANGU", to_text(p.language))):
            if value:
                try:
                    session.findById(field).Text = value
                except Exception:
                    raise ActivityError("This is not the SAP log-on screen.", "Is single sign-on in use? Then choose "
                                        "'Use the SAP window that is open'.") from None
        session.findById("wnd[0]").sendVKey(0)
        ctx.resources[_KEY] = session
        _check(ctx, session, stop_on_error=True)
        if p.close_at_end:
            ctx.add_cleanup("sap.connection", lambda: connection.CloseConnection())
    else:
        connections = [app.Children.Item(i) for i in range(int(app.Children.Count))]
        if not connections:
            raise ActivityError("SAP Logon is open, but no SAP system is connected.", "Log on to SAP first.")
        if name:
            match = [c for c in connections if name.casefold() in to_text(c.Description).casefold()]
            if not match:
                raise ActivityError(f"No open SAP connection is called '{name}'.")
            connection = match[0]
        else:
            connection = connections[0]
        if int(connection.Children.Count) <= p.session_number:
            raise ActivityError(f"The SAP connection has no window number {p.session_number}.")
        session = connection.Children.Item(p.session_number)
        ctx.resources[_KEY] = session
    info = session.Info
    return {"system": to_text(info.SystemName), "client": to_text(info.Client), "user": to_text(info.User),
            "transaction": to_text(info.Transaction)}


class TransactionParams(Params):
    code: str = Param(title="Transaction", placeholder="VA01")
    stop_on_error: bool = Param(True, title="Stop if SAP shows an error", advanced=True)


@activity(
    "sap.transaction",
    title="Start SAP transaction",
    category=S,
    icon="square-terminal",
    sentence="Start SAP transaction {code}",
    description="Open a transaction, like typing its code (e.g. VA01, ME21N) in the command field.",
    params=TransactionParams,
)
def transaction(ctx: RunContext, p: TransactionParams) -> None:
    session = _session(ctx)
    code = to_text(p.code).strip().lstrip("/")
    if not code:
        raise ActivityError("Enter a transaction code.")
    session.StartTransaction(code)
    _check(ctx, session, p.stop_on_error)


# -- fields and buttons ---------------------------------------------------------------------------


class SetTextParams(Params):
    field: str = Param(title="Field id", ui="sap_id", placeholder="wnd[0]/usr/ctxtVBAK-AUART")
    text: str = Param("", title="Text")
    press_enter: bool = Param(False, title="Press Enter afterwards")


@activity(
    "sap.set_text",
    title="Type in SAP field",
    category=S,
    icon="text-cursor-input",
    sentence="Type {text} in SAP field {field}",
    params=SetTextParams,
)
def set_text(ctx: RunContext, p: SetTextParams) -> None:
    control = _find(ctx, p.field)
    try:
        control.Text = to_text(p.text)
    except Exception as exc:
        raise ActivityError(f"SAP did not accept the text in '{p.field}': {exc}",
                            "The field may be read-only on this screen.") from None
    if p.press_enter:
        session = _session(ctx)
        session.findById("wnd[0]").sendVKey(0)
        _check(ctx, session, stop_on_error=True)


class PressParams(Params):
    what: Literal["button", "key"] = Param("button", title="Press", labels={"button": "A button", "key": "A key"})
    button: str = Param("", title="Button id", ui="sap_id", placeholder="wnd[0]/tbar[1]/btn[8]", show_when={"what": ["button"]})
    key: Literal["enter", "save", "back", "exit", "cancel", "f2", "f4", "f5", "f6", "f7", "f8", "f9", "page_down",
                 "page_up"] = Param(
        "enter", title="Key", show_when={"what": ["key"]},
        labels={"enter": "Enter", "save": "Save (Ctrl+S)", "back": "Back (F3)", "exit": "Exit (Shift+F3)",
                "cancel": "Cancel (F12)", "f2": "F2", "f4": "F4 (possible values)", "f5": "F5", "f6": "F6", "f7": "F7",
                "f8": "Execute (F8)", "f9": "F9", "page_down": "Page down", "page_up": "Page up"},
    )
    window: int = Param(0, title="Window", ge=0, le=9, advanced=True, description="0 is the main window, 1 a pop-up.")
    stop_on_error: bool = Param(True, title="Stop if SAP shows an error", advanced=True)


@activity(
    "sap.press",
    title="Press SAP button or key",
    category=S,
    icon="mouse-pointer-click",
    sentence="Press {button}{key} in SAP",
    description="Press a button (by its id) or a key such as Enter, Save or Execute (F8), then wait until SAP is done.",
    params=PressParams,
)
def press(ctx: RunContext, p: PressParams) -> None:
    session = _session(ctx)
    if p.what == "button":
        _find(ctx, p.button).Press()
    else:
        try:
            window = session.findById(f"wnd[{p.window}]")
        except Exception:
            raise ActivityError(f"SAP has no window number {p.window} open.") from None
        window.sendVKey(VKEYS[p.key])
    _check(ctx, session, p.stop_on_error)


class SelectParams(Params):
    control: str = Param(title="Id", ui="sap_id", placeholder="wnd[0]/usr/cmbVBAK-VKORG or wnd[0]/usr/tabsTAXI/tabpT\\01")
    value: str = Param(
        "", title="Value",
        description="Dropdowns: the key (e.g. 1000). Checkboxes: yes or no. Tabs, radio buttons and menus: leave empty.",
    )


@activity(
    "sap.select",
    title="Select in SAP",
    category=S,
    icon="list-checks",
    sentence="Select {value} in SAP {control}",
    description="Choose in a dropdown, tick a checkbox, pick a radio button, open a tab or a menu entry.",
    params=SelectParams,
)
def select(ctx: RunContext, p: SelectParams) -> None:
    control = _find(ctx, p.control)
    kind = to_text(getattr(control, "Type", ""))
    value = to_text(p.value).strip()
    try:
        if kind == "GuiComboBox":
            keys = _combo_keys(control)
            if keys and value not in keys:
                matches = [k for k, text in keys.items() if text.casefold() == value.casefold()]
                if not matches:
                    raise ActivityError(f"'{value}' is not in the SAP dropdown.", f"It has: {', '.join(keys)}.")
                value = matches[0]
            control.Key = value
        elif kind == "GuiCheckBox":
            control.Selected = value.casefold() not in ("no", "false", "0", "off", "")
        else:  # GuiRadioButton, GuiTab, GuiMenu, ...
            control.Select()
    except ActivityError:
        raise
    except Exception as exc:
        raise ActivityError(f"SAP did not accept the selection in '{p.control}': {exc}") from None
    _wait_idle(ctx, _session(ctx))


def _combo_keys(control: Any) -> dict[str, str]:
    try:
        entries = control.Entries
        return {to_text(entries.Item(i).Key): to_text(entries.Item(i).Value) for i in range(int(entries.Count))}
    except Exception:
        return {}


class ReadParams(Params):
    control: str = Param(title="Id", ui="sap_id", placeholder="wnd[0]/usr/txtVBAK-VBELN")


@activity(
    "sap.read",
    title="Read SAP field",
    category=S,
    icon="scan-text",
    sentence="Read SAP field {control}",
    params=ReadParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="sap_text")],
)
def read(ctx: RunContext, p: ReadParams) -> str:
    control = _find(ctx, p.control)
    kind = to_text(getattr(control, "Type", ""))
    if kind == "GuiCheckBox":
        return "yes" if control.Selected else "no"
    if kind == "GuiComboBox":
        return to_text(control.Key)
    return to_text(control.Text).strip()


@activity(
    "sap.status",
    title="Read SAP status bar",
    category=S,
    icon="message-square-warning",
    sentence="Read the SAP status bar",
    description="The message at the bottom of the SAP window, e.g. 'Standard Order 12345 has been saved', and its "
    "kind (success, warning, error).",
    params=NoParams,
    outputs=[OutputDef("text", "Message", "text", default_variable="sap_message"),
             OutputDef("kind", "Kind", "text", default_variable="sap_message_kind")],
)
def status(ctx: RunContext, _p: NoParams) -> dict[str, str]:
    text, kind = _status(_session(ctx))
    return {"text": text, "kind": kind}


# -- tables (ALV grids and table controls) --------------------------------------------------------


class GridParams(Params):
    table: str = Param(title="Table id", ui="sap_id", placeholder="wnd[0]/usr/cntlGRID1/shellcont/shell")
    max_rows: int = Param(10_000, title="At most", ge=1, le=1_000_000, advanced=True)
    column_names: Literal["titles", "technical"] = Param(
        "titles", title="Column names", advanced=True,
        labels={"titles": "As shown (e.g. Material)", "technical": "Technical (e.g. MATNR)"},
    )


def _is_grid(control: Any) -> bool:
    return to_text(getattr(control, "SubType", "")) == "GridView" or to_text(getattr(control, "Type", "")) == "GuiShell"


@activity(
    "sap.read_table",
    title="Read SAP table",
    category=S,
    icon="table",
    sentence="Read SAP table {table}",
    description="Read an SAP list (ALV grid) or table control into a table, all rows - also the ones you would "
    "have to scroll to.",
    params=GridParams,
    outputs=[OutputDef("rows", "Rows", "table", default_variable="sap_rows")],
)
def read_table(ctx: RunContext, p: GridParams) -> Table:
    control = _find(ctx, p.table)
    if _is_grid(control):
        return _read_grid(control, p)
    return _read_table_control(ctx, control, p)


def _read_grid(grid: Any, p: GridParams) -> Table:
    order = grid.ColumnOrder
    columns = [to_text(order.Item(i)) for i in range(int(order.Count))]
    titles = []
    for c in columns:
        title = to_text(grid.GetColumnTitles(c).Item(0)) if p.column_names == "titles" else c
        titles.append(_unique(title or c, titles))
    table = Table(titles)
    total = min(int(grid.RowCount), p.max_rows)
    visible = max(int(getattr(grid, "VisibleRowCount", 0) or 0), 1)
    for row in range(total):
        if row % visible == 0:
            grid.FirstVisibleRow = row  # the grid only loads rows that have been shown
        table.append({t: to_text(grid.GetCellValue(row, c)) for t, c in zip(titles, columns, strict=True)})
    return table


def _read_table_control(ctx: RunContext, control: Any, p: GridParams) -> Table:
    columns = control.Columns
    titles: list[str] = []
    for i in range(int(columns.Count)):
        column = columns.ElementAt(i)
        name = to_text(column.Title) if p.column_names == "titles" else to_text(column.Name).split("-")[-1]
        titles.append(_unique(name or f"Column {i + 1}", titles))
    table = Table(titles)
    total = min(int(control.RowCount), p.max_rows)
    session = _session(ctx)
    table_id = _full_id(p.table)
    scrollbar = control.VerticalScrollbar
    visible = max(int(control.VisibleRowCount), 1)
    row = 0
    while row < total:
        scrollbar.Position = row  # SAP builds a new screen: look the control up again
        _wait_idle(ctx, session)
        control = session.findById(table_id)
        for offset in range(min(visible, total - row)):
            values = {}
            for i, title in enumerate(titles):
                try:
                    values[title] = to_text(control.GetCell(offset, i).Text).strip()
                except Exception:
                    values[title] = ""
            table.append(values)
        row += visible
    return table


def _unique(name: str, taken: list[str]) -> str:
    candidate, n = name, 2
    while candidate in taken:
        candidate, n = f"{name} {n}", n + 1
    return candidate


class TableActionParams(Params):
    table: str = Param(title="Table id", ui="sap_id", placeholder="wnd[0]/usr/cntlGRID1/shellcont/shell")
    action: Literal["select_rows", "double_click", "click_cell", "toolbar", "set_cell"] = Param(
        "select_rows", title="Do",
        labels={"select_rows": "Select rows", "double_click": "Double-click a cell", "click_cell": "Click a cell",
                "toolbar": "Press a table toolbar button", "set_cell": "Type in a cell (table control)"},
    )
    rows: str = Param("", title="Rows", placeholder="1, 3-5", show_when={"action": ["select_rows"]},
                      description="Row numbers, starting at 1.")
    row: int = Param(1, title="Row", ge=1, show_when={"action": ["double_click", "click_cell", "set_cell"]})
    column: str = Param("", title="Column", placeholder="MATNR",
                        show_when={"action": ["double_click", "click_cell", "set_cell"]},
                        description="The technical column name (grids) or its position, starting at 1 (table controls).")
    button: str = Param("", title="Button", placeholder="&MB_EXPORT", show_when={"action": ["toolbar"]})
    value: str = Param("", title="Text", show_when={"action": ["set_cell"]})


def _row_numbers(text: str) -> list[int]:
    rows: list[int] = []
    for part in to_text(text).replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                a, b = (int(x) for x in part.split("-", 1))
                rows.extend(range(a, b + 1))
            else:
                rows.append(int(part))
        except ValueError:
            raise ActivityError(f"'{part}' is not a row number.", "Write rows like 1, 3-5.") from None
    if not rows or min(rows) < 1:
        raise ActivityError("Give the rows to select, starting at 1.")
    return rows


@activity(
    "sap.table_action",
    title="Work with SAP table",
    category=S,
    icon="table-properties",
    sentence="{action} in SAP table {table}",
    description="Select rows, click or double-click a cell, press a button of the table's toolbar, or type in a "
    "cell of a table control.",
    params=TableActionParams,
)
def table_action(ctx: RunContext, p: TableActionParams) -> None:
    control = _find(ctx, p.table)
    grid = _is_grid(control)
    session = _session(ctx)
    try:
        if p.action == "select_rows":
            rows = [r - 1 for r in _row_numbers(p.rows)]
            if grid:
                control.SelectedRows = ",".join(str(r) for r in rows)
            else:
                for r in rows:
                    control.GetAbsoluteRow(r).Selected = True
        elif p.action in ("double_click", "click_cell"):
            if not grid:
                cell = control.GetCell(p.row - 1, _column_index(p.column))
                cell.SetFocus()
                if p.action == "double_click":
                    session.findById("wnd[0]").sendVKey(2)
            else:
                control.SetCurrentCell(p.row - 1, to_text(p.column))
                if p.action == "double_click":
                    control.DoubleClickCurrentCell()
                else:
                    control.ClickCurrentCell()
        elif p.action == "toolbar":
            if not grid:
                raise ActivityError("Only SAP lists (ALV grids) have a toolbar. Use 'Press SAP button or key'.")
            control.PressToolbarButton(to_text(p.button))
        else:
            if grid:
                control.ModifyCell(p.row - 1, to_text(p.column), to_text(p.value))
            else:
                control.GetCell(p.row - 1, _column_index(p.column)).Text = to_text(p.value)
    except ActivityError:
        raise
    except Exception as exc:
        raise ActivityError(f"SAP did not do that in the table: {exc}",
                            "Check the row and column (they must be on this screen).") from None
    _check(ctx, session, stop_on_error=True)


def _column_index(column: str) -> int:
    try:
        return int(to_text(column).strip()) - 1
    except ValueError:
        raise ActivityError("For table controls, give the column's position (1, 2, ...).") from None


# -- trees -----------------------------------------------------------------------------------------


class TreeParams(Params):
    tree: str = Param(title="Tree id", ui="sap_id", placeholder="wnd[0]/shellcont/shell/shellcont[0]/shell")
    action: Literal["select", "expand", "double_click", "read"] = Param(
        "double_click", title="Do",
        labels={"select": "Select a node", "expand": "Open a node", "double_click": "Double-click a node",
                "read": "Read the node names"},
    )
    path: str = Param("", title="Node", placeholder="Favorites/Sales/VA01",
                      show_when={"action": ["select", "expand", "double_click"]},
                      description="The node's texts from the top, separated by /.")


@activity(
    "sap.tree",
    title="Work with SAP tree",
    category=S,
    icon="list-tree",
    sentence="{action} {path} in SAP tree",
    description="Select, open or double-click a node of an SAP tree (e.g. the SAP Easy Access menu), or read all "
    "node names.",
    params=TreeParams,
    outputs=[OutputDef("nodes", "Node names", "list")],
)
def tree(ctx: RunContext, p: TreeParams) -> list[str] | None:
    control = _find(ctx, p.tree)
    try:
        if p.action == "read":
            keys = control.GetAllNodeKeys()
            return [to_text(control.GetNodeTextByKey(keys.Item(i))) for i in range(int(keys.Count))]
        key = _node_key(control, p.path)
        if p.action == "select":
            control.SelectNode(key)
        elif p.action == "expand":
            control.ExpandNode(key)
        else:
            control.DoubleClickNode(key)
    except ActivityError:
        raise
    except Exception as exc:
        raise ActivityError(f"SAP did not do that in the tree: {exc}") from None
    _check(ctx, _session(ctx), stop_on_error=True)
    return None


def _node_key(control: Any, path: str) -> str:
    wanted = [part.strip().casefold() for part in to_text(path).split("/") if part.strip()]
    if not wanted:
        raise ActivityError("Give the node, e.g. Favorites/Sales/VA01.")
    keys = control.GetAllNodeKeys()
    texts = {to_text(keys.Item(i)): to_text(control.GetNodeTextByKey(keys.Item(i))) for i in range(int(keys.Count))}
    parent: str | None = None
    for depth, name in enumerate(wanted):
        candidates = [k for k, t in texts.items() if t.strip().casefold() == name
                      and (depth == 0 or to_text(control.GetParent(k)) == parent)]
        if not candidates:
            raise ActivityError(f"The SAP tree has no node '{'/'.join(wanted[: depth + 1])}'.")
        parent = candidates[0]
        if depth < len(wanted) - 1:
            control.ExpandNode(parent)
    assert parent is not None
    return parent


# -- waiting and scripts ---------------------------------------------------------------------------


class WaitParams(Params):
    until: Literal["idle", "field", "title"] = Param(
        "idle", title="Wait until",
        labels={"idle": "SAP is done", "field": "A field is there", "title": "The window title contains"},
    )
    field: str = Param("", title="Field id", ui="sap_id", show_when={"until": ["field"]})
    title: str = Param("", title="Title", placeholder="Create Sales Order", show_when={"until": ["title"]})
    timeout: float = Param(30, title="Wait at most (seconds)", ge=1, le=3600)


@activity(
    "sap.wait",
    title="Wait for SAP",
    category=S,
    icon="hourglass",
    sentence="Wait until SAP {until}",
    params=WaitParams,
)
def wait(ctx: RunContext, p: WaitParams) -> None:
    session = _session(ctx)
    deadline = Deadline(p.timeout)
    while True:
        if ctx.control.cancelled:
            raise RunCancelled()
        if not _busy(session):
            if p.until == "idle":
                return
            if p.until == "field":
                try:
                    session.findById(_full_id(p.field))
                    return
                except Exception:
                    pass
            elif to_text(p.title).casefold() in to_text(session.findById("wnd[0]").Text).casefold():
                return
        if deadline.passed:
            what = {"idle": "SAP to finish", "field": f"the field '{p.field}'", "title": f"a window titled '{p.title}'"}[p.until]
            raise ActivityError(f"Waited {int(p.timeout)} seconds for {what}.")
        time.sleep(0.3)


class ScriptParams(Params):
    script: str = Param(title="SAP GUI script (VBScript)", ui="code",
                        description="As recorded by SAP GUI's script recorder (.vbs).")
    timeout: float = Param(300, title="Stop after (seconds)", ge=1, le=7200, advanced=True)


@activity(
    "sap.run_script",
    title="Run SAP GUI script",
    category=S,
    icon="file-code",
    sentence="Run an SAP GUI script",
    description="Play back a script recorded with SAP GUI's script recorder. Only administrators can publish "
    "automations with this step.",
    params=ScriptParams,
    requires="scripts",
)
def run_script(ctx: RunContext, p: ScriptParams) -> None:
    if sys.platform != "win32":
        raise ActivityError("SAP GUI scripts run on Windows only.")
    path = Path(ctx.file_path(f"sap-script-{int(time.time() * 1000)}.vbs"))
    path.write_text(to_text(p.script), encoding="utf-16")
    try:
        done = subprocess.run(["cscript.exe", "//nologo", "//B", str(path)], capture_output=True, text=True,
                              timeout=p.timeout, creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise ActivityError(f"The SAP GUI script was still running after {int(p.timeout)} seconds and was stopped.") from None
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip()[-500:]
        raise ActivityError(f"The SAP GUI script failed{': ' + detail if detail else ''}.")
    session = ctx.resources.get(_KEY)
    if session is not None:
        _check(ctx, session, stop_on_error=True)
