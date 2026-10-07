"""Safe, Excel-like formula language used inside {{ }} references.

Users mostly insert plain variable references through the chip picker
(``{{invoice_no}}``, ``{{row["Total"]}}``). Power users can write formulas such as
``{{ROUND(row["Total"] * 1.14, 2)}}`` or ``{{IF(amount > 1000, "High", "Normal")}}``.

The syntax is a small subset of Python expressions, parsed with :mod:`ast` and
evaluated by walking a whitelist of node types. There is no attribute access to
Python internals, no imports, no lambdas and no comprehensions.
"""

from __future__ import annotations

import ast
import datetime as dt
import math
import operator
import re
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import Any

from ..errors import ExpressionError
from ..values import Table, to_text, type_name

MAX_TEXT = 5_000_000
MAX_EXPRESSION = 2_000

# ---------------------------------------------------------------------------
# Built-in functions. Each entry: name -> (callable, signature, description, category)
# The catalog exports this list so Studio can show a function picker.
# ---------------------------------------------------------------------------

FUNCTIONS: dict[str, tuple[Callable[..., Any], str, str, str]] = {}


def _fn(signature: str, description: str, category: str):
    def deco(func: Callable[..., Any]):
        name = signature.split("(", 1)[0]
        FUNCTIONS[name] = (func, signature, description, category)
        return func

    return deco


def _num(value: Any) -> float | int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int | float):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0
    text = str(value).strip().replace(",", "")
    for symbol in ("$", "€", "£", "%"):
        text = text.replace(symbol, "")
    try:
        number = float(text)
    except ValueError:
        raise ExpressionError(
            f"'{value}' is not a number.", "Check that the value only contains digits."
        ) from None
    return int(number) if number.is_integer() and "." not in text and "e" not in text.lower() else number


def _date(value: Any) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value
    if isinstance(value, dt.date):
        return dt.datetime(value.year, value.month, value.day)
    if isinstance(value, str):
        text = value.strip()
        try:
            return dt.datetime.fromisoformat(text)
        except ValueError:
            pass
        for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%m/%d/%Y", "%Y/%m/%d", "%d %b %Y", "%d %B %Y"):
            try:
                return dt.datetime.strptime(text, fmt)
            except ValueError:
                continue
    raise ExpressionError(f"'{value}' is not a date.", "Use a date like 2026-01-31 or 31/01/2026.")


_DATE_TOKENS = [
    ("YYYY", "%Y"),
    ("YY", "%y"),
    ("MMMM", "%B"),
    ("MMM", "%b"),
    ("MM", "%m"),
    ("DDDD", "%A"),
    ("DDD", "%a"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("hh", "%I"),
    ("mm", "%M"),
    ("ss", "%S"),
    ("A", "%p"),
]


def friendly_date_format(fmt: str) -> str:
    """Convert a friendly pattern like 'DD/MM/YYYY HH:mm' to strftime."""
    out, i = [], 0
    while i < len(fmt):
        for token, code in _DATE_TOKENS:
            if fmt.startswith(token, i):
                out.append(code)
                i += len(token)
                break
        else:
            out.append(fmt[i].replace("%", "%%"))
            i += 1
    return "".join(out)


@_fn("TEXT(value)", "Convert a value to text.", "Text")
def _text(value):
    return to_text(value)


@_fn("NUMBER(value)", "Convert text like '1,250.50' to a number.", "Number")
def _number(value):
    return _num(value)


@_fn("INT(value)", "Whole-number part of a number.", "Number")
def _int(value):
    return int(_num(value))


@_fn("UPPER(text)", "Text in UPPER CASE.", "Text")
def _upper(text):
    return to_text(text).upper()


@_fn("LOWER(text)", "Text in lower case.", "Text")
def _lower(text):
    return to_text(text).lower()


@_fn("PROPER(text)", "Text In Title Case.", "Text")
def _proper(text):
    return to_text(text).title()


@_fn("TRIM(text)", "Remove spaces at the start and end.", "Text")
def _trim(text):
    return " ".join(to_text(text).split()) if text is not None else ""


@_fn("LEN(value)", "Number of characters in text, or items in a list/table.", "Text")
def _len(value):
    if isinstance(value, list | tuple | dict | Table):
        return len(value)
    return len(to_text(value))


@_fn("LEFT(text, count)", "First characters of text.", "Text")
def _left(text, count=1):
    return to_text(text)[: int(_num(count))]


@_fn("RIGHT(text, count)", "Last characters of text.", "Text")
def _right(text, count=1):
    n = int(_num(count))
    return to_text(text)[-n:] if n > 0 else ""


@_fn("MID(text, start, count)", "Characters from the middle of text (start counts from 1).", "Text")
def _mid(text, start, count):
    s = max(int(_num(start)) - 1, 0)
    return to_text(text)[s : s + int(_num(count))]


@_fn("REPLACE(text, find, replace_with)", "Replace every occurrence of some text.", "Text")
def _replace(text, find, replace_with):
    return to_text(text).replace(to_text(find), to_text(replace_with))


@_fn("CONTAINS(text, part)", "True if text contains part (ignores case).", "Text")
def _contains(text, part):
    if isinstance(text, list | tuple):
        return any(to_text(v).casefold() == to_text(part).casefold() for v in text)
    return to_text(part).casefold() in to_text(text).casefold()


@_fn("STARTSWITH(text, part)", "True if text starts with part (ignores case).", "Text")
def _startswith(text, part):
    return to_text(text).casefold().startswith(to_text(part).casefold())


@_fn("ENDSWITH(text, part)", "True if text ends with part (ignores case).", "Text")
def _endswith(text, part):
    return to_text(text).casefold().endswith(to_text(part).casefold())


@_fn("SPLIT(text, separator)", "Split text into a list.", "Text")
def _split(text, separator=","):
    return [p.strip() for p in to_text(text).split(to_text(separator) or ",")]


@_fn("JOIN(list, separator)", "Join a list into text.", "Text")
def _join(items, separator=", "):
    return to_text(separator).join(to_text(v) for v in (items or []))


@_fn("CONCAT(value1, value2, ...)", "Join values into one text.", "Text")
def _concat(*values):
    return "".join(to_text(v) for v in values)


@_fn("REGEXEXTRACT(text, pattern, group)", "Part of text matching a pattern (advanced).", "Text")
def _regex_extract(text, pattern, group=0):
    match = re.search(to_text(pattern), to_text(text))
    if not match:
        return ""
    return match.group(int(_num(group)))


@_fn("ROUND(number, decimals)", "Round a number.", "Number")
def _round(number, decimals=0):
    d = int(_num(decimals))
    value = Decimal(str(_num(number))).quantize(Decimal(1).scaleb(-d), rounding="ROUND_HALF_UP")
    return int(value) if d <= 0 else float(value)


@_fn("ABS(number)", "Number without its sign.", "Number")
def _abs(number):
    return abs(_num(number))


def _flatten(values) -> list[Any]:
    out = []
    for v in values:
        if isinstance(v, list | tuple):
            out.extend(v)
        else:
            out.append(v)
    return out


@_fn("SUM(values...)", "Total of numbers or a list of numbers.", "Number")
def _sum(*values):
    return sum(_num(v) for v in _flatten(values))


@_fn("AVERAGE(values...)", "Average of numbers or a list.", "Number")
def _average(*values):
    nums = [_num(v) for v in _flatten(values)]
    return sum(nums) / len(nums) if nums else 0


@_fn("MIN(values...)", "Smallest number.", "Number")
def _min(*values):
    nums = [_num(v) for v in _flatten(values)]
    return min(nums) if nums else 0


@_fn("MAX(values...)", "Largest number.", "Number")
def _max(*values):
    nums = [_num(v) for v in _flatten(values)]
    return max(nums) if nums else 0


@_fn("FORMATNUMBER(number, decimals)", "Number as text with thousands separators, e.g. 1,250.50.", "Number")
def _format_number(number, decimals=2):
    return f"{_num(number):,.{int(_num(decimals))}f}"


@_fn("COUNT(list)", "Number of items in a list or rows in a table.", "Lists")
def _count(items):
    return len(items) if items is not None else 0


@_fn("FIRST(list)", "First item of a list or first row of a table.", "Lists")
def _first(items):
    return items[0] if items else None


@_fn("LAST(list)", "Last item of a list or last row of a table.", "Lists")
def _last(items):
    return items[-1] if items else None


@_fn("COLUMN(table, column)", "All values of one table column as a list.", "Lists")
def _column(table, column):
    if not isinstance(table, Table):
        raise ExpressionError("COLUMN needs a table.")
    return [row.get(to_text(column)) for row in table]


@_fn("IF(condition, value_if_true, value_if_false)", "Choose a value based on a condition.", "Logic")
def _if(condition, when_true, when_false=None):
    return when_true if truthy(condition) else when_false


@_fn("ISEMPTY(value)", "True if the value is empty.", "Logic")
def _isempty(value):
    return is_empty(value)


@_fn("COALESCE(value1, value2, ...)", "First value that is not empty.", "Logic")
def _coalesce(*values):
    return next((v for v in values if not is_empty(v)), None)


@_fn("TODAY()", "Today's date.", "Dates")
def _today():
    return dt.date.today()


@_fn("NOW()", "Current date and time.", "Dates")
def _now():
    return dt.datetime.now().replace(microsecond=0)


@_fn("DATE(year, month, day)", "Build a date.", "Dates")
def _make_date(year, month, day):
    return dt.date(int(_num(year)), int(_num(month)), int(_num(day)))


@_fn("PARSEDATE(text, format)", "Read a date from text, e.g. PARSEDATE('31/01/2026', 'DD/MM/YYYY').", "Dates")
def _parse_date(text, fmt=None):
    if fmt:
        try:
            return dt.datetime.strptime(to_text(text).strip(), friendly_date_format(to_text(fmt)))
        except ValueError:
            raise ExpressionError(f"'{text}' does not match the date format '{fmt}'.") from None
    return _date(text)


@_fn("FORMATDATE(date, format)", "Date as text, e.g. FORMATDATE(TODAY(), 'DD/MM/YYYY').", "Dates")
def _format_date(value, fmt="YYYY-MM-DD"):
    return _date(value).strftime(friendly_date_format(to_text(fmt)))


@_fn("DATEADD(date, amount, unit)", "Add days, weeks, months or years (unit) to a date.", "Dates")
def _date_add(value, amount, unit="days"):
    base = value if isinstance(value, dt.date) else _date(value)
    n = _num(amount)
    unit = to_text(unit).lower().rstrip("s")
    if unit in ("day", "week", "hour", "minute"):
        delta = {"day": dt.timedelta(days=n), "week": dt.timedelta(weeks=n),
                 "hour": dt.timedelta(hours=n), "minute": dt.timedelta(minutes=n)}[unit]
        if unit in ("hour", "minute") and not isinstance(base, dt.datetime):
            base = _date(base)
        return base + delta
    if unit in ("month", "year"):
        months = int(n) * (12 if unit == "year" else 1)
        total = base.month - 1 + months
        year, month = base.year + total // 12, total % 12 + 1
        last_day = [31, 29 if _leap(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        return base.replace(year=year, month=month, day=min(base.day, last_day))
    raise ExpressionError(f"Unknown date unit '{unit}'.", "Use days, weeks, months, years, hours or minutes.")


def _leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


@_fn("DAYSBETWEEN(start, end)", "Number of days from start to end.", "Dates")
def _days_between(start, end):
    return (_date(end).date() - _date(start).date()).days


@_fn("YEAR(date)", "Year of a date.", "Dates")
def _year(value):
    return _date(value).year


@_fn("MONTH(date)", "Month number (1-12) of a date.", "Dates")
def _month(value):
    return _date(value).month


@_fn("DAY(date)", "Day of the month of a date.", "Dates")
def _day(value):
    return _date(value).day


@_fn("WEEKDAY(date)", "Day of the week, Monday = 1 ... Sunday = 7.", "Dates")
def _weekday(value):
    return _date(value).isoweekday()


# ---------------------------------------------------------------------------
# Helpers shared with conditions
# ---------------------------------------------------------------------------


def is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list | tuple | dict | Table):
        return len(value) == 0
    return False


def truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "no", "0", "n")
    if isinstance(value, Table):
        return len(value) > 0
    return bool(value)


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

_BIN_OPS: dict[type[ast.operator], Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

_CMP_OPS: dict[type[ast.cmpop], Callable[[Any, Any], bool]] = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}

_ALIASES = {"true": True, "false": False, "null": None, "none": None, "yes": True, "no": False}
_FUNC_LOOKUP = {name.upper(): name for name in FUNCTIONS}

_PARSE_CACHE: dict[str, ast.Expression] = {}


def parse(source: str) -> ast.Expression:
    source = source.strip()
    cached = _PARSE_CACHE.get(source)
    if cached is not None:
        return cached
    if len(source) > MAX_EXPRESSION:
        raise ExpressionError("This formula is too long.")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise ExpressionError(
            f"The formula '{source}' has a typing mistake near position {exc.offset or 0}.",
            "Check brackets, quotes and commas.",
        ) from None
    _check(tree)
    if len(_PARSE_CACHE) > 2000:
        _PARSE_CACHE.clear()
    _PARSE_CACHE[source] = tree
    return tree


_ALLOWED_NODES = (
    ast.Expression, ast.Constant, ast.Name, ast.Load, ast.BinOp, ast.UnaryOp, ast.BoolOp,
    ast.Compare, ast.Call, ast.Subscript, ast.Attribute, ast.List, ast.Tuple, ast.IfExp,
    ast.And, ast.Or, ast.Not, ast.USub, ast.UAdd, ast.In, ast.NotIn, ast.Slice,
    *_BIN_OPS, *_CMP_OPS,
)


def _check(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ExpressionError(f"'{type(node).__name__}' is not allowed in formulas.")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ExpressionError("Names starting with '_' are not allowed in formulas.")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ExpressionError("Names starting with '_' are not allowed in formulas.")
        if isinstance(node, ast.Call) and not isinstance(node.func, ast.Name):
            raise ExpressionError("Only built-in functions such as UPPER(...) can be called.")


def evaluate(source: str, variables: Mapping[str, Any]) -> Any:
    """Evaluate a formula against the current variables."""
    tree = parse(source)
    try:
        return _Evaluator(variables).visit(tree.body)
    except ExpressionError:
        raise
    except ZeroDivisionError:
        raise ExpressionError(f"Division by zero in '{source.strip()}'.") from None
    except (TypeError, ValueError, KeyError, IndexError, OverflowError) as exc:
        raise ExpressionError(f"Could not calculate '{source.strip()}': {exc}") from None


class _Evaluator:
    def __init__(self, variables: Mapping[str, Any]):
        self.variables = variables

    def visit(self, node: ast.AST) -> Any:
        method = getattr(self, f"visit_{type(node).__name__}")
        return method(node)

    def visit_Constant(self, node: ast.Constant) -> Any:
        return node.value

    def visit_Name(self, node: ast.Name) -> Any:
        if node.id in self.variables:
            return self.variables[node.id]
        alias = node.id.lower()
        if alias in _ALIASES:
            return _ALIASES[alias]
        raise ExpressionError(
            f"There is no variable called '{node.id}'.",
            "Create the variable first, or pick it from the variables list.",
        )

    def visit_List(self, node: ast.List) -> Any:
        return [self.visit(e) for e in node.elts]

    def visit_Tuple(self, node: ast.Tuple) -> Any:
        return [self.visit(e) for e in node.elts]

    def visit_UnaryOp(self, node: ast.UnaryOp) -> Any:
        value = self.visit(node.operand)
        if isinstance(node.op, ast.Not):
            return not truthy(value)
        number = _num(value)
        return -number if isinstance(node.op, ast.USub) else +number

    def visit_BinOp(self, node: ast.BinOp) -> Any:
        left, right = self.visit(node.left), self.visit(node.right)
        op = type(node.op)
        if op is ast.Add and (isinstance(left, str) or isinstance(right, str)):
            # "5" + 3 -> 8 (values read from screens are text); "Invoice " + 5 -> "Invoice 5"
            if _try_num(left) is not None and _try_num(right) is not None:
                return _num(left) + _num(right)
            result = to_text(left) + to_text(right)
        elif op is ast.Add and isinstance(left, list) and isinstance(right, list):
            result = left + right
        elif op is ast.Add and isinstance(left, dt.date) and not isinstance(right, dt.date):
            return left + dt.timedelta(days=_num(right))
        elif op is ast.Sub and isinstance(left, dt.date) and isinstance(right, dt.date):
            return (_date(left) - _date(right)).days
        elif op is ast.Pow:
            base, exp = _num(left), _num(right)
            if abs(exp) > 100:
                raise ExpressionError("Exponent is too large.")
            return base**exp
        elif op is ast.Mult and isinstance(left, str | list) and not isinstance(right, str | list):
            result = left * int(_num(right))
        else:
            return _BIN_OPS[op](_num(left), _num(right))
        if len(result) > MAX_TEXT:
            raise ExpressionError("The result is too large.")
        return result

    def visit_BoolOp(self, node: ast.BoolOp) -> Any:
        # Short-circuits like Excel's AND/OR and always returns true/false.
        values = (truthy(self.visit(v)) for v in node.values)
        return all(values) if isinstance(node.op, ast.And) else any(values)

    def visit_Compare(self, node: ast.Compare) -> bool:
        left = self.visit(node.left)
        for op, comparator in zip(node.ops, node.comparators, strict=True):
            right = self.visit(comparator)
            if isinstance(op, ast.In | ast.NotIn):
                found = _contains(right, left) if isinstance(right, str | list | tuple) else left in right
                ok = found if isinstance(op, ast.In) else not found
            else:
                a, b = coerce_pair(left, right)
                ok = _CMP_OPS[type(op)](a, b)
            if not ok:
                return False
            left = right
        return True

    def visit_IfExp(self, node: ast.IfExp) -> Any:
        return self.visit(node.body) if truthy(self.visit(node.test)) else self.visit(node.orelse)

    def visit_Subscript(self, node: ast.Subscript) -> Any:
        container = self.visit(node.value)
        if isinstance(node.slice, ast.Slice):
            lower = None if node.slice.lower is None else int(_num(self.visit(node.slice.lower)))
            upper = None if node.slice.upper is None else int(_num(self.visit(node.slice.upper)))
            return container[lower:upper]
        key = self.visit(node.slice)
        return _get_item(container, key)

    def visit_Attribute(self, node: ast.Attribute) -> Any:
        container = self.visit(node.value)
        if isinstance(container, Table) and node.attr in ("columns", "rows"):
            return list(getattr(container, node.attr))
        return _get_item(container, node.attr)

    def visit_Call(self, node: ast.Call) -> Any:
        assert isinstance(node.func, ast.Name)
        name = _FUNC_LOOKUP.get(node.func.id.upper())
        if name is None:
            raise ExpressionError(f"There is no function called '{node.func.id}'.")
        if node.keywords:
            raise ExpressionError(f"{name}(...) does not accept named arguments.")
        func = FUNCTIONS[name][0]
        args = [self.visit(a) for a in node.args]
        try:
            return func(*args)
        except TypeError:
            raise ExpressionError(f"Wrong number of values given to {FUNCTIONS[name][1]}.") from None


def _get_item(container: Any, key: Any) -> Any:
    if isinstance(container, dict):
        if key in container:
            return container[key]
        # Friendly lookup: ignore case and surrounding spaces of column names.
        wanted = to_text(key).strip().casefold()
        for k, v in container.items():
            if to_text(k).strip().casefold() == wanted:
                return v
        raise ExpressionError(
            f"There is no field or column called '{key}'.",
            "Available: " + ", ".join(str(k) for k in container) if container else None,
        )
    if isinstance(container, list | tuple | Table | str):
        index = int(_num(key))
        try:
            return container[index]
        except IndexError:
            raise ExpressionError(
                f"Item number {index} does not exist; there are only {len(container)}."
            ) from None
    if hasattr(container, "__getitem__") and not isinstance(container, type):
        try:
            return container[key]
        except (KeyError, TypeError):
            pass
    raise ExpressionError(f"Cannot read '{key}' from a {type_name(container)} value.")


def coerce_pair(a: Any, b: Any) -> tuple[Any, Any]:
    """Make two values comparable: numbers with numbers, dates with dates, else text."""
    if isinstance(a, bool) or isinstance(b, bool):
        return truthy(a), truthy(b)
    if isinstance(a, dt.date) or isinstance(b, dt.date):
        try:
            return _date(a), _date(b)
        except ExpressionError:
            pass
    a_num, b_num = _try_num(a), _try_num(b)
    if a_num is not None and b_num is not None:
        return a_num, b_num
    if a is None or b is None:
        return to_text(a), to_text(b)
    return to_text(a).strip().casefold(), to_text(b).strip().casefold()


def _try_num(value: Any) -> float | int | None:
    if isinstance(value, int | float | Decimal) and not isinstance(value, bool):
        return float(value) if isinstance(value, Decimal) else value
    if isinstance(value, str) and value.strip():
        try:
            return _num(value)
        except ExpressionError:
            return None
    return None


def is_number(value: Any) -> bool:
    return _try_num(value) is not None and not (isinstance(value, float) and math.isnan(value))


# Public names for activities.
to_number = _num
to_date = _date
