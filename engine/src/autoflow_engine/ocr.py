"""Text recognition (OCR) for scanned documents and images, fully offline.

Uses RapidOCR (ONNX models shipped inside the package), so it runs on an ordinary
CPU without internet access or a GPU.
"""

from __future__ import annotations

import threading
from typing import Any

from .errors import ActivityError

_engine: Any = None
_lock = threading.Lock()


def _get_engine() -> Any:
    global _engine
    with _lock:
        if _engine is None:
            try:
                from rapidocr import RapidOCR
            except ImportError:  # pragma: no cover - packaging problem
                raise ActivityError("Text recognition (OCR) is not installed on this computer.") from None
            _engine = RapidOCR()
        return _engine


def read_image(image: Any) -> str:
    """Recognise the text of a PIL image (or file path), as lines top to bottom."""
    import numpy as np
    from PIL import Image

    if not isinstance(image, Image.Image):
        image = Image.open(image)
    array = np.array(image.convert("RGB"))
    result = _get_engine()(array)
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    if boxes is None or texts is None or len(texts) == 0:
        return ""
    return _to_lines(list(zip(boxes, texts, strict=False)))


def _to_lines(items: list[tuple[Any, str]]) -> str:
    """Group recognised words into lines by their vertical position, then order left to right."""
    words = []
    for box, text in items:
        ys = [float(p[1]) for p in box]
        xs = [float(p[0]) for p in box]
        words.append({"top": min(ys), "bottom": max(ys), "left": min(xs), "text": str(text)})
    words.sort(key=lambda w: (w["top"], w["left"]))
    lines: list[list[dict[str, Any]]] = []
    for word in words:
        middle = (word["top"] + word["bottom"]) / 2
        for line in lines:
            ref = line[0]
            if ref["top"] <= middle <= ref["bottom"]:
                line.append(word)
                break
        else:
            lines.append([word])
    return "\n".join(" ".join(w["text"] for w in sorted(line, key=lambda w: w["left"])) for line in lines)
