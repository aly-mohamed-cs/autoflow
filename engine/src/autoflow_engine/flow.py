"""Flow document model.

A flow is plain data (JSON): a tree of steps plus the variables and UI elements
they reference. Studio edits it, the Orchestrator versions it, and the engine
interprets it. This module is the single source of truth for that format; the
TypeScript types used by Studio and the server are generated from its JSON Schema.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1

IDENTIFIER = r"^[A-Za-z_][A-Za-z0-9_]*$"

VariableType = Literal[
    "any", "text", "number", "boolean", "date", "list", "table", "file", "credential"
]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Variable(Model):
    name: str = Field(pattern=IDENTIFIER, max_length=64)
    type: VariableType = "any"
    default: Any = None
    description: str = ""
    is_input: bool = Field(False, description="Value can be supplied when the flow is started.")
    is_output: bool = Field(False, description="Value is returned when the flow finishes.")
    sensitive: bool = Field(False, description="Value is masked in logs and run history.")


class Selector(Model):
    """One way of locating an element. Elements keep several, tried in order."""

    strategy: Literal[
        "role", "text", "label", "placeholder", "testid", "css", "xpath", "uia", "image", "ocr"
    ]
    value: str
    options: dict[str, Any] = Field(default_factory=dict)


class Element(Model):
    """A UI element captured by the recorder or element picker, stored once per flow."""

    id: str
    name: str
    kind: Literal["web", "desktop"]
    selectors: list[Selector] = Field(min_length=1)
    screenshot: str | None = Field(None, description="Small PNG thumbnail as a data URI.")
    context: dict[str, Any] = Field(
        default_factory=dict, description="web: url/title/frame; desktop: process/window."
    )


class OnError(Model):
    retries: int = Field(0, ge=0, le=10)
    retry_delay: float = Field(1.0, ge=0, le=600, description="Seconds between retries.")
    action: Literal["stop", "continue"] = "stop"


class Step(Model):
    id: str
    activity: str
    label: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, str] = Field(
        default_factory=dict, description="Activity output name -> variable that receives it."
    )
    blocks: dict[str, list[Step]] = Field(
        default_factory=dict, description="Nested step lists for control activities (then/else/body...)."
    )
    on_error: OnError = Field(default_factory=OnError)
    disabled: bool = False


class ProcessInput(Model):
    """A value a sub-process is started with; it becomes a variable while the sub-process runs."""

    name: str = Field(pattern=IDENTIFIER, max_length=64)
    type: VariableType = "any"
    default: Any = None
    description: str = ""


class Link(Model):
    """A connector drawn by hand in a flowchart: after `source` (a step, or "start"), run `target`."""

    source: str
    target: str
    port: Literal["next", "yes", "no"] = Field(
        "next", description="Which way out of the source: 'next', or 'yes' / 'no' for a Decision."
    )


class Point(Model):
    x: float = 0
    y: float = 0


START = "start"


class Flowchart(Model):
    """Free connections (like Brity's and UiPath's flowcharts): steps run in the order they are
    connected, beginning at Start; a step nothing leads to doesn't run. A process without a
    flowchart runs its steps one after the other.

    Only the process's own (top-level) steps are connected this way; what is inside a loop,
    If or Try still runs in order."""

    links: list[Link] = Field(default_factory=list)
    positions: dict[str, Point] = Field(
        default_factory=dict, description="Where each step (and 'start') is drawn. Never affects a run."
    )

    def next_of(self, source: str, port: str = "next") -> str | None:
        return next((link.target for link in self.links if link.source == source and link.port == port), None)


class SubProcess(Model):
    """A named part of a flow (Brity RPA calls them tasks), started by "Run sub-process" steps.

    Sub-processes share the flow's variables; inputs let each "Run sub-process" hand it
    different values."""

    id: str = Field(pattern=IDENTIFIER, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    inputs: list[ProcessInput] = Field(default_factory=list)
    steps: list[Step] = Field(default_factory=list)
    flowchart: Flowchart | None = None


class Offset(Model):
    x: float = 0
    y: float = 0


class Layout(Model):
    """How the Flow view draws the flowchart. Never affects how a flow runs."""

    direction: Literal["horizontal", "vertical"] = "horizontal"
    offsets: dict[str, Offset] = Field(
        default_factory=dict,
        description="How far a step (or start / end) was moved from its tidy place, by its id.",
    )
    collapsed: list[str] = Field(default_factory=list, description="Boxes (groups, loops...) shown folded.")


class FlowSettings(Model):
    default_timeout: float = Field(30, ge=1, le=3600, description="Seconds to wait for elements.")
    screenshot_each_step: bool = False
    screenshot_on_error: bool = True
    step_delay: float = Field(
        0, ge=0, le=60, description="Seconds to wait after every step (to watch a run, or for slow programs)."
    )


class Flow(Model):
    schema_version: int = SCHEMA_VERSION
    id: str
    name: str
    description: str = ""
    variables: list[Variable] = Field(default_factory=list)
    elements: list[Element] = Field(default_factory=list)
    steps: list[Step] = Field(default_factory=list)
    flowchart: Flowchart | None = Field(None, description="The main process's free connections, if it uses them.")
    processes: list[SubProcess] = Field(default_factory=list)
    settings: FlowSettings = Field(default_factory=FlowSettings)
    layout: Layout = Field(default_factory=Layout)

    def iter_steps(self):
        """Yield every step in the tree (main process, then sub-processes), depth first."""
        yield from _walk(self.steps)
        for process in self.processes:
            yield from _walk(process.steps)

    def process(self, process_id: str) -> SubProcess | None:
        return next((p for p in self.processes if p.id == process_id), None)


def _walk(steps: list[Step]):
    for step in steps:
        yield step
        for children in step.blocks.values():
            yield from _walk(children)
