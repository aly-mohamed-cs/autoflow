"""Excel workbooks (.xlsx/.xlsm) without needing Excel installed.

Each step opens the file, does its work and saves, so the workbook on disk is
always up to date even if a later step fails. Running macros or working with an
already-open workbook uses Excel itself and lives in a separate module.
"""

from __future__ import annotations

import datetime as dt
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from openpyxl import Workbook, load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.cell import coordinate_from_string, range_boundaries
from openpyxl.utils.exceptions import InvalidFileException

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import Secret, Table, to_text, type_name

X = "Excel"
_XLSX = ["xlsx", "xlsm"]


def _file(value: Any) -> Path:
    text = to_text(value).strip().strip('"')
    if not text:
        raise ActivityError("No Excel file was given.", "Choose an Excel file in the step settings.")
    path = Path(text).expanduser()
    if path.suffix.lower() == ".xls":
        raise ActivityError(
            "Old .xls files are not supported by this step.",
            "Save the file as .xlsx in Excel, or use 'Excel (application)' steps.",
        )
    return path


def _open(path: Path, *, read_only: bool = False, create: bool = False):
    if not path.exists():
        if create:
            wb = Workbook()
            return wb
        raise ActivityError(f"The Excel file '{path}' does not exist.", "Check the file path.")
    try:
        return load_workbook(path, read_only=read_only, data_only=read_only, keep_vba=path.suffix.lower() == ".xlsm")
    except InvalidFileException:
        raise ActivityError(f"'{path.name}' is not an Excel workbook.") from None
    except PermissionError:
        raise ActivityError(
            f"Cannot open '{path.name}'.", "The file may be open in Excel on this computer. Close it and try again."
        ) from None


@contextmanager
def _editing(path: Path, create: bool = True):
    wb = _open(path, create=create)
    try:
        yield wb
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            wb.save(path)
        except PermissionError:
            raise ActivityError(
                f"Cannot save '{path.name}'.",
                "The file is probably open in Excel. Close it (on the robot computer too) and try again.",
            ) from None
    finally:
        wb.close()


def _sheet(wb: Any, name: Any, *, create: bool = False) -> Any:
    wanted = to_text(name).strip()
    if not wanted:
        return wb.worksheets[0]
    for ws in wb.worksheets:
        if ws.title.casefold() == wanted.casefold():
            return ws
    if create:
        if len(wb.worksheets) == 1 and wb.worksheets[0].max_row == 1 and wb.worksheets[0]["A1"].value is None \
                and wb.worksheets[0].title == "Sheet":
            wb.worksheets[0].title = wanted
            return wb.worksheets[0]
        return wb.create_sheet(wanted)
    raise ActivityError(
        f"There is no sheet called '{wanted}'.", "Sheets in this workbook: " + ", ".join(ws.title for ws in wb.worksheets)
    )


def _cell_value(value: Any) -> Any:
    if isinstance(value, Secret):
        return "******"
    if value is None or isinstance(value, bool | int | float | dt.date | dt.datetime | dt.time):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, Table | list | dict):
        raise ActivityError(f"A {type_name(value)} value cannot be written into a single cell.")
    return to_text(value)


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


# ---------------------------------------------------------------------------


class ReadExcelParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    range: str = Param("", title="Cells", placeholder="(all used cells), e.g. A1:F200", advanced=True)
    has_header: bool = Param(True, title="First row has column names")


@activity(
    "excel.read",
    title="Read Excel sheet",
    category=X,
    icon="sheet",
    sentence="Read {sheet} from {file}",
    description="Read a sheet (or part of it) into a table you can loop over.",
    params=ReadExcelParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="excel_data")],
)
def read_excel(ctx: RunContext, p: ReadExcelParams) -> Table:
    path = _file(p.file)
    wb = _open(path, read_only=True)
    try:
        ws = _sheet(wb, p.sheet)
        if p.range.strip():
            try:
                min_col, min_row, max_col, max_row = range_boundaries(p.range.strip().upper())
            except ValueError:
                raise ActivityError(f"'{p.range}' is not a valid cell range.", "Use a range like A1:F200.") from None
            rows = ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col, values_only=True)
        else:
            rows = ws.iter_rows(values_only=True)
        matrix = [[_clean(v) for v in r] for r in rows]
    finally:
        wb.close()
    # Drop fully empty rows and trailing empty columns.
    matrix = [r for r in matrix if any(v not in (None, "") for v in r)]
    if matrix:
        width = max(max((i + 1 for i, v in enumerate(r) if v not in (None, "")), default=0) for r in matrix)
        matrix = [r[:width] for r in matrix]
    return Table.from_matrix(matrix, p.has_header)


class ReadCellParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    cell: str = Param(title="Cell", placeholder="B2")


@activity(
    "excel.read_cell",
    title="Read Excel cell",
    category=X,
    icon="square-mouse-pointer",
    sentence="Read cell {cell} from {file}",
    params=ReadCellParams,
    outputs=[OutputDef("value", "Value", "any", default_variable="cell_value")],
)
def read_cell(ctx: RunContext, p: ReadCellParams) -> Any:
    path = _file(p.file)
    wb = _open(path, read_only=True)
    try:
        ws = _sheet(wb, p.sheet)
        return _clean(ws[_coordinate(p.cell)].value)
    finally:
        wb.close()


def _coordinate(cell: str) -> str:
    text = to_text(cell).strip().upper()
    try:
        coordinate_from_string(text)
    except ValueError:
        raise ActivityError(f"'{cell}' is not a valid cell.", "Use a cell like A1 or C12.") from None
    return text


class WriteCellParams(Params):
    file: str = Param(title="Excel file", ui="save_file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    cell: str = Param(title="Cell", placeholder="B2")
    value: Any = Param(None, title="Value")


@activity(
    "excel.write_cell",
    title="Write Excel cell",
    category=X,
    icon="pencil-line",
    sentence="Write {value} into cell {cell} of {file}",
    description="Creates the file or sheet if it doesn't exist yet.",
    params=WriteCellParams,
)
def write_cell(ctx: RunContext, p: WriteCellParams) -> None:
    path = _file(p.file)
    with _editing(path) as wb:
        _sheet(wb, p.sheet, create=True)[_coordinate(p.cell)] = _cell_value(p.value)


class WriteTableParams(Params):
    table: Any = Param(title="Table", ui="variable")
    file: str = Param(title="Excel file", ui="save_file", file_types=_XLSX)
    sheet: str = Param("Sheet1", title="Sheet")
    mode: Literal["replace", "append", "at_cell"] = Param(
        "replace", title="How",
        description="replace = clear the sheet first; append = add below existing rows; at_cell = start at a cell",
    )
    start_cell: str = Param("A1", title="Start cell (for 'at_cell')", advanced=True)
    include_header: bool = Param(True, title="Write column names")


@activity(
    "excel.write_table",
    title="Write table to Excel",
    category=X,
    icon="sheet",
    sentence="Write {table} to {sheet} in {file}",
    description="Save a table into a sheet. Creates the file or sheet if needed.",
    params=WriteTableParams,
)
def write_table(ctx: RunContext, p: WriteTableParams) -> None:
    if not isinstance(p.table, Table):
        raise ActivityError(f"The value to write is a {type_name(p.table)}, not a table.")
    path = _file(p.file)
    with _editing(path) as wb:
        ws = _sheet(wb, p.sheet, create=True)
        if p.mode == "replace":
            ws.delete_rows(1, ws.max_row)
            start_row, start_col = 1, 1
            matrix = p.table.to_matrix(p.include_header)
        elif p.mode == "append":
            empty = ws.max_row == 1 and all(c.value is None for c in ws[1])
            start_row, start_col = (1 if empty else ws.max_row + 1), 1
            header = [c.value for c in ws[1]] if not empty else []
            if header and any(h is not None for h in header):
                # Match existing columns by name so appended rows line up.
                cols = [to_text(h).strip() for h in header]
                extra = [c for c in p.table.columns if c not in cols]
                for i, name in enumerate(extra):
                    ws.cell(row=1, column=len(cols) + i + 1, value=name)
                cols += extra
                matrix = [[row.get(c) for c in cols] for row in p.table.rows]
            else:
                matrix = p.table.to_matrix(p.include_header)
        else:
            col_letter, start_row = coordinate_from_string(_coordinate(p.start_cell))
            start_col = column_index_from_string(col_letter)
            matrix = p.table.to_matrix(p.include_header)
        for r, values in enumerate(matrix):
            for c, value in enumerate(values):
                ws.cell(row=start_row + r, column=start_col + c, value=_cell_value(value))


class AppendRowParams(Params):
    file: str = Param(title="Excel file", ui="save_file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    values: dict[str, Any] = Param(
        title="Values", ui="key_values", description="Column name -> value. New columns are added at the end."
    )


@activity(
    "excel.append_row",
    title="Add row to Excel",
    category=X,
    icon="list-plus",
    sentence="Add a row to {sheet} in {file}",
    params=AppendRowParams,
)
def append_row(ctx: RunContext, p: AppendRowParams) -> None:
    path = _file(p.file)
    with _editing(path) as wb:
        ws = _sheet(wb, p.sheet, create=True)
        header = [to_text(c.value).strip() for c in ws[1]] if ws.max_row >= 1 else []
        if not any(header):
            header = []
        for name in p.values:
            if name not in header:
                header.append(name)
                ws.cell(row=1, column=len(header), value=name)
        row = ws.max_row + 1 if any(c.value is not None for c in ws[1]) else 2
        for name, value in p.values.items():
            ws.cell(row=row, column=header.index(name) + 1, value=_cell_value(value))


class UpdateRowParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    row_number: int = Param(
        title="Row number", ge=1, description="1 = first row under the column names (use the loop's position counter)."
    )
    values: dict[str, Any] = Param(title="Values", ui="key_values", description="Column name -> new value")
    header_row: int = Param(1, title="Row with column names", ge=1, advanced=True)


@activity(
    "excel.update_row",
    title="Update Excel row",
    category=X,
    icon="file-pen-line",
    sentence="Update row {row_number} of {sheet} in {file}",
    description="Write results back into the row you are processing, e.g. a Status or Reference column.",
    params=UpdateRowParams,
)
def update_row(ctx: RunContext, p: UpdateRowParams) -> None:
    path = _file(p.file)
    with _editing(path, create=False) as wb:
        ws = _sheet(wb, p.sheet)
        header = [to_text(c.value).strip() for c in ws[p.header_row]]
        target_row = p.header_row + p.row_number
        for name, value in p.values.items():
            key = to_text(name).strip()
            match = next((i for i, h in enumerate(header) if h.casefold() == key.casefold()), None)
            if match is None:
                header.append(key)
                match = len(header) - 1
                ws.cell(row=p.header_row, column=match + 1, value=key)
            ws.cell(row=target_row, column=match + 1, value=_cell_value(value))


class ListSheetsParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)


@activity(
    "excel.list_sheets",
    title="Get sheet names",
    category=X,
    icon="layers",
    sentence="Get sheet names of {file}",
    params=ListSheetsParams,
    outputs=[OutputDef("sheets", "Sheet names", "list", default_variable="sheet_names")],
)
def list_sheets(ctx: RunContext, p: ListSheetsParams) -> list[str]:
    wb = _open(_file(p.file), read_only=True)
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


class CreateWorkbookParams(Params):
    file: str = Param(title="New Excel file", ui="save_file", file_types=["xlsx"])
    sheet: str = Param("Sheet1", title="First sheet name")
    columns: list[str] = Param(default_factory=list, title="Column names (optional)", ui="list")
    overwrite: bool = Param(False, title="Replace if it exists")


@activity(
    "excel.create",
    title="Create Excel file",
    category=X,
    icon="file-plus-2",
    sentence="Create Excel file {file}",
    params=CreateWorkbookParams,
    outputs=[OutputDef("file", "File", "file", default_variable="excel_file")],
)
def create_workbook(ctx: RunContext, p: CreateWorkbookParams) -> str:
    path = _file(p.file)
    if path.exists() and not p.overwrite:
        raise ActivityError(f"'{path}' already exists.", "Turn on 'Replace if it exists' or choose another name.")
    wb = Workbook()
    ws = wb.active
    ws.title = p.sheet or "Sheet1"
    for i, name in enumerate(p.columns, start=1):
        ws.cell(row=1, column=i, value=name)
        ws.column_dimensions[get_column_letter(i)].width = max(10, len(name) + 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return str(path)
