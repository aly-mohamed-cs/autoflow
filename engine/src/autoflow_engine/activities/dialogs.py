"""Messages and questions for the person at the computer (Brity "MessageBox" / "InputBox").

A small always-on-top window. Stop still works while it is open, and it can close by itself
after some seconds so an unattended robot never waits forever.
"""

from __future__ import annotations

import contextlib
import logging
import time
from typing import Any

from ..catalog import OutputDef, Param, Params, activity
from ..errors import RunCancelled
from ..runtime.context import RunContext
from ..values import to_text

log = logging.getLogger("autoflow.dialogs")

C = "Control"


def _close_after() -> Any:
    return Param(
        0, title="Close by itself after (seconds)", ge=0, le=86_400, ui="duration",
        description="0 waits until someone answers. Use a time on robots nobody watches.",
    )


class MessageParams(Params):
    message: str = Param(title="Message", ui="multiline", placeholder="All {{COUNT(rows)}} invoices were entered.")
    title: str = Param("Autoflow", title="Window title", advanced=True)
    close_after: float = _close_after()


@activity(
    "control.message",
    title="Show message",
    category=C,
    icon="message-square",
    sentence="Show message {message}",
    description="Show a message to the person at the computer and wait for OK.",
    params=MessageParams,
)
def show_message(ctx: RunContext, p: MessageParams) -> None:
    ctx.log(f"Message: {to_text(p.message)}")
    _dialog(ctx, to_text(p.title) or "Autoflow", to_text(p.message), None, p.close_after)


class AskParams(Params):
    question: str = Param(title="Question", placeholder="Which month should be processed?")
    default: str = Param("", title="Answer when nobody types one")
    title: str = Param("Autoflow", title="Window title", advanced=True)
    close_after: float = _close_after()


@activity(
    "control.ask",
    title="Ask for a value",
    category=C,
    icon="message-square-text",
    sentence="Ask {question}",
    description="Ask the person at the computer to type a value (e.g. a month or a reference).",
    params=AskParams,
    outputs=[OutputDef("answer", "Answer", "text", default_variable="answer")],
)
def ask(ctx: RunContext, p: AskParams) -> str:
    answer = _dialog(ctx, to_text(p.title) or "Autoflow", to_text(p.question), to_text(p.default), p.close_after)
    return answer if answer is not None else to_text(p.default)


def _dialog(ctx: RunContext, title: str, text: str, default: str | None, close_after: float) -> str | None:
    """Show the window; returns the typed answer (questions), or None when it closed by itself."""
    try:
        import tkinter as tk
    except Exception:  # no Tk on this computer: carry on with the default
        ctx.log("No screen to show the window on; carried on without it.", "warning")
        return None
    try:
        root = tk.Tk()
    except Exception as exc:  # no desktop session (e.g. a locked robot)
        ctx.log(f"Could not show the window ({exc}); carried on without it.", "warning")
        return None
    result: dict[str, Any] = {"done": False, "value": None}
    try:
        root.title(title)
        root.attributes("-topmost", True)
        root.resizable(False, False)
        frame = tk.Frame(root, padx=18, pady=14)
        frame.pack(fill="both", expand=True)
        tk.Label(frame, text=text, justify="left", wraplength=420, font=("Segoe UI", 10)).pack(anchor="w")
        entry = None
        if default is not None:
            entry = tk.Entry(frame, width=48, font=("Segoe UI", 10))
            entry.insert(0, default)
            entry.pack(fill="x", pady=(10, 0))
            entry.focus_set()
        countdown = tk.Label(frame, text="", fg="#6b7280", font=("Segoe UI", 8))
        countdown.pack(anchor="w", pady=(8, 0))

        def ok(_event: Any = None) -> None:
            result.update(done=True, value=entry.get() if entry is not None else "")

        buttons = tk.Frame(frame)
        buttons.pack(anchor="e", pady=(6, 0))
        tk.Button(buttons, text="OK", width=10, command=ok, default="active").pack(side="right")
        root.bind("<Return>", ok)
        root.protocol("WM_DELETE_WINDOW", ok)
        root.update_idletasks()
        x = (root.winfo_screenwidth() - root.winfo_reqwidth()) // 2
        y = (root.winfo_screenheight() - root.winfo_reqheight()) // 3
        root.geometry(f"+{x}+{y}")
        root.focus_force()

        deadline = time.monotonic() + close_after if close_after > 0 else None
        while not result["done"]:
            if ctx.control.cancelled:
                raise RunCancelled()
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    ctx.log("Nobody answered; the window closed by itself.")
                    return None
                countdown.configure(text=f"Closes by itself in {int(left) + 1} s")
            root.update()
            time.sleep(0.03)
        return result["value"]
    finally:
        with contextlib.suppress(Exception):
            root.destroy()
