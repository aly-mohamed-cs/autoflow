"""More Excel steps, still without needing Excel (Brity's Excel library): sheets, formatting,
rows and columns, formulas, find and replace, filter buttons, copying cells, splitting."""

from __future__ import annotations

import re
from contextlib import contextmanager
from copy import copy
from pathlib import Path
from typing import Any, Literal

from openpyxl import Workbook
from openpyxl.cell.cell import MergedCell
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.cell import coordinate_from_string, range_boundaries

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import to_text
from .excel import _XLSX, ReadCellParams, X, _coordinate, _editing, _file, _open, _sheet

# -- sheets (Brity Create / Copy / Delete WorkSheet) ------------------------------------------------------


class SheetParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param(title="Sheet", placeholder="Invoices")


def _sheet_name(value: Any) -> str:
    name = to_text(value).strip()
    if not name or len(name) > 31 or any(c in name for c in "[]:*?/\\"):
        raise ActivityError(f"'{name}' can't be a sheet name.", "Up to 31 characters, without [ ] : * ? / \\.")
    return name


class AddSheetParams(SheetParams):
    position: int = Param(0, title="Position", ge=0, le=1000, advanced=True, description="1 = first. 0 = last.")


@activity(
    "excel.add_sheet",
    title="Add sheet",
    category=X,
    icon="file-plus",
    sentence="Add sheet {sheet} to {file}",
    description="Add a new, empty sheet. Nothing happens when a sheet with that name exists.",
    params=AddSheetParams,
)
def add_sheet(ctx: RunContext, p: AddSheetParams) -> None:
    name = _sheet_name(p.sheet)
    with _editing(_file(p.file)) as wb:
        if any(ws.title.casefold() == name.casefold() for ws in wb.worksheets):
            return
        wb.create_sheet(name, p.position - 1 if p.position else None)


class RenameSheetParams(SheetParams):
    new_name: str = Param(title="New name", placeholder="Invoices 2026")


@activity(
    "excel.rename_sheet",
    title="Rename sheet",
    category=X,
    icon="pencil",
    sentence="Rename sheet {sheet} to {new_name}",
    params=RenameSheetParams,
)
def rename_sheet(ctx: RunContext, p: RenameSheetParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        _sheet(wb, p.sheet).title = _sheet_name(p.new_name)


class CopySheetParams(SheetParams):
    new_name: str = Param(title="Name of the copy", placeholder="Invoices (copy)")


@activity(
    "excel.copy_sheet",
    title="Copy sheet",
    category=X,
    icon="copy",
    sentence="Copy sheet {sheet} as {new_name}",
    description="Make a copy of a sheet in the same workbook (values, formulas and formatting).",
    params=CopySheetParams,
)
def copy_sheet(ctx: RunContext, p: CopySheetParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        wb.copy_worksheet(_sheet(wb, p.sheet)).title = _sheet_name(p.new_name)


@activity(
    "excel.delete_sheet",
    title="Delete sheet",
    category=X,
    icon="trash",
    sentence="Delete sheet {sheet} of {file}",
    params=SheetParams,
)
def delete_sheet(ctx: RunContext, p: SheetParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        if len(wb.worksheets) == 1:
            raise ActivityError("A workbook needs at least one sheet.", "Add another sheet first.")
        wb.remove(ws)


# -- cells: clear, format, merge (Brity ClearRange / SetStyleRange / SetBorderRange / MergeRange) ---------


class RangeParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    range: str = Param(title="Cells", placeholder="A1:D20")


def _bounds(ws: Any, ref: Any) -> tuple[int, int, int, int]:
    text = to_text(ref).strip().upper()
    try:
        min_col, min_row, max_col, max_row = range_boundaries(text)
    except (ValueError, TypeError):
        raise ActivityError(f"'{ref}' is not a range of cells.",
                            "Use cells like A1:D20, a column like B:B or a cell like C3.") from None
    return min_col or 1, min_row or 1, max_col or ws.max_column, max_row or ws.max_row


def _cells(ws: Any, ref: Any) -> list[Any]:
    min_col, min_row, max_col, max_row = _bounds(ws, ref)
    return [cell for row in ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col)
            for cell in row]


class ClearParams(RangeParams):
    what: Literal["contents", "formats", "all"] = Param(
        "contents", title="Clear", labels={"contents": "Values only", "formats": "Formatting only", "all": "Everything"},
    )


@activity(
    "excel.clear_cells",
    title="Clear cells",
    category=X,
    icon="eraser",
    sentence="Clear {range} in {file}",
    params=ClearParams,
)
def clear_cells(ctx: RunContext, p: ClearParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        for cell in _cells(_sheet(wb, p.sheet), p.range):
            if isinstance(cell, MergedCell):
                continue
            if p.what in ("contents", "all"):
                cell.value = None
            if p.what in ("formats", "all"):
                cell.style = "Normal"


_COLORS = {
    "black": "000000", "white": "FFFFFF", "red": "FF0000", "green": "00B050", "blue": "0070C0",
    "yellow": "FFFF00", "orange": "FFC000", "gray": "808080", "grey": "808080", "purple": "7030A0",
    "lightgreen": "C6EFCE", "lightred": "FFC7CE", "lightyellow": "FFEB9C", "lightblue": "DDEBF7",
    "lightgray": "D9D9D9", "lightgrey": "D9D9D9",
}


def _color(value: Any) -> str | None:
    text = to_text(value).strip().lower().replace(" ", "").lstrip("#")
    if not text:
        return None
    if text in _COLORS:
        return "FF" + _COLORS[text]
    if len(text) == 6 and all(c in "0123456789abcdef" for c in text):
        return "FF" + text.upper()
    raise ActivityError(f"'{value}' is not a colour.", "Use a name (red, lightgreen...) or a code like #FFC000.")


class FormatParams(RangeParams):
    bold: Literal["", "yes", "no"] = Param("", title="Bold", labels={"": "Leave as is", "yes": "Bold", "no": "Not bold"})
    italic: Literal["", "yes", "no"] = Param(
        "", title="Italic", advanced=True, labels={"": "Leave as is", "yes": "Italic", "no": "Not italic"},
    )
    font_color: str = Param("", title="Text colour", placeholder="red, #C00000", advanced=True)
    fill_color: str = Param("", title="Fill colour", placeholder="lightyellow, #FFEB9C")
    number_format: str = Param(
        "", title="Number format", placeholder="#,##0.00   or   dd/mm/yyyy",
        description="As in Excel's Format Cells > Custom.",
    )
    border: Literal["", "none", "thin", "thick"] = Param(
        "", title="Borders", labels={"": "Leave as is", "none": "No borders", "thin": "Thin", "thick": "Thick"},
    )
    align: Literal["", "left", "center", "right"] = Param(
        "", title="Align", advanced=True, labels={"": "Leave as is", "left": "Left", "center": "Centre", "right": "Right"},
    )
    wrap: bool = Param(False, title="Wrap text", advanced=True)
    column_width: str = Param("", title="Column width", placeholder="20, or auto", advanced=True,
                              description="A number of characters, or 'auto' to fit the contents.")


@activity(
    "excel.format_cells",
    title="Format cells",
    category=X,
    icon="paintbrush",
    sentence="Format {range} in {file}",
    description="Bold, colours, number format, borders, alignment and column width of a range of cells.",
    params=FormatParams,
)
def format_cells(ctx: RunContext, p: FormatParams) -> None:
    from openpyxl.styles import Border, PatternFill, Side

    font_color, fill_color = _color(p.font_color), _color(p.fill_color)
    side = {"none": Side(), "thin": Side(style="thin"), "thick": Side(style="thick")}.get(p.border)
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        cells = _cells(ws, p.range)
        for cell in cells:
            if p.bold or p.italic or font_color:
                font = copy(cell.font)
                if p.bold:
                    font.b = p.bold == "yes"
                if p.italic:
                    font.i = p.italic == "yes"
                if font_color:
                    font.color = font_color
                cell.font = font
            if fill_color:
                cell.fill = PatternFill("solid", start_color=fill_color, end_color=fill_color)
            if p.number_format:
                cell.number_format = to_text(p.number_format)
            if side is not None:
                cell.border = Border(left=side, right=side, top=side, bottom=side)
            if p.align or p.wrap:
                alignment = copy(cell.alignment)
                if p.align:
                    alignment.horizontal = p.align
                if p.wrap:
                    alignment.wrap_text = True
                cell.alignment = alignment
        width = to_text(p.column_width).strip().lower()
        for letter in sorted({c.column_letter for c in cells}) if width else []:
            if width == "auto":
                longest = max((len(to_text(c.value)) for c in ws[letter] if c.value is not None), default=8)
                ws.column_dimensions[letter].width = min(max(longest + 2, 8), 80)
            else:
                try:
                    ws.column_dimensions[letter].width = float(width)
                except ValueError:
                    raise ActivityError(f"'{p.column_width}' is not a column width.", "Use a number, or auto.") from None


class MergeParams(RangeParams):
    action: Literal["merge", "unmerge"] = Param("merge", title="Do", labels={"merge": "Merge", "unmerge": "Unmerge"})


@activity(
    "excel.merge_cells",
    title="Merge cells",
    category=X,
    icon="table-cells-merge",
    sentence="{action} cells {range} in {file}",
    description="Merge a range into one cell (the top-left value stays), or split merged cells again.",
    params=MergeParams,
)
def merge_cells(ctx: RunContext, p: MergeParams) -> None:
    ref = to_text(p.range).strip().upper()
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        if p.action == "merge":
            ws.merge_cells(ref)
            return
        min_col, min_row, max_col, max_row = _bounds(ws, ref)
        for merged in list(ws.merged_cells.ranges):
            if not (merged.max_col < min_col or merged.min_col > max_col
                    or merged.max_row < min_row or merged.min_row > max_row):
                ws.unmerge_cells(str(merged))


# -- rows and columns (Brity AddRow / AddCol / DeleteRow / DeleteCol / SetHiddenRow / SetHiddenCol) -------


def _line(what: str, value: Any) -> int:
    """A row number, or a column letter / number, as a number."""
    text = to_text(value).strip().upper()
    if what == "rows" or text.isdigit():
        try:
            number = int(float(text))
        except ValueError:
            raise ActivityError(f"'{value}' is not a row number.") from None
        if number < 1:
            raise ActivityError("Rows and columns start at 1.")
        return number
    try:
        return column_index_from_string(text)
    except ValueError:
        raise ActivityError(f"'{value}' is not a column.", "Use a letter like C, or a number.") from None


class LinesParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    what: Literal["rows", "columns"] = Param("rows", title="What", labels={"rows": "Rows", "columns": "Columns"})
    at: str = Param(title="At", placeholder="5   or   C", description="Row number, or column letter.")
    count: int = Param(1, title="How many", ge=1, le=100_000)


def _move_merged(ws: Any, rows: bool, at: int, count: int) -> None:
    """Keep merged areas with the cells that moved (openpyxl leaves them where they were).

    count > 0: lines were inserted at `at`; count < 0: -count lines were deleted from `at`."""
    for merged in list(ws.merged_cells.ranges):
        first, last = (merged.min_row, merged.max_row) if rows else (merged.min_col, merged.max_col)
        if count > 0:
            if first >= at:
                first, last = first + count, last + count
            elif last >= at:
                last += count  # the new lines are inside the merged area
        else:
            gone = range(at, at - count)
            if first in gone and last in gone:
                ws.merged_cells.remove(merged)
                continue
            first = first if first < at else max(at, first + count)
            last = last if last < at else max(at - 1, last + count)
        ws.merged_cells.remove(merged)
        if (rows and first == last and merged.min_col == merged.max_col) or (
            not rows and first == last and merged.min_row == merged.max_row
        ):
            continue  # shrank to a single cell
        if rows:
            ws.merged_cells.add(f"{get_column_letter(merged.min_col)}{first}:{get_column_letter(merged.max_col)}{last}")
        else:
            ws.merged_cells.add(f"{get_column_letter(first)}{merged.min_row}:{get_column_letter(last)}{merged.max_row}")


@activity(
    "excel.insert_lines",
    title="Insert rows or columns",
    category=X,
    icon="between-horizontal-start",
    sentence="Insert {count} {what} at {at} in {file}",
    description="Insert empty rows or columns; the ones after them move down / right.",
    params=LinesParams,
)
def insert_lines(ctx: RunContext, p: LinesParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        at = _line(p.what, p.at)
        if p.what == "rows":
            ws.insert_rows(at, p.count)
        else:
            ws.insert_cols(at, p.count)
        _move_merged(ws, p.what == "rows", at, p.count)


@activity(
    "excel.delete_lines",
    title="Delete rows or columns",
    category=X,
    icon="between-horizontal-end",
    sentence="Delete {count} {what} at {at} in {file}",
    description="Delete rows or columns; the ones after them move up / left.",
    params=LinesParams,
)
def delete_lines(ctx: RunContext, p: LinesParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        at = _line(p.what, p.at)
        _move_merged(ws, p.what == "rows", at, -p.count)
        if p.what == "rows":
            ws.delete_rows(at, p.count)
        else:
            ws.delete_cols(at, p.count)


class HideParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    what: Literal["rows", "columns"] = Param("rows", title="What", labels={"rows": "Rows", "columns": "Columns"})
    which: str = Param(title="Which", placeholder="2:5   or   B:D   or   C")
    hide: bool = Param(True, title="Hide them", description="Untick to show hidden ones again.")


@activity(
    "excel.hide_lines",
    title="Hide rows or columns",
    category=X,
    icon="eye-off",
    sentence="Hide {what} {which} in {file}",
    params=HideParams,
)
def hide_lines(ctx: RunContext, p: HideParams) -> None:
    first, _, last = to_text(p.which).strip().upper().partition(":")
    start, end = _line(p.what, first), _line(p.what, last or first)
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        for n in range(min(start, end), max(start, end) + 1):
            dims = ws.row_dimensions[n] if p.what == "rows" else ws.column_dimensions[get_column_letter(n)]
            dims.hidden = p.hide


# -- formulas, find and replace, filters, copying, splitting ----------------------------------------------


@activity(
    "excel.read_formula",
    title="Read cell formula",
    category=X,
    icon="sigma",
    sentence="Read the formula in {cell} of {file}",
    description="The formula in a cell (e.g. =SUM(B2:B9)), or its value when it has none.",
    params=ReadCellParams,
    outputs=[OutputDef("formula", "Formula", "text", default_variable="formula")],
)
def read_formula(ctx: RunContext, p: ReadCellParams) -> str:
    wb = _open(_file(p.file))
    try:
        return to_text(_sheet(wb, p.sheet)[_coordinate(p.cell)].value)
    finally:
        wb.close()


class FindReplaceParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(all sheets)")
    find: str = Param(title="Find", placeholder="2025")
    replace: str = Param("", title="Replace with", placeholder="2026")
    match_case: bool = Param(False, title="Match upper / lower case", advanced=True)
    whole_cell: bool = Param(False, title="Only whole cells", advanced=True)


@activity(
    "excel.find_replace",
    title="Find and replace in Excel",
    category=X,
    icon="replace",
    sentence="Replace {find} with {replace} in {file}",
    description="Replace text in the cells of a sheet (or all sheets). Formulas are left alone.",
    params=FindReplaceParams,
    outputs=[OutputDef("count", "Cells changed", "number", default_variable="replaced")],
)
def find_replace(ctx: RunContext, p: FindReplaceParams) -> int:
    needle = to_text(p.find)
    if not needle:
        raise ActivityError("There is nothing to find.", "Enter the text to look for.")
    flags = 0 if p.match_case else re.IGNORECASE
    pattern = re.compile(("^" + re.escape(needle) + "$") if p.whole_cell else re.escape(needle), flags)
    replacement = to_text(p.replace)
    changed = 0
    with _editing(_file(p.file), create=False) as wb:
        sheets = [_sheet(wb, p.sheet)] if to_text(p.sheet).strip() else wb.worksheets
        for ws in sheets:
            for row in ws.iter_rows():
                for cell in row:
                    value = cell.value
                    if isinstance(value, str) and not value.startswith("=") and pattern.search(value):
                        cell.value = pattern.sub(lambda _m: replacement, value)
                        changed += 1
    return changed


class FilterParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    range: str = Param("", title="Cells", placeholder="(all used cells)")
    on: bool = Param(True, title="Show the filter buttons", description="Untick to remove them.")


@activity(
    "excel.filter_buttons",
    title="Add filter buttons",
    category=X,
    icon="list-filter",
    sentence="Add filter buttons to {sheet} of {file}",
    description="Put Excel's filter buttons on the header row (to filter the data itself, use 'Filter rows').",
    params=FilterParams,
)
def filter_buttons(ctx: RunContext, p: FilterParams) -> None:
    with _editing(_file(p.file), create=False) as wb:
        ws = _sheet(wb, p.sheet)
        ws.auto_filter.ref = (to_text(p.range).strip().upper() or ws.dimensions) if p.on else None


class CopyRangeParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    range: str = Param(title="Cells", placeholder="A1:D20")
    to_file: str = Param("", title="Copy to file", ui="save_file", file_types=_XLSX, placeholder="(the same file)")
    to_sheet: str = Param("", title="Copy to sheet", placeholder="(the same sheet)")
    to_cell: str = Param(title="Top-left cell to copy to", placeholder="F1")


@contextmanager
def _same(wb: Any):
    yield wb


@activity(
    "excel.copy_cells",
    title="Copy cells",
    category=X,
    icon="clipboard-copy",
    sentence="Copy {range} to {to_cell}",
    description="Copy values, formulas (adjusted to their new place) and formatting to another place, sheet or file.",
    params=CopyRangeParams,
)
def copy_cells(ctx: RunContext, p: CopyRangeParams) -> None:
    from openpyxl.formula.translate import Translator

    source = _file(p.file)
    target = _file(p.to_file) if to_text(p.to_file).strip() else source
    same_file = target.resolve() == source.resolve()
    with _editing(source, create=False) as src_wb:
        src = _sheet(src_wb, p.sheet)
        min_col, min_row, max_col, max_row = _bounds(src, p.range)
        to_col, to_row = coordinate_from_string(_coordinate(p.to_cell))
        dc, dr = column_index_from_string(to_col) - min_col, to_row - min_row
        cells = [(c.row, c.column, c.value, c.coordinate, c)
                 for row in src.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col)
                 for c in row]
        with (_same(src_wb) if same_file else _editing(target)) as wb:
            dest = _sheet(wb, p.to_sheet or (src.title if same_file else ""), create=True)
            for row, col, value, coordinate, original in cells:
                cell = dest.cell(row=row + dr, column=col + dc)
                if isinstance(value, str) and value.startswith("="):
                    value = Translator(value, origin=coordinate).translate_formula(cell.coordinate)
                cell.value = value
                if original.has_style:
                    cell.font, cell.fill, cell.border = copy(original.font), copy(original.fill), copy(original.border)
                    cell.number_format, cell.alignment = original.number_format, copy(original.alignment)


class SplitParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=_XLSX)
    sheet: str = Param("", title="Sheet", placeholder="(first sheet)")
    column: str = Param(title="Split by column", placeholder="Region")
    folder: str = Param(title="Save the files in", ui="folder")


@activity(
    "excel.split",
    title="Split sheet into files",
    category=X,
    icon="split",
    sentence="Split {file} by {column}",
    description="One workbook per value of a column (e.g. one file per region), each with the header row.",
    params=SplitParams,
    outputs=[OutputDef("files", "Files", "list", default_variable="split_files")],
)
def split(ctx: RunContext, p: SplitParams) -> list[str]:
    wb = _open(_file(p.file), read_only=True)
    try:
        rows = [list(r) for r in _sheet(wb, p.sheet).iter_rows(values_only=True)]
    finally:
        wb.close()
    if not rows:
        return []
    header = [to_text(h) for h in rows[0]]
    wanted = to_text(p.column).strip().casefold()
    index = next((i for i, h in enumerate(header) if h.strip().casefold() == wanted), None)
    if index is None:
        raise ActivityError(f"There is no column '{p.column}'.", "Columns: " + ", ".join(h for h in header if h))
    groups: dict[str, list[list[Any]]] = {}
    for row in rows[1:]:
        if any(v is not None for v in row):
            groups.setdefault(to_text(row[index]) if index < len(row) else "", []).append(row)
    folder = Path(to_text(p.folder)).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    stem = _file(p.file).stem
    files = []
    for value, group in groups.items():
        out = Workbook()
        ws = out.active
        ws.title = (re.sub(r"[\[\]:*?/\\]", "_", value) or "Empty")[:31]
        ws.append(rows[0])
        for row in group:
            ws.append(row)
        safe = re.sub(r'[<>:"/\\|?*]', "_", value) or "empty"
        path = folder / f"{stem} - {safe}.xlsx"
        out.save(path)
        files.append(str(path))
    return files
