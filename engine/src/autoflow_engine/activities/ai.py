"""The AI step: ask the company's own AI model (set up in the Orchestrator) to classify, pull out
fields, summarise, translate or answer - Brity's "Cognitive" library, without any cloud service."""

from __future__ import annotations

from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError, RunCancelled
from ..runtime.context import RunContext
from ..values import to_text


class AskParams(Params):
    task: Literal["classify", "extract", "summarize", "translate", "answer"] = Param(
        "classify", title="Task",
        labels={"classify": "Choose a category", "extract": "Pull out fields", "summarize": "Summarise",
                "translate": "Translate", "answer": "Do what I write"},
    )
    text: str = Param(title="Text", ui="multiline", placeholder='{{email["text"]}}')
    categories: list[str] = Param(
        default_factory=list, title="Categories", show_when={"task": ["classify"]},
        description="The answer is exactly one of these, e.g. Invoice, Complaint, Order.",
    )
    fields: list[str] = Param(
        default_factory=list, title="Fields", show_when={"task": ["extract"]},
        description="What to pull out, e.g. Invoice number, Total, Due date. The answer has one value per field.",
    )
    language: str = Param("English", title="Into", show_when={"task": ["translate"]})
    instructions: str = Param(
        "", title="Instructions", ui="multiline", show_when={"task": ["answer"]},
        placeholder="Write a polite two-line reply to this customer.",
    )


@activity(
    "ai.ask",
    title="Ask the AI assistant",
    category="AI",
    icon="sparkles",
    sentence="AI: {task} {text}",
    description="Let the company's AI model read a text: sort it into a category, pull out fields, summarise, "
    "translate or follow your instructions. Needs the AI assistant to be turned on in the Orchestrator.",
    params=AskParams,
    outputs=[OutputDef("result", "Answer", "any", default_variable="ai_answer")],
)
def ask(ctx: RunContext, p: AskParams) -> Any:
    provider = ctx.options.ai
    if provider is None:
        raise ActivityError(
            "The AI assistant is not available for this run.",
            "An administrator turns it on in the Orchestrator (Settings > AI assistant).",
        )
    text = to_text(p.text)
    if not text.strip():
        raise ActivityError("There is no text for the AI assistant to read.")
    request: dict[str, Any] = {"task": p.task, "text": text[:60_000]}
    if p.task == "classify":
        request["categories"] = [to_text(c) for c in p.categories if to_text(c).strip()]
        if not request["categories"]:
            raise ActivityError("Give the categories to choose from.")
    elif p.task == "extract":
        request["fields"] = [to_text(f) for f in p.fields if to_text(f).strip()]
        if not request["fields"]:
            raise ActivityError("Give the fields to pull out.")
    elif p.task == "translate":
        request["language"] = to_text(p.language) or "English"
    elif p.task == "answer":
        request["instructions"] = to_text(p.instructions)
        if not request["instructions"].strip():
            raise ActivityError("Write what the AI assistant should do with the text.")
    ctx.log(f"Asking the AI assistant ({p.task})...")
    try:
        reply = provider(request)
    except RunCancelled:
        raise
    except ActivityError:
        raise
    except Exception as exc:
        raise ActivityError(f"The AI assistant could not answer: {exc}") from None
    if not isinstance(reply, dict) or "result" not in reply:
        raise ActivityError("The AI assistant gave no answer.")
    return reply["result"]
