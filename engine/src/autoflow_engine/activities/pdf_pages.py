"""More PDF steps (Brity "PDF" library): search, pages as pictures, pictures inside a PDF."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import to_text
from .pdf import P, _open, _page_numbers, _pdf


class SearchParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    text: str = Param(title="Text", placeholder="Invoice total")
    match_case: bool = Param(False, title="Match upper / lower case", advanced=True)


@activity(
    "pdf.search_text",
    title="Search PDF",
    category=P,
    icon="file-search",
    sentence="Search {file} for {text}",
    description="On which pages a word or phrase appears (Brity SearchTextFromPdf).",
    params=SearchParams,
    outputs=[
        OutputDef("pages", "Pages", "list", default_variable="pages_found"),
        OutputDef("count", "Times found", "number", default_variable="times_found"),
    ],
)
def search_text(ctx: RunContext, p: SearchParams) -> dict[str, Any]:
    needle = to_text(p.text)
    if not needle.strip():
        raise ActivityError("There is no text to search for.")
    if not p.match_case:
        needle = needle.casefold()
    pages: list[int] = []
    count = 0
    with _open(_pdf(p.file)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            text = " ".join((page.extract_text() or "").split())
            found = (text if p.match_case else text.casefold()).count(" ".join(needle.split()))
            if found:
                pages.append(number)
                count += found
    return {"pages": pages, "count": count}


class ToImagesParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    folder: str = Param(title="Save the pictures in", ui="folder")
    pages: str = Param("all", title="Pages", placeholder="all, 1, 1-3, 2,5")
    resolution: int = Param(150, title="Sharpness (dpi)", ge=50, le=600, advanced=True)


@activity(
    "pdf.to_images",
    title="PDF pages to pictures",
    category=P,
    icon="file-image",
    sentence="Save the pages of {file} as pictures",
    description="Save PDF pages as PNG pictures, e.g. to attach to an email (Brity ExportPdfToImage).",
    params=ToImagesParams,
    outputs=[OutputDef("files", "Pictures", "list", default_variable="page_images")],
)
def to_images(ctx: RunContext, p: ToImagesParams) -> list[str]:
    path = _pdf(p.file)
    folder = Path(to_text(p.folder)).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    with _open(path) as pdf:
        for index in _page_numbers(p.pages, len(pdf.pages)):
            target = folder / f"{path.stem} - page {index + 1}.png"
            pdf.pages[index].to_image(resolution=p.resolution).original.save(target)
            files.append(str(target))
    return files


class ExtractImagesParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    folder: str = Param(title="Save the pictures in", ui="folder")


@activity(
    "pdf.extract_images",
    title="Save pictures in a PDF",
    category=P,
    icon="images",
    sentence="Save the pictures inside {file}",
    description="Save the pictures a PDF contains (logos, photos, stamps) as files (Brity ExtractImageFromPdf).",
    params=ExtractImagesParams,
    outputs=[OutputDef("files", "Pictures", "list", default_variable="pdf_images")],
)
def extract_images(ctx: RunContext, p: ExtractImagesParams) -> list[str]:
    from pypdf import PdfReader

    path = _pdf(p.file)
    folder = Path(to_text(p.folder)).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    try:
        reader = PdfReader(path)
    except Exception as exc:
        raise ActivityError(f"'{path.name}' could not be opened as a PDF: {exc}") from None
    for number, page in enumerate(reader.pages, start=1):
        for i, image in enumerate(page.images, start=1):
            suffix = Path(image.name).suffix or ".png"
            target = folder / f"{path.stem} - page {number} - {i}{suffix}"
            target.write_bytes(image.data)
            files.append(str(target))
    return files
