"""Activity registry and catalog export.

Every automation building block ("Read Excel file", "Click element", "If") is a
Python function registered with :func:`activity`. The registration carries
everything Studio needs to show it to non-technical users: a title, an icon, a
category, a plain-English sentence and a pydantic model describing its settings
(with ``x-ui`` hints that pick the right input widget). ``export_catalog`` turns
the registry into ``activity-catalog.json`` for Studio and the Orchestrator.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from types import UnionType
from typing import Any, Union, get_args, get_origin

from pydantic import BaseModel, ConfigDict, Field
from pydantic_core import PydanticUndefined

from . import __version__
from .flow import VariableType
from .runtime.conditions import OPERATORS, Condition
from .runtime.expressions import FUNCTIONS

# Widget kinds Studio knows how to render. Anything else falls back to a text box.
#   variable       - pick a value: inserts {{name}} (the step receives the value)
#   variable_name  - pick or create a variable to write to (the step receives the name)
UI_KINDS = {
    "text", "multiline", "number", "boolean", "choice", "file", "folder", "save_file",
    "variable", "variable_name", "condition", "element", "credential", "column", "keys",
    "url", "key_values", "list", "code", "duration", "password",
    "process", "process_inputs", "point", "image", "region", "asset", "queue",
}


def Param(  # noqa: N802 - reads like a type in model definitions
    default: Any = PydanticUndefined,
    *,
    title: str,
    description: str = "",
    ui: str | None = None,
    placeholder: str | None = None,
    advanced: bool = False,
    lazy: bool = False,
    source: str | None = None,
    file_types: list[str] | None = None,
    labels: dict[str, str] | None = None,
    show_when: dict[str, list[str]] | None = None,
    **kwargs: Any,
) -> Any:
    """Describe one activity setting.

    ui: widget kind (see UI_KINDS); inferred from the type when omitted.
    advanced: hidden under "More options" in Studio.
    lazy: not resolved before the activity runs (e.g. per-row formulas).
    source: for ui="column", the setting holding the table whose columns to offer.
    file_types: for file pickers, e.g. ["xlsx", "xls"].
    labels: for choices, the words Studio shows for each value.
    show_when: only show this setting while other settings have one of these values,
        e.g. {"target": ["window", "screen"]}.
    """
    if ui is not None and ui not in UI_KINDS:
        raise ValueError(f"Unknown ui kind {ui!r}")
    extra = {
        "x-ui": ui,
        "x-placeholder": placeholder,
        "x-advanced": advanced or None,
        "x-lazy": lazy or None,
        "x-source": source,
        "x-file-types": file_types,
        "x-labels": labels,
        "x-show-when": show_when,
    }
    return Field(
        default,
        title=title,
        description=description or None,
        json_schema_extra={k: v for k, v in extra.items() if v is not None},
        **kwargs,
    )


class Params(BaseModel):
    """Base class for activity settings."""

    model_config = ConfigDict(extra="forbid")


class NoParams(Params):
    pass


@dataclass(frozen=True)
class OutputDef:
    name: str
    title: str
    type: VariableType = "any"
    description: str = ""
    default_variable: str | None = None


@dataclass(frozen=True)
class BlockDef:
    name: str
    title: str


@dataclass
class ActivityDef:
    id: str
    title: str
    category: str
    icon: str
    sentence: str
    description: str
    params: type[Params]
    outputs: tuple[OutputDef, ...]
    blocks: tuple[BlockDef, ...]
    func: Callable[..., Any]
    advanced: bool = False
    requires: str | None = None
    lazy_fields: frozenset[str] = field(default_factory=frozenset)
    text_fields: frozenset[str] = field(default_factory=frozenset)
    uses_runner: bool = False
    # One extra block per item of a list setting (Switch: one per case): (setting, block prefix).
    block_list: tuple[str, str] | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "icon": self.icon,
            "sentence": self.sentence,
            "description": self.description,
            "params": self.params.model_json_schema(),
            "outputs": [
                {
                    "name": o.name,
                    "title": o.title,
                    "type": o.type,
                    "description": o.description,
                    "default_variable": o.default_variable or o.name,
                }
                for o in self.outputs
            ],
            "blocks": [{"name": b.name, "title": b.title} for b in self.blocks],
            "block_list": (
                {"param": self.block_list[0], "prefix": self.block_list[1]} if self.block_list else None
            ),
            "advanced": self.advanced,
            "requires": self.requires,
        }


REGISTRY: dict[str, ActivityDef] = {}

# Display order and icons (lucide icon names) of the categories in the step panel.
CATEGORIES: list[dict[str, str]] = [
    {"id": "Control", "icon": "workflow", "description": "Decisions, loops, waits and error handling"},
    {"id": "Browser", "icon": "globe", "description": "Websites and web applications"},
    {"id": "Desktop", "icon": "app-window", "description": "Windows desktop applications"},
    {"id": "Screen", "icon": "scan-eye", "description": "Pictures and text on the screen (remote desktops, Citrix)"},
    {"id": "Excel", "icon": "sheet", "description": "Excel workbooks"},
    {"id": "Files", "icon": "folder", "description": "Files, folders, CSV and ZIP"},
    {"id": "Data", "icon": "table", "description": "Tables and lists"},
    {"id": "Text", "icon": "type", "description": "Text and dates"},
    {"id": "PDF", "icon": "file-text", "description": "PDF documents"},
    {"id": "Word", "icon": "file-type", "description": "Word documents"},
    {"id": "PowerPoint", "icon": "presentation", "description": "PowerPoint presentations"},
    {"id": "Email", "icon": "mail", "description": "Send and read email"},
    {"id": "Web & APIs", "icon": "plug", "description": "HTTP requests and web services"},
    {"id": "System", "icon": "monitor-cog", "description": "Commands, clipboard, special folders, the registry"},
    {"id": "FTP & SSH", "icon": "server", "description": "File servers (FTP, SFTP) and SSH commands"},
    {"id": "AI", "icon": "sparkles", "description": "The company's own AI model: classify, extract, summarise"},
    {"id": "Orchestrator", "icon": "network", "description": "Shared values and work queues kept in the Orchestrator"},
    {"id": "Database", "icon": "database", "description": "SQL databases"},
]
_CATEGORY_IDS = {c["id"] for c in CATEGORIES}


def activity(
    activity_id: str,
    *,
    title: str,
    category: str,
    icon: str,
    sentence: str,
    description: str = "",
    params: type[Params] = NoParams,
    outputs: tuple[OutputDef, ...] | list[OutputDef] = (),
    blocks: tuple[BlockDef, ...] | list[BlockDef] = (),
    advanced: bool = False,
    requires: str | None = None,
    uses_runner: bool = False,
    block_list: tuple[str, str] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register an activity. The function receives ``(ctx, params)``, plus a
    ``BlockRunner`` when the activity has blocks or ``uses_runner`` (it runs other
    steps, e.g. a sub-process), and returns its outputs: a dict keyed by output name,
    or a single value when it has exactly one output."""

    if category not in _CATEGORY_IDS:
        raise ValueError(f"Unknown category {category!r} for {activity_id}")

    def register(func: Callable[..., Any]) -> Callable[..., Any]:
        if activity_id in REGISTRY:
            raise ValueError(f"Activity {activity_id!r} is registered twice")
        lazy = frozenset(
            name
            for name, f in params.model_fields.items()
            if _is_condition(f.annotation)
            or (isinstance(f.json_schema_extra, dict) and f.json_schema_extra.get("x-lazy"))
        )
        text = frozenset(name for name, f in params.model_fields.items() if _is_text(f.annotation))
        REGISTRY[activity_id] = ActivityDef(
            id=activity_id,
            title=title,
            category=category,
            icon=icon,
            sentence=sentence,
            description=description,
            params=params,
            outputs=tuple(outputs),
            blocks=tuple(blocks),
            func=func,
            advanced=advanced,
            requires=requires,
            lazy_fields=lazy,
            text_fields=text,
            uses_runner=uses_runner,
            block_list=block_list,
        )
        return func

    return register


def _is_text(annotation: Any) -> bool:
    """str or str | None: values like 1500.25 from Excel are turned into text for these."""
    if annotation is str:
        return True
    if get_origin(annotation) not in (Union, UnionType):
        return False  # e.g. list[str] is a list, not text
    args = get_args(annotation)
    return str in args and all(a in (str, type(None)) for a in args)


def _is_condition(annotation: Any) -> bool:
    if annotation is Condition:
        return True
    return Condition in getattr(annotation, "__args__", ())


def get(activity_id: str) -> ActivityDef | None:
    load_activities()
    return REGISTRY.get(activity_id)


_loaded = False


def blocks_of(adef: ActivityDef, params: dict[str, Any]) -> list[BlockDef]:
    """The step lists a step has: one per item of its block_list setting, then the fixed ones."""
    extra: list[BlockDef] = []
    if adef.block_list:
        setting, prefix = adef.block_list
        items = params.get(setting) or []
        if isinstance(items, list):
            extra = [BlockDef(f"{prefix}{i}", str(item) or f"Case {i}") for i, item in enumerate(items, start=1)]
    return [*extra, *adef.blocks]


def load_activities() -> dict[str, ActivityDef]:
    """Import every activity module so they register themselves."""
    global _loaded
    if not _loaded:
        from . import activities  # noqa: F401  (import has side effects)

        _loaded = True
    return REGISTRY


def export_catalog() -> dict[str, Any]:
    load_activities()
    return {
        "engine_version": __version__,
        "categories": CATEGORIES,
        "activities": [a.to_json() for a in REGISTRY.values()],
        "functions": [
            {"name": name, "signature": sig, "description": desc, "category": cat}
            for name, (_fn, sig, desc, cat) in FUNCTIONS.items()
        ],
        "operators": [
            {"name": name, "label": label, "needs_value": needs}
            for name, (label, needs, _check) in OPERATORS.items()
        ],
    }
