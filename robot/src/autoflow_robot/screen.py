"""Live screen view: while someone watches this robot in the dashboard, send a small picture of the
screen every second or two. Nothing is sent when nobody watches, and robots can turn it off
(screen_view: false in robot.json)."""

from __future__ import annotations

import base64
import io
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

log = logging.getLogger("autoflow.robot.screen")

SendFn = Callable[[dict[str, Any]], None]
FRAME_S = 1.5
MAX_WATCH_S = 60
MAX_WIDTH = 1280


def capture_jpeg(max_width: int = MAX_WIDTH, quality: int = 60) -> tuple[bytes, int, int]:
    from PIL import ImageGrab

    image = ImageGrab.grab(all_screens=True).convert("RGB")
    if image.width > max_width:
        image = image.resize((max_width, round(image.height * max_width / image.width)))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=quality, optimize=True)
    return out.getvalue(), image.width, image.height


class ScreenStreamer:
    def __init__(self, send: SendFn, enabled: bool = True, capture: Callable[[], tuple[bytes, int, int]] = capture_jpeg):
        self.send = send
        self.enabled = enabled
        self.capture = capture
        self._until = 0.0
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def watch(self, seconds: float) -> None:
        """Someone is looking: keep sending frames for this long (each request extends it)."""
        if not self.enabled:
            self.send({"type": "screen.unavailable", "reason": "The screen view is turned off on this robot."})
            return
        with self._lock:
            self._until = time.monotonic() + min(max(float(seconds), 1.0), MAX_WATCH_S)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="screen-view", daemon=True)
                self._thread.start()

    def stop(self) -> None:
        self._until = 0.0

    def _run(self) -> None:
        while time.monotonic() < self._until:
            started = time.monotonic()
            try:
                data, width, height = self.capture()
                self.send({"type": "screen.frame", "data": base64.b64encode(data).decode("ascii"),
                           "width": width, "height": height})
            except Exception as exc:  # e.g. the session is locked: say so instead of going quiet
                log.warning("screen capture failed: %s", exc)
                self.send({"type": "screen.unavailable", "reason": f"The screen can't be captured right now ({exc})."})
                time.sleep(5)
            time.sleep(max(0.0, FRAME_S - (time.monotonic() - started)))
