"""Finding pictures and text on the screen (Brity "ImageRecognition" and "OCR" libraries).

For anything that is only drawn - Citrix and remote desktops, charts, old programs - where there
are no controls to point at. Coordinates are physical screen pixels across all monitors.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import ActivityError
from ..runtime.context import Deadline, wait

# Pictures are also looked for a little smaller and larger: another PC may scale its screen.
SCALES = (1.0, 0.9, 1.1, 0.8, 1.25, 0.75, 1.5)
Area = tuple[int, int, int, int]  # left, top, right, bottom


@dataclass(frozen=True)
class Match:
    x: int
    y: int
    width: int
    height: int
    score: float = 1.0

    @property
    def centre(self) -> tuple[int, int]:
        return self.x + self.width // 2, self.y + self.height // 2

    def point(self, offset: tuple[int, int] | None) -> tuple[int, int]:
        """A point inside the match: its centre, or an offset from its top-left corner."""
        return (self.x + offset[0], self.y + offset[1]) if offset else self.centre


def virtual_screen() -> Area:
    """All monitors together: left, top, right, bottom (left / top can be negative)."""
    import ctypes

    m = ctypes.windll.user32.GetSystemMetrics
    left, top, width, height = m(76), m(77), m(78), m(79)
    return left, top, left + width, top + height


def grab(area: Area | None = None) -> Any:
    """A screenshot (PIL image) of an area of the screen, or of all monitors."""
    from PIL import ImageGrab

    from .desktop import uia

    uia()  # makes the process DPI aware first, so pixels are real pixels
    return ImageGrab.grab(bbox=area or virtual_screen(), all_screens=True)


def to_png_data_uri(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def load_image(value: str) -> Any:
    """A picture given as a data URI (captured in Studio) or a file path."""
    from PIL import Image

    text = (value or "").strip()
    if not text:
        raise ActivityError("No picture was chosen.", "Use 'Capture' and draw a box around what to look for.")
    try:
        if text.startswith("data:"):
            return Image.open(io.BytesIO(base64.b64decode(text.split(",", 1)[1]))).convert("RGB")
        return Image.open(Path(text)).convert("RGB")
    except (OSError, ValueError, IndexError) as exc:
        raise ActivityError(f"The picture could not be read: {exc}") from None


def _gray(image: Any) -> Any:
    import cv2
    import numpy as np

    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2GRAY)


def find_image(template: Any, area: Area | None, confidence: float) -> Match | None:
    """Best place the picture appears on screen (inside area), if it is similar enough."""
    import cv2
    import numpy as np

    origin = (area or virtual_screen())[:2]
    screen = _gray(grab(area))
    pattern = _gray(template)
    best: Match | None = None
    for scale in SCALES:
        if scale == 1.0:
            sized = pattern
        else:
            sized = cv2.resize(pattern, None, fx=scale, fy=scale,
                               interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        h, w = sized.shape[:2]
        if h < 4 or w < 4 or h > screen.shape[0] or w > screen.shape[1]:
            continue
        scores = np.nan_to_num(cv2.matchTemplate(screen, sized, cv2.TM_CCOEFF_NORMED), nan=0.0, posinf=0.0)
        _, score, _, (x, y) = cv2.minMaxLoc(scores)
        if best is None or score > best.score:
            best = Match(origin[0] + x, origin[1] + y, w, h, float(score))
        if score >= 0.97:
            break
    return best if best is not None and best.score >= confidence else None


def wait_for_image(template: Any, area: Any, confidence: float, timeout: float, *, appear: bool = True) -> Match | None:
    """Look again until the picture is there (or gone). area: a box, or a function giving one."""
    deadline = Deadline(timeout)
    while True:
        match = find_image(template, area() if callable(area) else area, confidence)
        if (match is not None) == appear:
            return match
        if deadline.passed:
            return match if not appear else None
        wait(0.3)


# -- text --------------------------------------------------------------------------------------------


def find_text(text: str, area: Area | None, occurrence: int = 1) -> Match | None:
    """Where a text is written on screen (read with OCR), ignoring upper / lower case."""
    from ..ocr import read_words

    needle = " ".join(text.split()).casefold()
    if not needle:
        raise ActivityError("No text to look for was given.")
    origin = (area or virtual_screen())[:2]
    found: list[Match] = []
    for word in read_words(grab(area)):
        hay = " ".join(word.text.split()).casefold()
        start = hay.find(needle)
        if start < 0:
            continue
        # The recogniser returns phrases: estimate where the text sits inside the phrase.
        per_char = (word.right - word.left) / max(len(hay), 1)
        left = word.left + per_char * start
        found.append(Match(int(origin[0] + left), int(origin[1] + word.top),
                           max(int(per_char * len(needle)), 1), max(int(word.bottom - word.top), 1), word.score))
    found.sort(key=lambda m: (m.y // 10, m.x))  # reading order
    return found[occurrence - 1] if 0 < occurrence <= len(found) else None


def wait_for_text(text: str, area: Any, timeout: float, *, appear: bool = True, occurrence: int = 1) -> Match | None:
    deadline = Deadline(timeout)
    while True:
        match = find_text(text, area() if callable(area) else area, occurrence)
        if (match is not None) == appear:
            return match
        if deadline.passed:
            return match if not appear else None
        wait(0.5)
