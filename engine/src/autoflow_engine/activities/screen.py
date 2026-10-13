"""Pictures and text on the screen: for programs without controls to point at (Citrix and remote
desktops, charts, drawings). Brity RPA's "ImageRecognition" and "OCR" libraries."""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..selectors import screen
from ..values import parse_point, to_text

S = "Screen"


class AreaParams(Params):
    look_in: Literal["screen", "window"] = Param(
        "screen", title="Look in", labels={"screen": "The whole screen", "window": "A window"},
    )
    window: str = Param(
        "", title="Window title contains", placeholder="(the window in front)", show_when={"look_in": ["window"]},
    )
    process: str = Param(
        "", title="Program", placeholder="EXCEL.EXE", advanced=True, show_when={"look_in": ["window"]},
        description="The program the window belongs to. Helps find it when its title changes.",
    )
    timeout: float | None = Param(None, title="Wait up to (seconds)", ge=0, le=3600, advanced=True)


def _timeout(ctx: RunContext, p: AreaParams) -> float:
    return p.timeout if p.timeout is not None else ctx.flow.settings.default_timeout


def _area(ctx: RunContext, p: AreaParams) -> screen.Area | None:
    """Where to look: a window (brought to the front) or the whole screen."""
    if p.look_in == "screen":
        return None
    from ..selectors.desktop import find_window
    from .desktop import _init

    auto = _init(ctx)
    if p.window or p.process:
        window = find_window({"window": p.window, "process": p.process}, _timeout(ctx, p), ctx.log)
    else:
        window = auto.GetForegroundControl()
        window = window.GetTopLevelControl() if window is not None else None
        if window is None:
            raise ActivityError("No window is in front.", "Enter the title of the window to look in.")
    with contextlib.suppress(Exception):
        window.SetActive(waitTime=0.1)
    r = window.BoundingRectangle
    return r.left, r.top, r.right, r.bottom


def _region(area: screen.Area | None, region: str) -> screen.Area | None:
    """Part of the area: "x, y, width, height" measured from its top-left corner."""
    if not region.strip():
        return area
    parts = [p for p in region.replace(";", ",").replace(" ", ",").split(",") if p.strip()]
    try:
        x, y, w, h = (round(float(p)) for p in parts)
    except ValueError:
        raise ActivityError(f"'{region}' is not an area.", "Write it as X, Y, width, height, e.g. 10, 40, 300, 120.") from None
    left, top = (area or screen.virtual_screen())[:2]
    return left + x, top + y, left + x + w, top + y + h


def _image_param() -> Any:
    return Param(title="Picture", ui="image",
                 description="What to look for. Press 'Capture' and draw a box around it on the screen.")


def _point_param() -> Any:
    return Param(
        "", title="Point inside the picture", ui="point", placeholder="Centre",
        description="X, Y in pixels from the picture's top-left corner. Leave empty for its centre.",
    )


class ImageParams(AreaParams):
    image: str = _image_param()
    confidence: float = Param(
        0.85, title="How exact", ge=0.5, le=1, advanced=True,
        description="1 = exactly the same pixels. Lower it when colours or edges differ a little.",
    )


def _find(ctx: RunContext, p: ImageParams) -> screen.Match:
    template = screen.load_image(p.image)
    match = screen.wait_for_image(template, lambda: _area(ctx, p), p.confidence, _timeout(ctx, p))
    if match is None:
        raise ActivityError(
            "The picture was not found on the screen.",
            "Check that it is visible, capture it again, or lower 'How exact' under More options.",
        )
    ctx.log(f"Found the picture at {match.x}, {match.y} ({match.score:.0%} alike).")
    return match


class ClickImageParams(ImageParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")
    point: str = _point_param()


@activity(
    "screen.click_image",
    title="Click image",
    category=S,
    icon="image",
    sentence="Click the picture",
    description="Find a picture on the screen and click it - for buttons in remote desktops, charts or "
    "programs without controls.",
    params=ClickImageParams,
)
def click_image(ctx: RunContext, p: ClickImageParams) -> None:
    from .desktop import _mouse_click

    match = _find(ctx, p)
    x, y = match.point(parse_point(p.point) if p.point else None)
    _mouse_click(x, y, p.click)


class HoverImageParams(ImageParams):
    point: str = _point_param()


@activity(
    "screen.hover_image",
    title="Point at image",
    category=S,
    icon="pointer",
    sentence="Point at the picture",
    description="Move the mouse over a picture on the screen (e.g. to open a menu or show a tooltip).",
    params=HoverImageParams,
)
def hover_image(ctx: RunContext, p: HoverImageParams) -> None:
    from ..selectors.desktop import uia

    x, y = _find(ctx, p).point(parse_point(p.point) if p.point else None)
    uia().MoveTo(x, y, moveSpeed=2, waitTime=0.1)


class WaitImageParams(ImageParams):
    state: Literal["appears", "disappears"] = Param("appears", title="Wait until it")


@activity(
    "screen.wait_image",
    title="Wait for image",
    category=S,
    icon="image-play",
    sentence="Wait until the picture {state}",
    description="Wait until a picture shows up on the screen, or goes away (e.g. a 'Loading' sign).",
    params=WaitImageParams,
)
def wait_image(ctx: RunContext, p: WaitImageParams) -> None:
    template = screen.load_image(p.image)
    appear = p.state == "appears"
    match = screen.wait_for_image(template, lambda: _area(ctx, p), p.confidence, _timeout(ctx, p), appear=appear)
    if (match is not None) != appear:
        raise ActivityError(
            f"The picture did not {'appear' if appear else 'go away'} in time.",
            "Raise 'Wait up to' under More options, or capture the picture again.",
        )


class ImageExistsParams(ImageParams):
    timeout: float | None = Param(2, title="Wait up to (seconds)", ge=0, le=3600, advanced=True)


@activity(
    "screen.image_exists",
    title="Is image on screen",
    category=S,
    icon="image",
    sentence="Is the picture on screen",
    description="Check whether a picture is on the screen (yes / no), without failing when it is not.",
    params=ImageExistsParams,
    outputs=[OutputDef("found", "Found", "boolean", default_variable="picture_found")],
)
def image_exists(ctx: RunContext, p: ImageExistsParams) -> bool:
    template = screen.load_image(p.image)
    return screen.wait_for_image(template, lambda: _area(ctx, p), p.confidence, p.timeout or 0) is not None


# -- text on the screen (OCR) ----------------------------------------------------------------------


class RegionParams(AreaParams):
    region: str = Param(
        "", title="Only this part", ui="region", placeholder="All of it", advanced=True,
        description="X, Y, width, height in pixels from the top-left corner of the window (or screen).",
    )


@activity(
    "screen.read_text",
    title="Read text on screen",
    category=S,
    icon="scan-text",
    sentence="Read the text on the screen",
    description="Read what is written on the screen with text recognition (OCR), e.g. from a remote desktop.",
    params=RegionParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="screen_text")],
)
def read_text(ctx: RunContext, p: RegionParams) -> str:
    from ..ocr import read_image

    return read_image(screen.grab(_region(_area(ctx, p), p.region)))


class TextParams(RegionParams):
    text: str = Param(title="Text", placeholder="Save")
    occurrence: int = Param(1, title="Which one", ge=1, le=100, advanced=True,
                            description="When the text is on the screen more than once: 1 = the first (reading order).")


class ClickTextParams(TextParams):
    click: Literal["single", "double", "right"] = Param("single", title="Click type")


@activity(
    "screen.click_text",
    title="Click text on screen",
    category=S,
    icon="text-cursor",
    sentence="Click the text {text}",
    description="Find a word or phrase on the screen with text recognition (OCR) and click it.",
    params=ClickTextParams,
)
def click_text(ctx: RunContext, p: ClickTextParams) -> None:
    from .desktop import _mouse_click

    match = screen.wait_for_text(to_text(p.text), lambda: _region(_area(ctx, p), p.region), _timeout(ctx, p),
                                 occurrence=p.occurrence)
    if match is None:
        raise ActivityError(f"The text '{to_text(p.text)}' was not found on the screen.",
                            "Check that it is visible and spelled as on screen.")
    _mouse_click(*match.centre, p.click)


class WaitTextParams(TextParams):
    state: Literal["appears", "disappears"] = Param("appears", title="Wait until it")


@activity(
    "screen.wait_text",
    title="Wait for text on screen",
    category=S,
    icon="scan-search",
    sentence="Wait until {text} {state}",
    description="Wait until a word or phrase shows up on the screen, or goes away (read with OCR).",
    params=WaitTextParams,
)
def wait_text(ctx: RunContext, p: WaitTextParams) -> None:
    appear = p.state == "appears"
    match = screen.wait_for_text(to_text(p.text), lambda: _region(_area(ctx, p), p.region), _timeout(ctx, p),
                                 appear=appear, occurrence=p.occurrence)
    if (match is not None) != appear:
        raise ActivityError(f"The text '{to_text(p.text)}' did not {'appear' if appear else 'go away'} in time.")


class CaptureParams(RegionParams):
    file: str = Param(title="Save as", ui="save_file", file_types=["png"], placeholder="C:\\Reports\\screen.png")


@activity(
    "screen.capture",
    title="Take screenshot",
    category=S,
    icon="camera",
    sentence="Take a screenshot to {file}",
    description="Save a picture of the screen, a window or part of it.",
    params=CaptureParams,
    outputs=[OutputDef("file", "Screenshot", "file", default_variable="screenshot")],
)
def capture(ctx: RunContext, p: CaptureParams) -> str:
    path = Path(to_text(p.file)).expanduser()
    if path.suffix.lower() != ".png":
        path = path.with_suffix(".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    screen.grab(_region(_area(ctx, p), p.region)).save(path)
    return str(path)
