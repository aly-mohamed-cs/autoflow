"""Errors raised while running flows, and their translation into plain language.

Non-technical users read these messages, so every error carries a short message
("Couldn't find the file 'report.xlsx'") and, where possible, a hint telling them
what to do next.
"""

from __future__ import annotations

from pydantic import ValidationError


class AutoflowError(Exception):
    """Base for errors that carry a user-facing message and an optional hint."""

    def __init__(self, message: str, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint


class ActivityError(AutoflowError):
    """Raised by activities for expected failures (missing file, element not found...)."""


class ExpressionError(AutoflowError):
    """A formula or {{value}} reference could not be evaluated."""


class StepFailed(Exception):
    """A step failed after its retries. Bubbles up through parent blocks untouched."""

    def __init__(self, step_id: str, activity: str, error: AutoflowError):
        super().__init__(error.message)
        self.step_id = step_id
        self.activity = activity
        self.error = error


class FlowControl(Exception):  # noqa: N818 - control-flow signal, not an error
    """Base for loop/flow control signals; never treated as a failure."""


class BreakLoop(FlowControl):
    pass


class ContinueLoop(FlowControl):
    pass


class StopFlow(FlowControl):
    def __init__(self, succeeded: bool, message: str = ""):
        super().__init__(message)
        self.succeeded = succeeded
        self.message = message


class RunCancelled(Exception):
    pass


_HINTS: list[tuple[type[BaseException], str]] = [
    (FileNotFoundError, "Check that the file or folder exists and that the path is spelled correctly."),
    (
        PermissionError,
        "The file may be open in another program (for example Excel), or the robot account "
        "may not have access to it.",
    ),
    (IsADirectoryError, "A folder was given where a file was expected."),
    (NotADirectoryError, "A file was given where a folder was expected."),
    (TimeoutError, "The action took too long. Try increasing the wait time."),
    (ConnectionError, "Check the network connection and that the address is correct."),
]


def friendly(exc: BaseException) -> AutoflowError:
    """Convert any exception into an AutoflowError with a readable message."""
    if isinstance(exc, AutoflowError):
        return exc
    if isinstance(exc, ValidationError):
        return _from_validation(exc)
    hint = next((h for t, h in _HINTS if isinstance(exc, t)), None)
    if isinstance(exc, OSError) and exc.filename:
        reason = exc.strerror or type(exc).__name__
        return AutoflowError(f"{reason}: {exc.filename}", hint)
    message = str(exc).strip() or type(exc).__name__
    return AutoflowError(message, hint)


def _from_validation(exc: ValidationError) -> AutoflowError:
    problems = []
    for err in exc.errors():
        field = ".".join(str(p) for p in err["loc"]) or "value"
        label = field.replace("_", " ")
        if err["type"] == "missing":
            problems.append(f"'{label}' is required")
        else:
            problems.append(f"'{label}': {err['msg']}")
    return AutoflowError(
        "This step's settings are not valid: " + "; ".join(problems) + ".",
        "Open the step and fill in the highlighted settings.",
    )
