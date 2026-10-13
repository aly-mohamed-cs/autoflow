"""Release D: deeper Excel, Word, PowerPoint and PDF steps (Brity's Excel / Word / PowerPoint / PDF
libraries). The steps that need the Office programs only run with AUTOFLOW_OFFICE_TESTS=1."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from conftest import step
from openpyxl import Workbook, load_workbook


@pytest.fixture
def book(tmp_path) -> Path:
    path = tmp_path / "sales.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Region", "Customer", "Amount"])
    for row in [["North", "Acme", 100], ["South", "Globex", 250], ["North", "Initech", 75]]:
        ws.append(row)
    ws["E1"] = "Status 2025"
    ws["C5"] = "=SUM(C2:C4)"
    wb.save(path)
    return path


def test_excel_sheets_rows_and_cells(h, book, tmp_path):
    f = str(book)
    result = h.run([
        step("excel.add_sheet", {"file": f, "sheet": "Summary", "position": 1}),
        step("excel.copy_sheet", {"file": f, "sheet": "Sales", "new_name": "Backup"}),
        step("excel.rename_sheet", {"file": f, "sheet": "Backup", "new_name": "Old"}),
        step("excel.delete_sheet", {"file": f, "sheet": "Old"}),
        step("excel.format_cells", {"file": f, "sheet": "Sales", "range": "A1:C1", "bold": "yes",
                                    "fill_color": "lightgreen", "border": "thin", "column_width": "auto"}),
        step("excel.format_cells", {"file": f, "sheet": "Sales", "range": "C2:C5", "number_format": "#,##0.00"}),
        step("excel.merge_cells", {"file": f, "sheet": "Sales", "range": "E1:F1"}),
        step("excel.insert_lines", {"file": f, "sheet": "Sales", "what": "rows", "at": 2, "count": 1}),
        step("excel.delete_lines", {"file": f, "sheet": "Sales", "what": "rows", "at": 2, "count": 1}),
        step("excel.insert_lines", {"file": f, "sheet": "Sales", "what": "columns", "at": "D"}),
        step("excel.hide_lines", {"file": f, "sheet": "Sales", "what": "columns", "which": "D"}),
        step("excel.read_formula", {"file": f, "sheet": "Sales", "cell": "C5"}, outputs={"formula": "total"}),
        step("excel.find_replace", {"file": f, "find": "2025", "replace": "2026"}, outputs={"count": "n"}),
        step("excel.filter_buttons", {"file": f, "sheet": "Sales", "range": "A1:C4"}),
        step("excel.copy_cells", {"file": f, "sheet": "Sales", "range": "A1:C5", "to_sheet": "Summary", "to_cell": "B2"}),
        step("excel.copy_cells", {"file": f, "sheet": "Sales", "range": "A1:C4",
                                  "to_file": str(tmp_path / "copy.xlsx"), "to_cell": "A1"}),
        step("excel.clear_cells", {"file": f, "sheet": "Sales", "range": "B4"}),
        step("excel.split", {"file": f, "sheet": "Sales", "column": "Region", "folder": str(tmp_path / "split")},
             outputs={"files": "parts"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["total"] == "=SUM(C2:C4)"
    assert h.vars["n"] == 1
    wb = load_workbook(book)
    assert wb.sheetnames == ["Summary", "Sales"]
    sales, summary = wb["Sales"], wb["Summary"]
    assert sales["A1"].font.b and sales["A1"].fill.start_color.rgb == "FFC6EFCE" and sales["A1"].border.left.style == "thin"
    assert sales["C2"].number_format == "#,##0.00"
    assert "E1:F1" not in [str(r) for r in sales.merged_cells.ranges]  # E moved to F when D was inserted
    assert [str(r) for r in sales.merged_cells.ranges] == ["F1:G1"]
    assert sales.column_dimensions["D"].hidden
    assert sales["F1"].value == "Status 2026"
    assert sales.auto_filter.ref == "A1:C4"
    assert sales["B4"].value is None
    assert summary["B2"].value == "Region" and summary["D6"].value == "=SUM(D3:D5)"  # the formula follows
    assert load_workbook(tmp_path / "copy.xlsx").active["B3"].value == "Globex"
    names = sorted(Path(x).name for x in h.vars["parts"])
    assert names == ["sales - North.xlsx", "sales - South.xlsx"]
    north = load_workbook(tmp_path / "split" / "sales - North.xlsx").active
    assert [r[2] for r in north.iter_rows(values_only=True)] == ["Amount", 100, 75]  # both North rows


def test_excel_explains_bad_input(h, book):
    result = h.run([step("excel.format_cells", {"file": str(book), "range": "A1", "fill_color": "sky"})])
    assert result.status == "failed" and "is not a colour" in result.error["message"]
    result = h.run([step("excel.delete_sheet", {"file": str(book), "sheet": "Nope"})])
    assert result.status == "failed" and "no sheet called 'Nope'" in result.error["message"]


def test_word_documents(h, tmp_path):
    import docx

    letter = tmp_path / "letter.docx"
    template = docx.Document()
    para = template.add_paragraph("Dear ")
    para.add_run("[Cus").bold = True  # a placeholder split over two runs
    para.add_run("tomer],")
    template.save(tmp_path / "template.docx")
    result = h.run([
        step("word.create", {"file": str(letter), "template": str(tmp_path / "template.docx")}),
        step("word.add_text", {"file": str(letter), "text": "Your invoices", "style": "heading1"}),
        step("excel.read", {"file": str(_table_book(tmp_path))}, outputs={"table": "rows"}),
        step("word.add_table", {"file": str(letter), "table": "{{rows}}"}),
        step("word.replace_text", {"file": str(letter), "find": "[Customer]", "replace": "Acme",
                                   "save_as": str(tmp_path / "acme.docx")}, outputs={"count": "n"}),
        step("word.read_text", {"file": str(tmp_path / "acme.docx")}, outputs={"text": "text"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["n"] == 1
    assert h.vars["text"].startswith("Dear Acme,\nYour invoices")
    assert "INV-1\t120" in h.vars["text"]
    assert "[Customer]" in docx.Document(str(letter)).paragraphs[0].text  # the template copy is untouched
    assert docx.Document(str(tmp_path / "acme.docx")).paragraphs[1].style.name == "Heading 1"


def _table_book(tmp_path: Path) -> Path:
    path = tmp_path / "rows.xlsx"
    wb = Workbook()
    wb.active.append(["Invoice", "Total"])
    wb.active.append(["INV-1", 120])
    wb.save(path)
    return path


def test_powerpoint_presentations(h, tmp_path):
    from pptx import Presentation

    deck = tmp_path / "deck.pptx"
    Presentation().save(deck)
    result = h.run([
        step("ppt.add_slide", {"file": str(deck), "title": "Results for [Month]", "text": "Sales up\nCosts down"}),
        step("ppt.add_slide", {"file": str(deck), "title": "Extra"}, outputs={"number": "last"}),
        step("ppt.delete_slide", {"file": str(deck), "slide": "{{last}}"}),
        step("ppt.replace_text", {"file": str(deck), "find": "[Month]", "replace": "May"}, outputs={"count": "n"}),
        step("ppt.slide_count", {"file": str(deck)}, outputs={"count": "slides"}),
        step("ppt.read_text", {"file": str(deck)}, outputs={"text": "text"}),
    ])
    assert result.status == "succeeded", result.error
    assert (h.vars["last"], h.vars["slides"], h.vars["n"]) == (2, 1, 1)
    assert h.vars["text"] == "Slide 1\nResults for May\nSales up\nCosts down"


def test_pdf_search_pages_and_pictures(h, tmp_path):
    from PIL import Image

    invoice = Path(__file__).resolve().parents[2] / "testbed" / "samples" / "invoice-INV-2026-0042.pdf"
    picture_pdf = tmp_path / "scan.pdf"
    Image.new("RGB", (200, 120), "orange").save(picture_pdf)
    result = h.run([
        step("pdf.search_text", {"file": str(invoice), "text": "inv-2026-0042"},
             outputs={"pages": "pages", "count": "times"}),
        step("pdf.to_images", {"file": str(invoice), "folder": str(tmp_path / "pages"), "resolution": 72},
             outputs={"files": "page_files"}),
        step("pdf.extract_images", {"file": str(picture_pdf), "folder": str(tmp_path / "pictures")},
             outputs={"files": "pictures"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["pages"] == [1] and h.vars["times"] >= 1
    assert len(h.vars["page_files"]) == 1 and Path(h.vars["page_files"][0]).stat().st_size > 1000
    assert len(h.vars["pictures"]) == 1


office = pytest.mark.skipif(os.environ.get("AUTOFLOW_OFFICE_TESTS") != "1",
                            reason="needs Microsoft Office (set AUTOFLOW_OFFICE_TESTS=1)")


@office
def test_office_programs_recalculate_and_make_pdfs(h, book, tmp_path):
    import docx

    letter = tmp_path / "letter.docx"
    document = docx.Document()
    document.add_paragraph("Hello")
    document.save(letter)
    result = h.run([
        step("excel.recalculate", {"file": str(book)}),
        step("excel.read", {"file": str(book), "sheet": "Sales", "range": "C5:C5", "has_header": False},
             outputs={"table": "total"}),
        step("pdf.from_office", {"file": str(book)}, outputs={"pdf": "book_pdf"}),
        step("pdf.from_office", {"file": str(letter), "pdf": str(tmp_path / "out" / "letter.pdf")},
             outputs={"pdf": "letter_pdf"}),
    ])
    assert result.status == "succeeded", result.error
    assert Path(h.vars["book_pdf"]).stat().st_size > 500
    assert Path(h.vars["letter_pdf"]).stat().st_size > 500
