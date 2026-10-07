"""Build a portable Python runtime with the Autoflow engine (and optionally the robot) installed.

    python deploy/build/bundle_python.py --out build/python-studio
    python deploy/build/bundle_python.py --out build/python-robot --robot

Uses a uv-managed CPython (python-build-standalone, which is relocatable), copies it
to --out and installs the engine's wheel and dependencies into it. The result runs on
PCs without Python: Studio ships it as resources/engine/python, the robot bundle as
python/.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON_VERSION = "3.13"


def uv() -> str:
    found = os.environ.get("UV") or shutil.which("uv")
    if found:
        return found
    try:
        import uv as uv_module  # pip install uv

        return uv_module.find_uv_bin()
    except ImportError:
        sys.exit("uv is required: https://docs.astral.sh/uv/")


def run(*args: str, cwd: Path | None = None) -> str:
    print("+", " ".join(args), flush=True)
    result = subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--robot", action="store_true", help="also install the robot agent")
    args = parser.parse_args()
    out: Path = args.out.resolve()
    tool = uv()

    run(tool, "python", "install", PYTHON_VERSION)
    interpreter = Path(run(tool, "python", "find", "--python-preference", "only-managed", PYTHON_VERSION))
    source = interpreter.parent
    print(f"Base interpreter: {source}")

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(source, out, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # A uv-managed Python is marked "externally managed"; this copy is ours to fill.
    for marker in out.rglob("EXTERNALLY-MANAGED"):
        marker.unlink()

    wheels = ROOT / "build" / "wheels"
    if wheels.exists():
        shutil.rmtree(wheels)
    run(tool, "build", "--wheel", "--out-dir", str(wheels), str(ROOT / "engine"))
    if args.robot:
        run(tool, "build", "--wheel", "--out-dir", str(wheels), str(ROOT / "robot"))

    python = out / "python.exe"
    packages = [str(w) for w in sorted(wheels.glob("*.whl"))]
    # The robot wheel depends on "autoflow-engine" by name; the local engine wheel satisfies it.
    run(tool, "pip", "install", "--python", str(python), "--no-cache", "--link-mode", "copy", *packages)

    # Smoke test the bundle from a neutral working directory.
    version = run(str(python), "-m", "autoflow_engine", "--version", cwd=out.parent)
    print(f"Engine {version} bundled in {out}")
    if args.robot:
        print(run(str(python), "-m", "autoflow_robot.cli", "--version", cwd=out.parent))
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1024 / 1024
    print(f"Bundle size: {size:.0f} MB")


if __name__ == "__main__":
    main()
