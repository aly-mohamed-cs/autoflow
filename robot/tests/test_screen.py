"""Live screen view on the robot."""

from __future__ import annotations

import base64
import time

from autoflow_robot import screen
from autoflow_robot.screen import ScreenStreamer, capture_jpeg


def _wait(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def test_frames_are_sent_only_while_someone_watches(monkeypatch):
    monkeypatch.setattr(screen, "FRAME_S", 0.05)
    sent: list[dict] = []
    streamer = ScreenStreamer(sent.append, capture=lambda: (b"jpeg", 640, 360))
    streamer.watch(1)
    _wait(lambda: len(sent) >= 3)
    assert sent[0] == {"type": "screen.frame", "data": base64.b64encode(b"jpeg").decode(), "width": 640, "height": 360}
    _wait(lambda: not streamer._thread.is_alive(), timeout=3)  # stops by itself when nobody asks again
    count = len(sent)
    time.sleep(0.2)
    assert len(sent) == count


def test_a_robot_can_turn_the_screen_view_off():
    sent: list[dict] = []
    ScreenStreamer(sent.append, enabled=False, capture=lambda: (b"never", 1, 1)).watch(20)
    assert sent == [{"type": "screen.unavailable", "reason": "The screen view is turned off on this robot."}]


def test_a_capture_problem_is_reported_instead_of_going_quiet(monkeypatch):
    monkeypatch.setattr(screen.time, "sleep", lambda _s: None)
    sent: list[dict] = []

    def locked():
        raise OSError("screen grab failed")

    streamer = ScreenStreamer(sent.append, capture=locked)
    streamer.watch(1)
    _wait(lambda: bool(sent))
    streamer.stop()
    assert sent[0]["type"] == "screen.unavailable" and "screen grab failed" in sent[0]["reason"]


def test_capture_makes_a_small_jpeg():
    data, width, height = capture_jpeg(max_width=320)
    assert data[:2] == b"\xff\xd8" and width <= 320 and height > 0
