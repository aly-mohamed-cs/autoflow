"""Text and date helpers with friendly presets instead of regular expressions."""

from __future__ import annotations

import datetime as dt
import re
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..runtime.expressions import friendly_date_format, to_date, to_number
from ..values import to_text

T = "Text"

# Ready-made patterns so users never need to write a regular expression.
PATTERNS: dict[str, tuple[str, str]] = {
    # A leading minus only counts when it isn't part of a code like "INV-0042".
    "number": (
        "Numbers (e.g. 1,250.50)",
        r"(?:(?<![\w.])-)?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?:(?<![\w.])-)?\d+(?:\.\d+)?",
    ),
    "whole_number": ("Whole numbers", r"\d+"),
    "email": ("Email addresses", r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"),
    "date": ("Dates (31/01/2026, 2026-01-31...)", r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b"),
    "phone": ("Phone numbers", r"\+?\d[\d\s()-]{6,}\d"),
    "url": ("Web addresses", r"https?://[^\s\"'<>]+"),
    "custom": ("Custom pattern (advanced)", ""),
}


class ExtractBetweenParams(Params):
    text: Any = Param(title="Text", ui="variable")
    after: str = Param("", title="Text that comes before", placeholder="Invoice No:")
    before: str = Param("", title="Text that comes after", placeholder="(empty = end of line)")
    all_matches: bool = Param(False, title="Get all occurrences (as a list)")
    trim: bool = Param(True, title="Remove surrounding spaces")


@activity(
    "text.extract_between",
    title="Get text between",
    category=T,
    icon="text-select",
    sentence="Get text between {after} and {before}",
    description="Pick out a value that sits between two known pieces of text.",
    params=ExtractBetweenParams,
    outputs=[OutputDef("result", "Result", "text", default_variable="extracted_text")],
)
def extract_between(ctx: RunContext, p: ExtractBetweenParams) -> Any:
    source = to_text(p.text)
    start = re.escape(p.after) if p.after else r"^"
    end = re.escape(p.before) if p.before else r"$"
    flags = re.MULTILINE | re.IGNORECASE | (re.DOTALL if p.before else 0)
    matches = [m.group(1) for m in re.finditer(f"{start}(.*?){end}", source, flags)]
    if p.trim:
        matches = [m.strip() for m in matches]
    if p.all_matches:
        return matches
    return matches[0] if matches else ""


class ExtractPatternParams(Params):
    text: Any = Param(title="Text", ui="variable")
    find: Literal["number", "whole_number", "email", "date", "phone", "url", "custom"] = Param(
        "number", title="Find"
    )
    pattern: str = Param("", title="Custom pattern", advanced=True, description="A regular expression.")
    all_matches: bool = Param(False, title="Get all occurrences (as a list)")


@activity(
    "text.extract_pattern",
    title="Find in text",
    category=T,
    icon="scan-search",
    sentence="Find {find} in {text}",
    description="Find numbers, emails, dates and more inside text.",
    params=ExtractPatternParams,
    outputs=[OutputDef("result", "Result", "any", default_variable="found")],
)
def extract_pattern(ctx: RunContext, p: ExtractPatternParams) -> Any:
    pattern = p.pattern if p.find == "custom" else PATTERNS[p.find][1]
    if not pattern:
        raise ActivityError("No custom pattern was given.")
    try:
        found = [m.group(0) for m in re.finditer(pattern, to_text(p.text))]
    except re.error as exc:
        raise ActivityError(f"The pattern is not valid: {exc}") from None
    if p.find == "number":
        found = [to_number(f) for f in found]
    if p.all_matches:
        return found
    return found[0] if found else None


class ReplaceTextParams(Params):
    text: Any = Param(title="Text", ui="variable")
    find: str = Param(title="Find")
    replace_with: str = Param("", title="Replace with")
    ignore_case: bool = Param(True, title="Ignore upper/lower case")


@activity(
    "text.replace",
    title="Replace text",
    category=T,
    icon="replace",
    sentence="Replace {find} with {replace_with}",
    params=ReplaceTextParams,
    outputs=[OutputDef("result", "Result", "text", default_variable="new_text")],
)
def replace_text(ctx: RunContext, p: ReplaceTextParams) -> str:
    flags = re.IGNORECASE if p.ignore_case else 0
    return re.sub(re.escape(p.find), lambda _m: p.replace_with, to_text(p.text), flags=flags)


class SplitTextParams(Params):
    text: Any = Param(title="Text", ui="variable")
    separator: Literal["new line", "comma", "semicolon", "space", "tab", "custom"] = Param(
        "comma", title="Split at"
    )
    custom_separator: str = Param("", title="Custom separator", advanced=True)
    skip_empty: bool = Param(True, title="Skip empty parts")


@activity(
    "text.split",
    title="Split text into list",
    category=T,
    icon="split-square-horizontal",
    sentence="Split {text} at {separator}",
    params=SplitTextParams,
    outputs=[OutputDef("list", "List", "list", default_variable="parts")],
)
def split_text(ctx: RunContext, p: SplitTextParams) -> list[str]:
    text = to_text(p.text)
    if p.separator == "new line":
        parts = text.splitlines()
    elif p.separator == "space":
        parts = text.split()
    else:
        sep = {"comma": ",", "semicolon": ";", "tab": "\t"}.get(p.separator, p.custom_separator)
        if not sep:
            raise ActivityError("No custom separator was given.")
        parts = text.split(sep)
    parts = [x.strip() for x in parts]
    return [x for x in parts if x] if p.skip_empty else parts


class ChangeCaseParams(Params):
    text: Any = Param(title="Text", ui="variable")
    case: Literal["UPPER CASE", "lower case", "Title Case", "Trim spaces only"] = Param("UPPER CASE", title="Change to")


@activity(
    "text.change_case",
    title="Change text case",
    category=T,
    icon="case-sensitive",
    sentence="Change {text} to {case}",
    params=ChangeCaseParams,
    outputs=[OutputDef("result", "Result", "text", default_variable="new_text")],
)
def change_case(ctx: RunContext, p: ChangeCaseParams) -> str:
    text = " ".join(to_text(p.text).split())
    return {
        "UPPER CASE": text.upper(),
        "lower case": text.lower(),
        "Title Case": text.title(),
    }.get(p.case, text)


class ToNumberParams(Params):
    text: Any = Param(title="Text", ui="variable", placeholder="$1,250.50")


@activity(
    "text.to_number",
    title="Convert text to number",
    category=T,
    icon="binary",
    sentence="Convert {text} to a number",
    params=ToNumberParams,
    outputs=[OutputDef("number", "Number", "number", default_variable="number")],
)
def text_to_number(ctx: RunContext, p: ToNumberParams) -> float | int:
    return to_number(p.text)


class CurrentDateParams(Params):
    include_time: bool = Param(False, title="Include time")


@activity(
    "text.current_date",
    title="Get current date",
    category=T,
    icon="calendar",
    sentence="Get today's date",
    params=CurrentDateParams,
    outputs=[OutputDef("date", "Date", "date", default_variable="today")],
)
def current_date(ctx: RunContext, p: CurrentDateParams) -> dt.date | dt.datetime:
    return dt.datetime.now().replace(microsecond=0) if p.include_time else dt.date.today()


class AddToDateParams(Params):
    date: Any = Param(title="Date", ui="variable")
    amount: float = Param(title="Add (use a minus sign to subtract)")
    unit: Literal["days", "weeks", "months", "years", "hours", "minutes"] = Param("days", title="Unit")


@activity(
    "text.add_to_date",
    title="Add to date",
    category=T,
    icon="calendar-plus",
    sentence="Add {amount} {unit} to {date}",
    params=AddToDateParams,
    outputs=[OutputDef("date", "New date", "date", default_variable="new_date")],
)
def add_to_date(ctx: RunContext, p: AddToDateParams) -> Any:
    from ..runtime.expressions import FUNCTIONS

    return FUNCTIONS["DATEADD"][0](p.date, p.amount, p.unit)


class FormatDateParams(Params):
    date: Any = Param(title="Date", ui="variable")
    format: str = Param("DD/MM/YYYY", title="Format", description="YYYY year, MM month, DD day, HH:mm time")


@activity(
    "text.format_date",
    title="Format date as text",
    category=T,
    icon="calendar-range",
    sentence="Format {date} as {format}",
    params=FormatDateParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="date_text")],
)
def format_date(ctx: RunContext, p: FormatDateParams) -> str:
    return to_date(p.date).strftime(friendly_date_format(p.format))
