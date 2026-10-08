"""autoflow-robot: enroll this computer and keep it running automations.

  autoflow-robot enroll --server https://rpa.company.local:8443 --key afe_...
  autoflow-robot run            # connect and wait for jobs (started at logon)
  autoflow-robot status         # show the saved settings
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from logging.handlers import RotatingFileHandler

from .config import RobotConfig, __version__, home


def _setup_logging(verbose: bool) -> None:
    logs = home() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(logs / "robot.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"),
        logging.StreamHandler(sys.stderr),
    ]
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def cmd_enroll(args: argparse.Namespace) -> int:
    from .agent import enroll

    config = enroll(args.server, args.key, args.name, trust_certificate=args.trust_certificate)
    print(f"Enrolled as “{config.name}” in pool “{config.pool}”. Settings saved to {home()}.")
    print("Start it with:  autoflow-robot run   (install-robot.ps1 sets this up to start at sign-in)")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    from .agent import Agent
    from .updater import mark_started

    _setup_logging(args.verbose)
    config = RobotConfig.load()
    logging.getLogger("autoflow.robot").info("Autoflow Robot %s starting (%s)", __version__, config.name)
    mark_started()  # after a self-update, tells apply-update.ps1 the new version came up
    agent = Agent(config)
    agent.updater.cleanup()
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        agent.stop()
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    try:
        config = RobotConfig.load()
    except FileNotFoundError as exc:
        print(exc)
        return 1
    print(f"Robot:   {config.name} ({config.robot_id})")
    print(f"Server:  {config.server_url}")
    print(f"Pool:    {config.pool}")
    print(f"Pinned certificate: {'yes' if config.pinned_cert else 'no (uses Windows trust)'}")
    print(f"Data:    {home()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="autoflow-robot", description="Autoflow Robot")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("enroll", help="connect this computer to the Orchestrator")
    p.add_argument("--server", required=True, help="Orchestrator address, e.g. https://rpa.company.local:8443")
    p.add_argument("--key", required=True, help="one-time enrollment key from the dashboard")
    p.add_argument("--name", help="robot name shown in the dashboard (default: computer name)")
    p.add_argument("--trust-certificate", action="store_true", help="trust the server's self-signed certificate")
    p.set_defaults(func=cmd_enroll)

    p = sub.add_parser("run", help="connect and run jobs")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("status", help="show settings")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
