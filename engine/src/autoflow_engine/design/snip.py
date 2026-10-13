"""Capture part of the screen: the screen freezes, the person draws a box with the mouse.

Used for the pictures that image steps look for, and for areas that text recognition reads.
Runs Tk on its own thread so the JSON-RPC loop stays responsive.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Callable
from typing import Any

from ..selectors.screen import grab, to_png_data_uri, virtual_screen

log = logging.getLogger("autoflow.design.snip")

Respond = Callable[..., None]


class Snipper:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()

    def snip(self, respond: Respond) -> None:
        self.cancel()
        if self._thread:
            self._thread.join(2)
        self._cancel.clear()
        self._thread = threading.Thread(target=self._run, args=(respond,), name="snip", daemon=True)
        self._thread.start()

    def cancel(self) -> None:
        self._cancel.set()

    def _run(self, respond: Respond) -> None:
        try:
            respond(result=self._capture())
        except Exception as exc:
            log.exception("capture failed")
            respond(error=exc)

    def _capture(self) -> dict[str, Any] | None:
        import tkinter as tk

        from PIL import ImageEnhance, ImageTk

        left, top, right, bottom = virtual_screen()
        shot = grab((left, top, right, bottom))
        root = tk.Tk()
        try:
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.geometry(f"{right - left}x{bottom - top}+{left}+{top}")
            dim = ImageTk.PhotoImage(ImageEnhance.Brightness(shot).enhance(0.55), master=root)
            canvas = tk.Canvas(root, highlightthickness=0, cursor="crosshair")
            canvas.pack(fill="both", expand=True)
            canvas.create_image(0, 0, image=dim, anchor="nw")
            canvas.create_text(
                (right - left) // 2, 24, fill="#ffffff", font=("Segoe UI", 12, "bold"),
                text="Draw a box around the part you want - Esc cancels",
            )
            state: dict[str, Any] = {"start": None, "rect": None, "box": None, "done": False}
            bright: dict[str, Any] = {}

            def press(e: Any) -> None:
                state["start"] = (e.x, e.y)

            def move(e: Any) -> None:
                if not state["start"]:
                    return
                x0, y0 = state["start"]
                box = (min(x0, e.x), min(y0, e.y), max(x0, e.x), max(y0, e.y))
                if state["rect"] is not None:
                    canvas.delete(state["rect"])
                    canvas.delete(bright.pop("image", None) or "")
                if box[2] - box[0] > 1 and box[3] - box[1] > 1:
                    bright["photo"] = ImageTk.PhotoImage(shot.crop(box), master=root)  # the chosen part, not dimmed
                    bright["image"] = canvas.create_image(box[0], box[1], image=bright["photo"], anchor="nw")
                state["rect"] = canvas.create_rectangle(*box, outline="#e11d48", width=2)
                state["box"] = box

            def release(_e: Any) -> None:
                box = state["box"]
                if box and box[2] - box[0] >= 4 and box[3] - box[1] >= 4:
                    state["done"] = True
                else:
                    state["start"] = None  # a click, not a box: keep waiting

            canvas.bind("<ButtonPress-1>", press)
            canvas.bind("<B1-Motion>", move)
            canvas.bind("<ButtonRelease-1>", release)
            root.bind("<Escape>", lambda _e: self._cancel.set())
            root.focus_force()
            while not state["done"] and not self._cancel.is_set():
                root.update()
                self._cancel.wait(0.02)
            if not state["done"]:
                return None
            x0, y0, x1, y1 = state["box"]
        finally:
            with contextlib.suppress(Exception):
                root.destroy()
        picture = shot.crop((x0, y0, x1, y1))
        ax, ay = left + x0, top + y0
        return {
            "image": to_png_data_uri(picture),
            "x": ax, "y": ay, "width": x1 - x0, "height": y1 - y0,
            "screen": {"x": left, "y": top},
            "window": _window_at(ax + (x1 - x0) // 2, ay + (y1 - y0) // 2),
        }


def _window_at(x: int, y: int) -> dict[str, Any] | None:
    """The program window at a point (to measure areas from its corner)."""
    import os

    from ..selectors.desktop import process_name, top_window, uia

    auto = uia()
    with auto.UIAutomationInitializerInThread():
        control = auto.ControlFromPoint(x, y)
        if control is None:
            return None
        window = top_window(control)
        if window.ProcessId in {os.getpid(), os.getppid()}:
            return None
        r = window.BoundingRectangle
        return {"title": window.Name or "", "process": process_name(window.ProcessId),
                "x": r.left, "y": r.top, "width": r.width(), "height": r.height()}
