"""Word and PowerPoint files (Brity "Word" and "PowerPoint" libraries), and the few things that need
the Office programs themselves: running Excel macros, recalculating, saving as PDF."""

from __future__ import annotations

import contextlib
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Literal

from ..catalog import OutputDef, Param, Params, activity
from ..errors import ActivityError
from ..runtime.context import RunContext
from ..values import Table, to_text

W = "Word"
P = "PowerPoint"
X = "Excel"


def _path(value: Any, kinds: tuple[str, ...], *, must_exist: bool = True) -> Path:
    text = to_text(value).strip().strip('"')
    if not text:
        raise ActivityError("No file was given.", "Choose the file in the step settings.")
    path = Path(text).expanduser()
    if path.suffix.lower() not in kinds:
        raise ActivityError(f"'{path.name}' is not a {' / '.join(kinds)} file.")
    if must_exist and not path.exists():
        raise ActivityError(f"The file '{path}' does not exist.", "Check the file path.")
    return path


def _save(document: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        document.save(path)
    except PermissionError:
        raise ActivityError(f"Cannot save '{path.name}'.", "It is probably open in Word / PowerPoint. Close it and try again.") from None


def _replace_in_paragraph(paragraph: Any, find: str, replacement: str) -> int:
    """Replace inside a paragraph, keeping the formatting of the run the text starts in."""
    if find not in paragraph.text:
        return 0
    count = 0
    for run in paragraph.runs:  # the text is usually inside one run
        if find in run.text:
            count += run.text.count(find)
            run.text = run.text.replace(find, replacement)
    if find in paragraph.text and paragraph.runs:  # split across runs: join them into the first one
        count += paragraph.text.count(find)
        text = paragraph.text.replace(find, replacement)
        for run in paragraph.runs[1:]:
            run.text = ""
        paragraph.runs[0].text = text
    return count


# -- Word ---------------------------------------------------------------------------------------------


_DOCX = ["docx"]


class WordFileParams(Params):
    file: str = Param(title="Word file", ui="file", file_types=_DOCX)


class CreateWordParams(Params):
    file: str = Param(title="Word file", ui="save_file", file_types=_DOCX, placeholder="C:\\Reports\\letter.docx")
    template: str = Param("", title="Start from", ui="file", file_types=_DOCX, placeholder="(an empty document)",
                          description="A Word file to copy, e.g. a letter with your logo.")


@activity(
    "word.create",
    title="Create Word document",
    category=W,
    icon="file-plus",
    sentence="Create Word document {file}",
    description="Create a new Word document, empty or as a copy of another one (Brity NewWord / CreateWord).",
    params=CreateWordParams,
    outputs=[OutputDef("file", "Document", "file", default_variable="document")],
)
def word_create(ctx: RunContext, p: CreateWordParams) -> str:
    import docx

    path = _path(p.file, (".docx",), must_exist=False)
    template = to_text(p.template).strip()
    _save(docx.Document(str(_path(template, (".docx",))) if template else None), path)
    return str(path)


@activity(
    "word.read_text",
    title="Read Word document",
    category=W,
    icon="file-text",
    sentence="Read the text of {file}",
    description="All the text of a Word document, paragraph by paragraph (tables included).",
    params=WordFileParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="word_text")],
)
def word_read(ctx: RunContext, p: WordFileParams) -> str:
    import docx

    document = docx.Document(str(_path(p.file, (".docx",))))
    lines = [para.text for para in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            lines.append("\t".join(cell.text for cell in row.cells))
    return "\n".join(lines).strip()


class AddTextParams(WordFileParams):
    text: str = Param(title="Text", ui="multiline")
    style: Literal["normal", "title", "heading1", "heading2", "heading3", "bullet", "number"] = Param(
        "normal", title="Style",
        labels={"normal": "Normal text", "title": "Title", "heading1": "Heading 1", "heading2": "Heading 2",
                "heading3": "Heading 3", "bullet": "Bullet list", "number": "Numbered list"},
    )
    bold: bool = Param(False, title="Bold", advanced=True)


_STYLES = {"normal": "Normal", "title": "Title", "heading1": "Heading 1", "heading2": "Heading 2",
           "heading3": "Heading 3", "bullet": "List Bullet", "number": "List Number"}


@activity(
    "word.add_text",
    title="Add text to Word",
    category=W,
    icon="pilcrow",
    sentence="Add {text} to {file}",
    description="Add a paragraph (or heading, or list item) at the end of a Word document (Brity InsertString).",
    params=AddTextParams,
)
def word_add_text(ctx: RunContext, p: AddTextParams) -> None:
    import docx

    path = _path(p.file, (".docx",))
    document = docx.Document(str(path))
    for line in to_text(p.text).split("\n"):
        paragraph = document.add_paragraph(style=_STYLES[p.style])
        run = paragraph.add_run(line)
        run.bold = p.bold or None
    _save(document, path)


class ReplaceParams(Params):
    find: str = Param(title="Find", placeholder="[Customer]")
    replace: str = Param("", title="Replace with", placeholder="{{row[\"Customer\"]}}")


class WordReplaceParams(WordFileParams, ReplaceParams):
    save_as: str = Param("", title="Save as", ui="save_file", file_types=_DOCX, placeholder="(the same file)",
                         description="Fill a template and save the result as a new file.")


def _word_paragraphs(document: Any) -> Iterator[Any]:
    yield from document.paragraphs
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                yield from cell.paragraphs
    for section in document.sections:
        for part in (section.header, section.footer):
            yield from part.paragraphs


@activity(
    "word.replace_text",
    title="Replace text in Word",
    category=W,
    icon="replace",
    sentence="Replace {find} with {replace} in {file}",
    description="Fill in a template: replace a placeholder everywhere (text, tables, headers and footers).",
    params=WordReplaceParams,
    outputs=[OutputDef("count", "Replaced", "number", default_variable="replaced")],
)
def word_replace(ctx: RunContext, p: WordReplaceParams) -> int:
    import docx

    find = to_text(p.find)
    if not find:
        raise ActivityError("There is nothing to find.", "Enter the placeholder to replace, e.g. [Customer].")
    path = _path(p.file, (".docx",))
    document = docx.Document(str(path))
    count = sum(_replace_in_paragraph(para, find, to_text(p.replace)) for para in _word_paragraphs(document))
    target = to_text(p.save_as).strip()
    _save(document, _path(target, (".docx",), must_exist=False) if target else path)
    return count


class AddTableParams(WordFileParams):
    table: Any = Param(title="Table", ui="variable")
    style: str = Param("Table Grid", title="Table style", advanced=True)


@activity(
    "word.add_table",
    title="Add table to Word",
    category=W,
    icon="table",
    sentence="Add {table} to {file}",
    description="Add a table (e.g. read from Excel) at the end of a Word document, with a header row.",
    params=AddTableParams,
)
def word_add_table(ctx: RunContext, p: AddTableParams) -> None:
    import docx

    if not isinstance(p.table, Table):
        raise ActivityError("Choose a table variable (e.g. read from Excel).")
    path = _path(p.file, (".docx",))
    document = docx.Document(str(path))
    columns = list(p.table.columns)
    grid = document.add_table(rows=1, cols=max(len(columns), 1))
    with contextlib.suppress(KeyError):
        grid.style = to_text(p.style) or "Table Grid"
    for cell, name in zip(grid.rows[0].cells, columns, strict=False):
        cell.text = to_text(name)
        for run in cell.paragraphs[0].runs:
            run.bold = True
    for row in p.table.rows:
        cells = grid.add_row().cells
        for cell, name in zip(cells, columns, strict=False):
            cell.text = to_text(row.get(name))
    _save(document, path)


# -- PowerPoint ----------------------------------------------------------------------------------------


_PPTX = ["pptx"]


class PptFileParams(Params):
    file: str = Param(title="PowerPoint file", ui="file", file_types=_PPTX)


def _shapes_text(slide: Any) -> Iterator[Any]:
    for shape in slide.shapes:
        if shape.has_text_frame:
            yield from shape.text_frame.paragraphs
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    yield from cell.text_frame.paragraphs


@activity(
    "ppt.read_text",
    title="Read PowerPoint",
    category=P,
    icon="presentation",
    sentence="Read the text of {file}",
    description="All the text of a presentation, slide by slide.",
    params=PptFileParams,
    outputs=[OutputDef("text", "Text", "text", default_variable="slides_text")],
)
def ppt_read(ctx: RunContext, p: PptFileParams) -> str:
    from pptx import Presentation

    deck = Presentation(str(_path(p.file, (".pptx",))))
    parts = []
    for number, slide in enumerate(deck.slides, start=1):
        lines = [para.text for para in _shapes_text(slide) if para.text.strip()]
        parts.append(f"Slide {number}\n" + "\n".join(lines))
    return "\n\n".join(parts)


@activity(
    "ppt.slide_count",
    title="Count slides",
    category=P,
    icon="gallery-horizontal",
    sentence="Count the slides of {file}",
    params=PptFileParams,
    outputs=[OutputDef("count", "Slides", "number", default_variable="slide_count")],
)
def ppt_count(ctx: RunContext, p: PptFileParams) -> int:
    from pptx import Presentation

    return len(Presentation(str(_path(p.file, (".pptx",)))).slides)


class AddSlideParams(PptFileParams):
    title: str = Param("", title="Title")
    text: str = Param("", title="Text", ui="multiline", description="One bullet point per line.")
    layout: Literal["title_content", "title", "title_only", "blank"] = Param(
        "title_content", title="Layout", advanced=True,
        labels={"title_content": "Title and content", "title": "Title slide", "title_only": "Title only", "blank": "Blank"},
    )


_LAYOUTS = {"title": 0, "title_content": 1, "title_only": 5, "blank": 6}


@activity(
    "ppt.add_slide",
    title="Add slide",
    category=P,
    icon="square-plus",
    sentence="Add slide {title} to {file}",
    description="Add a slide at the end with a title and bullet points (Brity AddNewSlide).",
    params=AddSlideParams,
    outputs=[OutputDef("number", "Slide number", "number", default_variable="slide_number")],
)
def ppt_add_slide(ctx: RunContext, p: AddSlideParams) -> int:
    from pptx import Presentation

    path = _path(p.file, (".pptx",))
    deck = Presentation(str(path))
    layouts = deck.slide_layouts
    slide = deck.slides.add_slide(layouts[min(_LAYOUTS[p.layout], len(layouts) - 1)])
    if slide.shapes.title is not None:
        slide.shapes.title.text = to_text(p.title)
    body = next((ph for ph in slide.placeholders if ph.placeholder_format.idx == 1), None)
    if body is not None and to_text(p.text):
        frame = body.text_frame
        for i, line in enumerate(to_text(p.text).split("\n")):
            paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
            paragraph.text = line
    _save(deck, path)
    return len(deck.slides)


class SlideParams(PptFileParams):
    slide: int = Param(title="Slide number", ge=1)


@activity(
    "ppt.delete_slide",
    title="Delete slide",
    category=P,
    icon="trash",
    sentence="Delete slide {slide} of {file}",
    params=SlideParams,
)
def ppt_delete_slide(ctx: RunContext, p: SlideParams) -> None:
    from pptx import Presentation

    path = _path(p.file, (".pptx",))
    deck = Presentation(str(path))
    slides = deck.slides._sldIdLst  # python-pptx has no public delete
    if p.slide > len(slides):
        raise ActivityError(f"The presentation has only {len(slides)} slides.")
    entry = slides[p.slide - 1]
    deck.part.drop_rel(entry.rId)
    slides.remove(entry)
    _save(deck, path)


class PptReplaceParams(PptFileParams, ReplaceParams):
    save_as: str = Param("", title="Save as", ui="save_file", file_types=_PPTX, placeholder="(the same file)")


@activity(
    "ppt.replace_text",
    title="Replace text in PowerPoint",
    category=P,
    icon="replace",
    sentence="Replace {find} with {replace} in {file}",
    description="Fill in a presentation template: replace a placeholder on every slide.",
    params=PptReplaceParams,
    outputs=[OutputDef("count", "Replaced", "number", default_variable="replaced")],
)
def ppt_replace(ctx: RunContext, p: PptReplaceParams) -> int:
    from pptx import Presentation

    find = to_text(p.find)
    if not find:
        raise ActivityError("There is nothing to find.", "Enter the placeholder to replace.")
    path = _path(p.file, (".pptx",))
    deck = Presentation(str(path))
    count = sum(_replace_in_paragraph(para, find, to_text(p.replace))
                for slide in deck.slides for para in _shapes_text(slide))
    target = to_text(p.save_as).strip()
    _save(deck, _path(target, (".pptx",), must_exist=False) if target else path)
    return count


# -- with the Office programs (COM): macros, recalculating, PDF ------------------------------------------


@contextlib.contextmanager
def _office(program: str) -> Iterator[Any]:
    """Start Excel / Word / PowerPoint invisibly for one step, and always quit it."""
    import comtypes
    import comtypes.client

    comtypes.CoInitialize()
    app = None
    try:
        try:
            app = comtypes.client.CreateObject(f"{program}.Application", dynamic=True)
        except OSError:
            raise ActivityError(f"Microsoft {program} is not installed on this computer.",
                                "This step needs Office on the computer that runs it.") from None
        with contextlib.suppress(Exception):
            app.DisplayAlerts = False if program != "PowerPoint" else 1  # ppAlertsNone
        if program != "PowerPoint":
            with contextlib.suppress(Exception):
                app.Visible = False
        yield app
    finally:
        if app is not None:
            with contextlib.suppress(Exception):
                app.Quit()
        comtypes.CoUninitialize()


def _com_error(exc: Exception) -> ActivityError:
    text = re.sub(r"\s+", " ", str(exc))
    return ActivityError(f"Office reported a problem: {text[:300]}")


class MacroParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=["xlsm", "xlsx", "xls", "xlsb"])
    macro: str = Param(title="Macro", placeholder="Module1.FormatReport")
    arguments: list[str] = Param(default_factory=list, title="Values to hand to it", advanced=True)
    save: bool = Param(True, title="Save the workbook afterwards")


@activity(
    "excel.run_macro",
    title="Run Excel macro",
    category=X,
    icon="square-code",
    sentence="Run macro {macro} in {file}",
    description="Open the workbook in Excel and run one of its macros (Brity ExecuteMacro). Needs Excel.",
    params=MacroParams,
    outputs=[OutputDef("result", "Result", "any", default_variable="macro_result")],
)
def run_macro(ctx: RunContext, p: MacroParams) -> Any:
    path = _path(p.file, (".xlsm", ".xlsx", ".xls", ".xlsb")).resolve()
    with _office("Excel") as excel:
        try:
            workbook = excel.Workbooks.Open(str(path))
            result = excel.Run(f"'{path.name}'!{to_text(p.macro).strip()}", *[to_text(a) for a in p.arguments])
            if p.save:
                workbook.Save()
            workbook.Close(False)
        except ActivityError:
            raise
        except Exception as exc:
            raise _com_error(exc) from None
    return result


class RefreshParams(Params):
    file: str = Param(title="Excel file", ui="file", file_types=["xlsx", "xlsm", "xls", "xlsb"])
    refresh_data: bool = Param(False, title="Also refresh data connections and pivot tables")


@activity(
    "excel.recalculate",
    title="Recalculate Excel",
    category=X,
    icon="calculator",
    sentence="Recalculate {file}",
    description="Open the workbook in Excel, recalculate every formula (and refresh data), and save - so steps "
    "reading it afterwards see up-to-date results. Needs Excel.",
    params=RefreshParams,
)
def recalculate(ctx: RunContext, p: RefreshParams) -> None:
    path = _path(p.file, (".xlsx", ".xlsm", ".xls", ".xlsb")).resolve()
    with _office("Excel") as excel:
        try:
            workbook = excel.Workbooks.Open(str(path))
            if p.refresh_data:
                workbook.RefreshAll()
                with contextlib.suppress(Exception):
                    excel.CalculateUntilAsyncQueriesDone()
            excel.CalculateFull()
            workbook.Save()
            workbook.Close(False)
        except Exception as exc:
            raise _com_error(exc) from None


class ToPdfParams(Params):
    file: str = Param(title="File", ui="file", file_types=["xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt"])
    pdf: str = Param("", title="Save the PDF as", ui="save_file", file_types=["pdf"], placeholder="(next to the file)")


@activity(
    "pdf.from_office",
    title="Save Office file as PDF",
    category="PDF",
    icon="file-output",
    sentence="Save {file} as PDF",
    description="Turn an Excel workbook, Word document or PowerPoint presentation into a PDF. Needs Office.",
    params=ToPdfParams,
    outputs=[OutputDef("pdf", "PDF file", "file", default_variable="pdf_file")],
)
def to_pdf(ctx: RunContext, p: ToPdfParams) -> str:
    path = _path(p.file, (".xlsx", ".xlsm", ".xls", ".docx", ".doc", ".pptx", ".ppt")).resolve()
    target = Path(to_text(p.pdf).strip() or path.with_suffix(".pdf")).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    kind = path.suffix.lower()
    program = "Excel" if kind.startswith(".xl") else "Word" if kind.startswith(".doc") else "PowerPoint"
    with _office(program) as app:
        try:
            # Positional arguments only (late-bound COM): see each Open's parameter order.
            if program == "Excel":
                book = app.Workbooks.Open(str(path), 0, True)  # Filename, UpdateLinks, ReadOnly
                book.ExportAsFixedFormat(0, str(target))  # xlTypePDF
                book.Close(False)
            elif program == "Word":
                doc = app.Documents.Open(str(path), False, True)  # FileName, ConfirmConversions, ReadOnly
                doc.SaveAs2(str(target), 17)  # wdFormatPDF
                doc.Close(False)
            else:
                deck = app.Presentations.Open(str(path), True, False, False)  # ReadOnly, Untitled, WithWindow
                deck.SaveAs(str(target), 32)  # ppSaveAsPDF
                deck.Close()
        except Exception as exc:
            raise _com_error(exc) from None
    return str(target)
