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


class FlowSettings(Model):
    default_timeout: float = Field(30, ge=1, le=3600, description="Seconds to wait for elements.")
    screenshot_each_step: bool = False
    screenshot_on_error: bool = True


class Flow(Model):
    schema_version: int = SCHEMA_VERSION
    id: str
    name: str
    description: str = ""
    variables: list[Variable] = Field(default_factory=list)
    elements: list[Element] = Field(default_factory=list)
    steps: list[Step] = Field(default_factory=list)
    settings: FlowSettings = Field(default_factory=FlowSettings)

    def iter_steps(self):
        """Yield every step in the tree, depth first."""
        yield from _walk(self.steps)


def _walk(steps: list[Step]):
    for step in steps:
        yield step
        for children in step.blocks.values():
            yield from _walk(children)
