"""Tables: filter, sort, look up, merge, group - Excel-style operations without Excel."""

from __future__ import annotations

from collections import ChainMap
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.conditions import Condition, evaluate_condition
from ..runtime.context import RunContext
from ..runtime.expressions import coerce_pair, is_empty, to_number
from ..runtime.templates import resolve
from ..values import Table, to_text, type_name

D = "Data"
_TABLE_OUT = [OutputDef("table", "Result table", "table", default_variable="result_table")]


def _table(value: Any, what: str = "table") -> Table:
    if isinstance(value, Table):
        return value
    if isinstance(value, list) and all(isinstance(r, dict) for r in value):
        return Table(rows=value)
    raise ActivityError(
        f"The {what} is a {type_name(value)} value, not a table.",
        "Pick a table variable, for example one read from Excel or CSV.",
    )


def _column(table: Table, name: Any) -> str:
    wanted = to_text(name).strip()
    if wanted in table.columns:
        return wanted
    for col in table.columns:
        if col.strip().casefold() == wanted.casefold():
            return col
    raise ActivityError(
        f"The table has no column called '{wanted}'.",
        "Available columns: " + ", ".join(table.columns) if table.columns else "The table has no columns.",
    )


def _row_scope(ctx: RunContext, row: dict[str, Any]) -> ChainMap:
    return ChainMap({"row": row}, ctx.variables)


class CreateTableParams(Params):
    columns: list[str] = Param(title="Column names", ui="list")


@activity(
    "data.create_table",
    title="Create table",
    category=D,
    icon="table-2",
    sentence="Create table with columns {columns}",
    description="Start an empty table, e.g. to collect results row by row.",
    params=CreateTableParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="results")],
)
def create_table(ctx: RunContext, p: CreateTableParams) -> Table:
    return Table([to_text(c).strip() for c in p.columns if to_text(c).strip()])


class AddRowParams(Params):
    table: str = Param(title="Table variable", ui="variable_name")
    values: dict[str, Any] = Param(title="Values", ui="key_values", description="Column name -> value")


@activity(
    "data.add_row",
    title="Add row to table",
    category=D,
    icon="between-horizontal-end",
    sentence="Add row to {table}",
    params=AddRowParams,
)
def add_row(ctx: RunContext, p: AddRowParams) -> None:
    current = ctx.get(p.table)
    table = Table() if current in (None, "") else _table(current)
    table.append(dict(p.values))
    ctx.set(p.table, table)


class FilterParams(Params):
    table: Any = Param(title="Table", ui="variable")
    condition: Condition = Param(title="Keep rows where", description="Use row[\"Column\"] to refer to a column.")


@activity(
    "data.filter",
    title="Filter rows",
    category=D,
    icon="funnel",
    sentence="Keep rows of {table} where {condition}",
    params=FilterParams,
    outputs=_TABLE_OUT,
)
def filter_rows(ctx: RunContext, p: FilterParams) -> Table:
    table = _table(p.table)
    kept = [r for r in table.rows if evaluate_condition(p.condition, _row_scope(ctx, r))]
    return Table(table.columns, [dict(r) for r in kept])


class SortParams(Params):
    table: Any = Param(title="Table", ui="variable")
    column: str = Param(title="Sort by column", ui="column", source="table")
    descending: bool = Param(False, title="Largest / latest first")


@activity(
    "data.sort",
    title="Sort table",
    category=D,
    icon="arrow-down-wide-narrow",
    sentence="Sort {table} by {column}",
    params=SortParams,
    outputs=_TABLE_OUT,
)
def sort_table(ctx: RunContext, p: SortParams) -> Table:
    table = _table(p.table)
    col = _column(table, p.column)
    filled = [r for r in table.rows if not is_empty(r.get(col))]
    empty = [r for r in table.rows if is_empty(r.get(col))]
    numeric = all(_is_num(r.get(col)) for r in filled)

    def key(row: dict[str, Any]) -> Any:
        value = row.get(col)
        return to_number(value) if numeric else coerce_pair(value, value)[0]

    try:
        filled.sort(key=key, reverse=p.descending)
    except TypeError:
        filled.sort(key=lambda r: to_text(r.get(col)).casefold(), reverse=p.descending)
    return Table(table.columns, [dict(r) for r in filled + empty])


def _is_num(value: Any) -> bool:
    try:
        to_number(value)
        return not isinstance(value, bool)
    except Exception:
        return False


class SelectColumnsParams(Params):
    table: Any = Param(title="Table", ui="variable")
    columns: list[str] = Param(title="Columns to keep (in this order)", ui="list")


@activity(
    "data.select_columns",
    title="Keep columns",
    category=D,
    icon="columns-3",
    sentence="Keep columns {columns} of {table}",
    params=SelectColumnsParams,
    outputs=_TABLE_OUT,
)
def select_columns(ctx: RunContext, p: SelectColumnsParams) -> Table:
    table = _table(p.table)
    cols = [_column(table, c) for c in p.columns]
    return Table(cols, [{c: r.get(c) for c in cols} for r in table.rows])


class RenameColumnParams(Params):
    table: Any = Param(title="Table", ui="variable")
    column: str = Param(title="Column", ui="column", source="table")
    new_name: str = Param(title="New name")


@activity(
    "data.rename_column",
    title="Rename column",
    category=D,
    icon="text-cursor-input",
    sentence="Rename column {column} to {new_name}",
    params=RenameColumnParams,
    outputs=_TABLE_OUT,
)
def rename_column(ctx: RunContext, p: RenameColumnParams) -> Table:
    table = _table(p.table)
    old = _column(table, p.column)
    new = to_text(p.new_name).strip()
    if not new:
        raise ActivityError("The new column name is empty.")
    cols = [new if c == old else c for c in table.columns]
    rows = [{(new if k == old else k): v for k, v in r.items()} for r in table.rows]
    return Table(cols, rows)


class AddColumnParams(Params):
    table: Any = Param(title="Table", ui="variable")
    column: str = Param(title="New column name")
    value: Any = Param(
        "", title="Value for each row", lazy=True,
        description='Calculated for every row. Example: {{row["Price"] * row["Qty"]}}',
    )


@activity(
    "data.add_column",
    title="Add calculated column",
    category=D,
    icon="between-vertical-end",
    sentence="Add column {column} to {table}",
    params=AddColumnParams,
    outputs=_TABLE_OUT,
)
def add_column(ctx: RunContext, p: AddColumnParams) -> Table:
    table = _table(p.table).copy()
    name = to_text(resolve(p.column, ctx.variables)).strip()
    if not name:
        raise ActivityError("The new column name is empty.")
    if name not in table.columns:
        table.columns.append(name)
    for row in table.rows:
        row[name] = resolve(p.value, _row_scope(ctx, row))
    return table


class RemoveDuplicatesParams(Params):
    table: Any = Param(title="Table", ui="variable")
    columns: list[str] = Param(
        default_factory=list, title="Compare columns", ui="list",
        description="Rows count as duplicates when these columns match. Empty = all columns.",
    )


@activity(
    "data.remove_duplicates",
    title="Remove duplicate rows",
    category=D,
    icon="copy-minus",
    sentence="Remove duplicate rows from {table}",
    params=RemoveDuplicatesParams,
    outputs=_TABLE_OUT,
)
def remove_duplicates(ctx: RunContext, p: RemoveDuplicatesParams) -> Table:
    table = _table(p.table)
    cols = [_column(table, c) for c in p.columns] or table.columns
    seen: set[tuple[str, ...]] = set()
    rows = []
    for row in table.rows:
        key = tuple(to_text(row.get(c)).strip().casefold() for c in cols)
        if key not in seen:
            seen.add(key)
            rows.append(dict(row))
    return Table(table.columns, rows)


class MergeParams(Params):
    left: Any = Param(title="Main table", ui="variable")
    right: Any = Param(title="Table to bring data from", ui="variable")
    left_column: str = Param(title="Match column in main table", ui="column", source="left")
    right_column: str = Param(title="Match column in other table", ui="column", source="right")
    keep: Literal["all", "matching"] = Param(
        "all", title="Keep", description="all = every row of the main table; matching = only rows found in both",
    )


@activity(
    "data.merge",
    title="Merge tables (lookup)",
    category=D,
    icon="merge",
    sentence="Merge {right} into {left} on {left_column}",
    description="Like VLOOKUP for a whole table: add the other table's columns to matching rows.",
    params=MergeParams,
    outputs=_TABLE_OUT,
)
def merge(ctx: RunContext, p: MergeParams) -> Table:
    left, right = _table(p.left, "main table"), _table(p.right, "other table")
    lcol, rcol = _column(left, p.left_column), _column(right, p.right_column)
    index: dict[str, dict[str, Any]] = {}
    for row in right.rows:
        index.setdefault(to_text(row.get(rcol)).strip().casefold(), row)
    extra = [c for c in right.columns if c != rcol]
    renamed = {c: (c if c not in left.columns else f"{c}_2") for c in extra}
    result = Table([*left.columns, *renamed.values()])
    for row in left.rows:
        match = index.get(to_text(row.get(lcol)).strip().casefold())
        if match is None and p.keep == "matching":
            continue
        merged = dict(row)
        for c in extra:
            merged[renamed[c]] = match.get(c) if match else None
        result.append(merged)
    return result


class AppendTablesParams(Params):
    first: Any = Param(title="First table", ui="variable")
    second: Any = Param(title="Second table", ui="variable")


@activity(
    "data.append_tables",
    title="Combine tables (stack)",
    category=D,
    icon="rows-3",
    sentence="Stack {second} under {first}",
    description="Put the rows of two tables one under the other, e.g. reports from several files.",
    params=AppendTablesParams,
    outputs=_TABLE_OUT,
)
def append_tables(ctx: RunContext, p: AppendTablesParams) -> Table:
    first = Table() if p.first in (None, "") else _table(p.first, "first table")
    combined = first.copy()
    for row in _table(p.second, "second table").rows:
        combined.append(dict(row))
    return combined


class Aggregation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str = ""
    function: Literal["count", "sum", "average", "min", "max", "first", "join"] = "sum"
    result_column: str = ""


class GroupParams(Params):
    table: Any = Param(title="Table", ui="variable")
    group_by: list[str] = Param(title="Group by columns", ui="list")
    calculations: list[Aggregation] = Param(title="Calculations")


@activity(
    "data.group",
    title="Group and summarize",
    category=D,
    icon="sigma",
    sentence="Group {table} by {group_by}",
    description="Like a pivot table: totals, counts or averages per group.",
    params=GroupParams,
    outputs=_TABLE_OUT,
)
def group(ctx: RunContext, p: GroupParams) -> Table:
    table = _table(p.table)
    keys = [_column(table, c) for c in p.group_by]
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    labels: dict[tuple[str, ...], dict[str, Any]] = {}
    for row in table.rows:
        k = tuple(to_text(row.get(c)).strip().casefold() for c in keys)
        groups.setdefault(k, []).append(row)
        labels.setdefault(k, {c: row.get(c) for c in keys})
    calcs = []
    for calc in p.calculations:
        col = _column(table, calc.column) if calc.function != "count" or calc.column else None
        name = calc.result_column.strip() or (f"{calc.function} of {col}" if col else "count")
        calcs.append((calc.function, col, name))
    result = Table([*keys, *[name for _f, _c, name in calcs]])
    for k, rows in groups.items():
        out = dict(labels[k])
        for func, col, name in calcs:
            values = [r.get(col) for r in rows] if col else rows
            out[name] = _aggregate(func, values)
        result.append(out)
    return result


def _aggregate(func: str, values: list[Any]) -> Any:
    if func == "count":
        return len(values)
    if func == "first":
        return values[0] if values else None
    if func == "join":
        return ", ".join(to_text(v) for v in values if not is_empty(v))
    nums = [to_number(v) for v in values if not is_empty(v)]
    if not nums:
        return 0 if func == "sum" else None
    if func == "sum":
        total = sum(nums)
        return round(total, 10) if isinstance(total, float) else total
    if func == "average":
        return sum(nums) / len(nums)
    return min(nums) if func == "min" else max(nums)


class LookupParams(Params):
    table: Any = Param(title="Table", ui="variable")
    column: str = Param(title="Find in column", ui="column", source="table")
    value: Any = Param(title="Value to find")
    return_column: str = Param(title="Return value of column", ui="column", source="table")


@activity(
    "data.lookup",
    title="Look up value",
    category=D,
    icon="search",
    sentence="Look up {value} in {column} and return {return_column}",
    description="Like VLOOKUP: find a row by one column and return another column. Empty if not found.",
    params=LookupParams,
    outputs=[OutputDef("value", "Found value", "any", default_variable="found_value")],
)
def lookup(ctx: RunContext, p: LookupParams) -> Any:
    table = _table(p.table)
    col, ret = _column(table, p.column), _column(table, p.return_column)
    wanted = to_text(p.value).strip().casefold()
    for row in table.rows:
        if to_text(row.get(col)).strip().casefold() == wanted:
            return row.get(ret)
    return None


class GetCellParams(Params):
    table: Any = Param(title="Table", ui="variable")
    row_number: int = Param(1, title="Row number", ge=1, description="1 = first data row")
    column: str = Param(title="Column", ui="column", source="table")


@activity(
    "data.get_cell",
    title="Get cell from table",
    category=D,
    icon="grid-2x2",
    sentence="Get {column} of row {row_number} in {table}",
    params=GetCellParams,
    outputs=[OutputDef("value", "Value", "any", default_variable="cell_value")],
)
def get_cell(ctx: RunContext, p: GetCellParams) -> Any:
    table = _table(p.table)
    if p.row_number > len(table):
        raise ActivityError(f"Row {p.row_number} does not exist; the table has {len(table)} rows.")
    return table.rows[p.row_number - 1].get(_column(table, p.column))


class ColumnToListParams(Params):
    table: Any = Param(title="Table", ui="variable")
    column: str = Param(title="Column", ui="column", source="table")
    skip_empty: bool = Param(True, title="Skip empty values")


@activity(
    "data.column_to_list",
    title="Get column as list",
    category=D,
    icon="list",
    sentence="Get column {column} of {table} as a list",
    params=ColumnToListParams,
    outputs=[OutputDef("list", "List", "list", default_variable="values")],
)
def column_to_list(ctx: RunContext, p: ColumnToListParams) -> list[Any]:
    table = _table(p.table)
    col = _column(table, p.column)
    return [r.get(col) for r in table.rows if not (p.skip_empty and is_empty(r.get(col)))]


class CountRowsParams(Params):
    table: Any = Param(title="Table or list", ui="variable")


@activity(
    "data.count",
    title="Count rows",
    category=D,
    icon="hash",
    sentence="Count rows of {table}",
    params=CountRowsParams,
    outputs=[OutputDef("count", "Count", "number", default_variable="row_count")],
)
def count_rows(ctx: RunContext, p: CountRowsParams) -> int:
    if isinstance(p.table, Table | list | tuple | dict):
        return len(p.table)
    if p.table in (None, ""):
        return 0
    raise ActivityError(f"Cannot count a {type_name(p.table)} value.")
