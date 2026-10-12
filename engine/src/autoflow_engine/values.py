"""Runtime value types and conversions shared by activities and the interpreter."""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

MASK = "••••••"


class Secret(str):
    """A string that must never appear in logs, events or screenshots-of-inputs."""

    def __repr__(self) -> str:
        return "Secret(••••••)"


class Credential:
    """A username/password pair fetched from the vault."""

    def __init__(self, name: str, username: str, password: str):
        self.name = name
        self.username = username
        self.password = Secret(password)

    def __getitem__(self, key: str) -> Any:
        if key in ("username", "password", "name"):
            return getattr(self, key)
        raise KeyError(key)

    def __repr__(self) -> str:
        return f"Credential({self.name!r})"


class Table:
    """Rows of named columns. Rows are dicts so loops can use row["Column"]."""

    def __init__(self, columns: Iterable[str] = (), rows: Iterable[dict[str, Any]] = ()):
        self.columns: list[str] = list(columns)
        self.rows: list[dict[str, Any]] = []
        for row in rows:
            self.append(row)

    @classmethod
    def from_matrix(cls, matrix: list[list[Any]], has_header: bool = True) -> Table:
        if not matrix:
            return cls()
        if has_header:
            header = _unique_headers(matrix[0])
            body = matrix[1:]
        else:
            width = max(len(r) for r in matrix)
            header = [f"Column{i + 1}" for i in range(width)]
            body = matrix
        rows = [{col: (r[i] if i < len(r) else None) for i, col in enumerate(header)} for r in body]
        return cls(header, rows)

    def append(self, row: dict[str, Any]) -> None:
        for key in row:
            if key not in self.columns:
                self.columns.append(key)
        self.rows.append({col: row.get(col) for col in self.columns})
        # Back-fill rows added before a new column appeared.
        for existing in self.rows:
            for col in self.columns:
                existing.setdefault(col, None)

    def to_matrix(self, include_header: bool = True) -> list[list[Any]]:
        body = [[row.get(col) for col in self.columns] for row in self.rows]
        return [list(self.columns), *body] if include_header else body

    def copy(self) -> Table:
        return Table(self.columns, [dict(r) for r in self.rows])

    def __len__(self) -> int:
        return len(self.rows)

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return iter(self.rows)

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.rows[index]

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Table) and self.columns == other.columns and self.rows == other.rows

    def __repr__(self) -> str:
        return f"Table({len(self.rows)} rows x {len(self.columns)} columns)"


def _unique_headers(raw: list[Any]) -> list[str]:
    seen: dict[str, int] = {}
    headers = []
    for i, value in enumerate(raw):
        name = str(value).strip() if value not in (None, "") else f"Column{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        headers.append(name)
    return headers


def to_text(value: Any) -> str:
    """How a value looks when inserted into text (e.g. "Hello {{name}}")."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, Table):
        return "\n".join(",".join(to_text(c) for c in r) for r in value.to_matrix())
    if isinstance(value, list | tuple):
        return ", ".join(to_text(v) for v in value)
    return str(value)


def to_jsonable(value: Any, *, depth: int = 0, row_limit: int = 50) -> Any:
    """A JSON-safe preview of a value for events, logs and the variables panel."""
    if depth > 6:
        return "…"
    if isinstance(value, Secret):
        return MASK
    if isinstance(value, Credential):
        return {"$type": "credential", "name": value.name, "username": value.username}
    if value is None or isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dt.datetime | dt.date | dt.time):
        return {"$type": "date", "value": value.isoformat()}
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Table):
        return {
            "$type": "table",
            "columns": value.columns,
            "rows": [to_jsonable(r, depth=depth + 1) for r in value.rows[:row_limit]],
            "row_count": len(value.rows),
        }
    if isinstance(value, dict):
        return {str(k): to_jsonable(v, depth=depth + 1) for k, v in list(value.items())[:200]}
    if isinstance(value, list | tuple | set):
        items = list(value)
        out = [to_jsonable(v, depth=depth + 1) for v in items[:row_limit]]
        if len(items) > row_limit:
            out.append(f"… {len(items) - row_limit} more")
        return out
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    return f"<{type(value).__name__}>"


def type_name(value: Any) -> str:
    """Friendly type name used in error messages and the variables panel."""
    if value is None:
        return "empty"
    if isinstance(value, bool):
        return "yes/no"
    if isinstance(value, int | float | Decimal):
        return "number"
    if isinstance(value, str):
        return "text"
    if isinstance(value, dt.date):
        return "date"
    if isinstance(value, Table):
        return "table"
    if isinstance(value, list | tuple):
        return "list"
    if isinstance(value, dict):
        return "record"
    if isinstance(value, Credential):
        return "credential"
    return type(value).__name__


def parse_point(value: Any) -> tuple[int, int]:
    """A position written as "120, 45" (also "120 45", [120, 45] or {"x": 120, "y": 45})."""
    if isinstance(value, dict) and "x" in value and "y" in value:
        parts: list[Any] = [value["x"], value["y"]]
    elif isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        text = to_text(value).strip().strip("()[]")
        parts = [p for p in text.replace(";", ",").replace(" ", ",").split(",") if p.strip()]
    try:
        if len(parts) != 2:
            raise ValueError
        x, y = (round(float(str(p).strip())) for p in parts)
    except ValueError:
        from .errors import ActivityError

        raise ActivityError(
            f"'{to_text(value)}' is not a position.",
            "Write it as X, Y in pixels, for example 120, 45, or use 'Pick position'.",
        ) from None
    return x, y
