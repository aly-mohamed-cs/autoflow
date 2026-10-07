"""PDF documents: read text and tables, pull invoice fields by anchor text, merge and split.

Works with PDFs that contain text (exported from a system). Scanned PDFs (images)
need OCR, which is a separate step.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..runtime.expressions import to_number
from ..values import Table, to_text
from .text import PATTERNS

P = "PDF"


def _pdf(value: Any) -> Path:
    path = Path(to_text(value).strip().strip('"'))
    if not to_text(value).strip():
        raise ActivityError("No PDF file was given.")
    if not path.is_file():
        raise ActivityError(f"The PDF '{path}' does not exist.", "Check the path, or add a 'Wait for file' step first.")
    return path


def _open(path: Path):
    import pdfplumber

    try:
        return pdfplumber.open(path)
    except Exception as exc:
        raise ActivityError(f"'{path.name}' could not be opened as a PDF: {exc}",
                            "The file may be damaged or password-protected.") from None


def _page_numbers(spec: str, count: int) -> list[int]:
    """'all', '1', '1-3', '2,5,7-9', 'last' -> zero-based page indexes."""
    spec = to_text(spec).strip().lower() or "all"
    if spec == "all":
        return list(range(count))
    pages: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if part == "last":
            pages.append(count - 1)
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            first = int(start) if start else 1
            last = count if end in ("", "last") else int(end)
            pages.extend(range(first - 1, min(last, count)))
        elif part.isdigit():
            pages.append(int(part) - 1)
        else:
            raise ActivityError(f"'{spec}' is not a valid page list.", "Use all, 1, 1-3 or 2,5,7-9.")
    out = [p for p in pages if 0 <= p < count]
    if not out:
        raise ActivityError(f"The PDF has {count} pages; pages '{spec}' don't exist.")
    return out


OcrMode = Literal["auto", "always", "never"]
OCR_DPI = 200


def _text_of(path: Path, pages: str, ocr: OcrMode = "auto") -> str:
    """Text of the chosen pages. Scanned pages (no text inside) are read with OCR unless ocr="never"."""
    texts = []
    with _open(path) as pdf:
        for i in _page_numbers(pages, len(pdf.pages)):
            page = pdf.pages[i]
            text = "" if ocr == "always" else (page.extract_text() or "")
            if not text.strip() and ocr != "never":
                from ..ocr import read_image

                text = read_image(page.to_image(resolution=OCR_DPI).original)
            texts.append(text)
    text = "\n".join(texts).strip()
    if not text:
        raise ActivityError(
            f"No text could be read from '{path.name}'.",
            "If it is a scan, check that it is sharp and not upside down.",
        )
    return text


def _ocr_param() -> Any:
    return Param("auto", title="Scanned pages", advanced=True,
                 description="auto: read pages without text using OCR; always: OCR every page; never: text only.")


class ReadTextParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    pages: str = Param("all", title="Pages", placeholder="all, 1, 1-3, 2,5", advanced=True)
    ocr: OcrMode = _ocr_param()


@activity(
    "pdf.read_text",
    title="Read PDF text",
    category=P,
    icon="file-text",
    sentence="Read text from {file}",
    description="Get all the text of a PDF, e.g. to find values in it with 'Get text between'. Scanned pages are read with OCR.",
    params=ReadTextParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="pdf_text")],
)
def read_text(ctx: RunContext, p: ReadTextParams) -> str:
    return _text_of(_pdf(p.file), p.pages, p.ocr)


class ExtractTablesParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    pages: str = Param("all", title="Pages", placeholder="all, 1, 1-3")
    has_header: bool = Param(True, title="First row has column names")
    combine: bool = Param(True, title="Combine tables with the same columns",
                          description="Useful when one long table continues over several pages.")


@activity(
    "pdf.extract_tables",
    title="Extract table from PDF",
    category=P,
    icon="table",
    sentence="Extract table from {file}",
    description="Read the lines of a table in a PDF, such as the items of an invoice.",
    params=ExtractTablesParams,
    outputs=[OutputDef("table", "Table", "table", default_variable="pdf_table")],
)
def extract_tables(ctx: RunContext, p: ExtractTablesParams) -> Table:
    path = _pdf(p.file)
    matrices: list[list[list[Any]]] = []
    with _open(path) as pdf:
        for i in _page_numbers(p.pages, len(pdf.pages)):
            for raw in pdf.pages[i].extract_tables():
                rows = [[_cell(c) for c in row] for row in raw if any(c not in (None, "") for c in row)]
                if rows:
                    matrices.append(rows)
    if not matrices:
        raise ActivityError(f"No table was found in '{path.name}'.",
                            "If the table has no lines, read the text and use 'Get text between' instead.")
    result = Table.from_matrix(matrices[0], p.has_header)
    if p.combine:
        for extra in matrices[1:]:
            header = [str(c) for c in extra[0]]
            body = extra[1:] if p.has_header and header == result.columns else extra
            if len(extra[0]) != len(result.columns):
                continue  # a different table
            for row in body:
                result.append(dict(zip(result.columns, row, strict=False)))
    return result


def _cell(value: Any) -> Any:
    if value is None:
        return None
    return " ".join(str(value).split())


class Field(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = ""
    after: str = ""
    before: str = ""
    find: Literal["text", "number", "whole_number", "date", "email", "phone"] = "text"


class ExtractFieldsParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    fields: list[Field] = Param(
        title="Fields",
        description="For each field: the label before the value (e.g. 'Invoice No:') and what kind of value it is.",
    )
    pages: str = Param("all", title="Pages", advanced=True)
    fail_if_missing: bool = Param(False, title="Fail if a field is not found")
    ocr: OcrMode = _ocr_param()


@activity(
    "pdf.extract_fields",
    title="Get fields from PDF",
    category=P,
    icon="scan-text",
    sentence="Get fields from {file}",
    description="Read values such as invoice number, date and total, found right after their labels.",
    params=ExtractFieldsParams,
    outputs=[OutputDef("fields", "Fields (use as fields.Name)", "any", default_variable="invoice")],
)
def extract_fields(ctx: RunContext, p: ExtractFieldsParams) -> dict[str, Any]:
    text = _text_of(_pdf(p.file), p.pages, p.ocr)
    values: dict[str, Any] = {}
    missing: list[str] = []
    for field in p.fields:
        name = field.name.strip() or field.after.strip().rstrip(":") or "value"
        value = find_field(text, field)
        if value is None:
            missing.append(name)
        values[name] = value
    if missing:
        message = f"Not found in the PDF: {', '.join(missing)}."
        if p.fail_if_missing:
            raise ActivityError(message, "Check the labels exactly as they appear in the PDF.")
        ctx.log(message, "warning")
    return values


def find_field(text: str, field: Field) -> Any:
    """The value after a label (same line first, then the next line), optionally until 'before'."""
    if not field.after.strip():
        return None
    start = re.search(re.escape(field.after.strip()), text, re.IGNORECASE)
    if not start:
        return None
    rest = text[start.end():]
    if field.before.strip():
        end = re.search(re.escape(field.before.strip()), rest, re.IGNORECASE)
        candidates = [rest[: end.start()] if end else rest.split("\n", 1)[0]]
    else:
        lines = rest.split("\n")
        candidates = [lines[0]] + ([lines[1]] if len(lines) > 1 else [])
    for chunk in candidates:
        chunk = chunk.strip(" :\t#-")
        if not chunk:
            continue
        if field.find == "text":
            return chunk
        match = re.search(PATTERNS[field.find][1], chunk)
        if match:
            found = match.group(0)
            return to_number(found) if field.find in ("number", "whole_number") else found
    return None


class PageCountParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])


@activity(
    "pdf.page_count",
    title="Count PDF pages",
    category=P,
    icon="files",
    sentence="Count pages of {file}",
    params=PageCountParams,
    outputs=[OutputDef("count", "Pages", "number", default_variable="page_count")],
)
def page_count(ctx: RunContext, p: PageCountParams) -> int:
    from pypdf import PdfReader

    return len(PdfReader(_pdf(p.file)).pages)


class MergeParams(Params):
    files: Any = Param(title="PDF files", ui="variable", description="A list of PDF files, e.g. from 'List files in folder'.")
    output: str = Param(title="Save as", ui="save_file", file_types=["pdf"])


@activity(
    "pdf.merge",
    title="Merge PDFs",
    category=P,
    icon="merge",
    sentence="Merge {files} into {output}",
    params=MergeParams,
    outputs=[OutputDef("file", "Merged PDF", "file", default_variable="merged_pdf")],
)
def merge(ctx: RunContext, p: MergeParams) -> str:
    from pypdf import PdfWriter

    files = p.files if isinstance(p.files, list) else [f.strip() for f in to_text(p.files).split(",") if f.strip()]
    if not files:
        raise ActivityError("No PDF files to merge.")
    out = Path(to_text(p.output).strip())
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for f in files:
        writer.append(str(_pdf(f)))
    with out.open("wb") as fh:
        writer.write(fh)
    return str(out)


class SplitParams(Params):
    file: str = Param(title="PDF file", ui="file", file_types=["pdf"])
    folder: str = Param(title="Save pages to folder", ui="folder")


@activity(
    "pdf.split",
    title="Split PDF into pages",
    category=P,
    icon="scissors",
    sentence="Split {file} into pages",
    params=SplitParams,
    outputs=[OutputDef("files", "Page files", "list", default_variable="page_files")],
)
def split(ctx: RunContext, p: SplitParams) -> list[str]:
    from pypdf import PdfReader, PdfWriter

    source = _pdf(p.file)
    folder = Path(to_text(p.folder).strip())
    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for i, page in enumerate(PdfReader(source).pages, start=1):
        writer = PdfWriter()
        writer.add_page(page)
        target = folder / f"{source.stem}-page{i}.pdf"
        with target.open("wb") as fh:
            writer.write(fh)
        out.append(str(target))
    return out


class ReadImageParams(Params):
    file: str = Param(title="Image file", ui="file", file_types=["png", "jpg", "jpeg", "bmp", "tif", "tiff"])


@activity(
    "pdf.read_image",
    title="Read text from image (OCR)",
    category=P,
    icon="scan-eye",
    sentence="Read text from image {file}",
    description="Recognise the text in a picture or screenshot, e.g. from a scanner or a remote (Citrix) screen.",
    params=ReadImageParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="image_text")],
)
def read_image_text(ctx: RunContext, p: ReadImageParams) -> str:
    from ..ocr import read_image

    path = Path(to_text(p.file).strip().strip('"'))
    if not path.is_file():
        raise ActivityError(f"The image '{path}' does not exist.")
    return read_image(path)
