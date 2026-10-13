"""Command line entry point: ``autoflow-engine <command>``.

  catalog  [--out DIR]       write activity-catalog.json and flow.schema.json
  validate FLOW.json         print problems found in a flow
  run      FLOW.json         run a flow, printing events as JSON lines
  rpc                        JSON-RPC server on stdin/stdout (used by Studio)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
from pathlib import Path

from . import __version__, catalog
from .errors import AutoflowError
from .flow import Flow
from .runtime.context import RunControl, RunOptions
from .runtime.interpreter import FlowRunner
from .validation import validate_flow
from .values import Credential


def _load_json(value: str) -> dict:
    if value.startswith("@"):
        return json.loads(Path(value[1:]).read_text(encoding="utf-8"))
    return json.loads(value)


def cmd_catalog(args: argparse.Namespace) -> int:
    data = catalog.export_catalog()
    schema = Flow.model_json_schema()
    if not args.out:
        json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, content in (("activity-catalog.json", data), ("flow.schema.json", schema)):
        text = json.dumps(content, indent=2, ensure_ascii=False) + "\n"
        (out / name).write_text(text, encoding="utf-8", newline="\n")  # LF on every OS so CI diffs stay clean
    print(f"Wrote {len(data['activities'])} activities to {out}", file=sys.stderr)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    issues = validate_flow(_load_json("@" + args.flow))
    for issue in issues:
        where = f" [{issue.step_id}{'.' + issue.field if issue.field else ''}]" if issue.step_id else ""
        print(f"{issue.severity.upper()}{where}: {issue.message}")
    return 1 if any(i.severity == "error" for i in issues) else 0


def cmd_run(args: argparse.Namespace) -> int:
    flow = Flow.model_validate(_load_json("@" + args.flow))
    work_dir = Path(args.work_dir) if args.work_dir else Path(tempfile.mkdtemp(prefix="autoflow-run-"))
    credentials = None
    if args.credentials_stdin:
        # Robots pass passwords through stdin so they never touch the disk or the command line.
        secrets = json.loads(sys.stdin.readline() or "{}")

        def credentials(name: str) -> Credential:
            entry = secrets.get(name) or next((v for k, v in secrets.items() if k.lower() == name.lower()), None)
            if not entry:
                raise AutoflowError(f"Credential '{name}' was not found in the Orchestrator vault.",
                                    "Ask a builder to add it under Credentials in the dashboard.")
            return Credential(name, entry.get("username", ""), entry.get("password", ""))

    options = RunOptions(work_dir=work_dir, inputs=_load_json(args.inputs) if args.inputs else {},
                         headless=args.headless, credentials=credentials)
    control = RunControl()
    if args.cancel_file:
        _watch_cancel_file(Path(args.cancel_file), control)
    if args.repair_stdin or args.ai_stdin:
        bridge = _StdinRequests(control)
        if args.repair_stdin:
            options.repair = lambda request: bridge("repair_request", request)
        if args.ai_stdin:
            options.ai = lambda request: bridge("ai_request", request)

    def emit(event: dict) -> None:
        if args.quiet and event["event"] not in ("run_finished", "log"):
            return
        print(json.dumps(event, default=str, ensure_ascii=False), flush=True)

    result = FlowRunner(flow, options, emit, control=control).run()
    return 0 if result.status == "succeeded" else 1


class _StdinRequests:
    """Questions for the robot (AI repair, AI step): a ``repair_request`` / ``ai_request`` line goes
    out on stdout and the robot answers with ``{"id": ..., "reply": {...}}`` on stdin after asking
    the Orchestrator (or ``{"cancel": true}`` when the run is stopped meanwhile).

    stdin is read only while waiting for an answer, never by a background thread: on Windows
    a pending read on a pipe blocks loading DLLs (numpy, OCR...) in every other thread.
    """

    def __init__(self, control: RunControl):
        self._control = control
        self._next = 0

    def __call__(self, event: str, request: dict) -> dict | None:
        from .errors import RunCancelled

        self._next += 1
        request_id = self._next
        print(json.dumps({"event": event, "id": request_id, "request": request},
                         default=str, ensure_ascii=False), flush=True)
        while True:
            line = sys.stdin.readline()
            if not line:
                raise AutoflowError("The robot stopped answering questions to the AI assistant.")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("cancel") or self._control.cancelled:
                raise RunCancelled()
            if message.get("id") == request_id:
                if message.get("error"):
                    raise AutoflowError(str(message["error"]))
                return message.get("reply")


def _watch_cancel_file(path: Path, control: RunControl) -> None:
    """Stop the run gracefully when the robot creates this file (then cleanup still happens)."""
    import threading
    import time

    def watch() -> None:
        while not control.cancelled:
            if path.exists():
                control.cancel()
                return
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="autoflow-engine", description="Autoflow automation engine")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("catalog", help="export the activity catalog")
    p.add_argument("--out", help="folder to write JSON files to (default: print catalog)")
    p.set_defaults(func=cmd_catalog)

    p = sub.add_parser("validate", help="check a flow for problems")
    p.add_argument("flow")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("run", help="run a flow")
    p.add_argument("flow")
    p.add_argument("--inputs", help="JSON object or @file.json with start values")
    p.add_argument("--work-dir", help="folder for screenshots and downloads")
    p.add_argument("--headless", action="store_true", help="hide browser windows")
    p.add_argument("--quiet", action="store_true", help="only print logs and the final result")
    p.add_argument("--credentials-stdin", action="store_true", help="read credentials JSON from the first stdin line")
    p.add_argument("--cancel-file", help="stop the run when this file appears")
    p.add_argument("--repair-stdin", action="store_true",
                   help="AI self-repair: print repair_request events and read replies from stdin")
    p.add_argument("--ai-stdin", action="store_true",
                   help="AI step: print ai_request events and read replies from stdin")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("rpc", help="JSON-RPC server on stdio (used by Studio)")
    p.set_defaults(func=lambda _a: (__import__("autoflow_engine.rpc").rpc.serve_stdio(), 0)[1])

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    return args.func(args)
