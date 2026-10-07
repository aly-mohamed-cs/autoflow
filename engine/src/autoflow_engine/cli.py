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
from .flow import Flow
from .runtime.context import RunOptions
from .runtime.interpreter import FlowRunner
from .validation import validate_flow


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
    options = RunOptions(work_dir=work_dir, inputs=_load_json(args.inputs) if args.inputs else {},
                         headless=args.headless)

    def emit(event: dict) -> None:
        if args.quiet and event["event"] not in ("run_finished", "log"):
            return
        print(json.dumps(event, default=str, ensure_ascii=False), flush=True)

    result = FlowRunner(flow, options, emit).run()
    return 0 if result.status == "succeeded" else 1


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
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("rpc", help="JSON-RPC server on stdio (used by Studio)")
    p.set_defaults(func=lambda _a: (__import__("autoflow_engine.rpc").rpc.serve_stdio(), 0)[1])

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    return args.func(args)
