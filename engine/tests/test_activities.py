"""Files, Excel, Data and Text activities run through real flows."""

import datetime as dt

from conftest import step
from openpyxl import Workbook, load_workbook

from autoflow_engine.values import Table


def _make_invoices(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Invoices"
    ws.append(["Invoice No", "Customer", "Amount", "Date"])
    ws.append(["INV-1", "Acme", 1200, dt.datetime(2026, 1, 5)])
    ws.append(["INV-2", "Globex", 300.5, dt.datetime(2026, 1, 6)])
    ws.append([None, None, None, None])
    ws.append(["INV-3", "Acme", 99, dt.datetime(2026, 1, 7)])
    wb.save(path)


def test_excel_to_portal_style_loop_writes_status_back(h, tmp_path):
    """Scenario 1 shape: read rows, process each, write a reference back to the row."""
    xlsx = tmp_path / "invoices.xlsx"
    _make_invoices(xlsx)
    result = h.run([
        step("excel.read", {"file": str(xlsx), "sheet": "invoices"}, outputs={"table": "invoices"}),
        step("control.for_each", {"items": "{{invoices}}", "item_variable": "row", "index_variable": "n"},
             blocks={"body": [
                 step("excel.update_row", {"file": str(xlsx), "sheet": "Invoices", "row_number": "{{n}}",
                                           "values": {"Status": "Done", "Reference": 'REF-{{row["Invoice No"]}}'}}),
             ]}),
    ])
    assert result.status == "succeeded", result.error
    table = h.vars["invoices"]
    assert isinstance(table, Table) and len(table) == 3  # blank row dropped
    assert table.rows[1]["Amount"] == 300.5
    ws = load_workbook(xlsx)["Invoices"]
    assert [c.value for c in ws[1]][-2:] == ["Status", "Reference"]
    assert ws["E2"].value == "Done" and ws["F2"].value == "REF-INV-1"


def test_report_merge_style(h, tmp_path):
    """Scenario 2 shape: several reports -> one combined, summarized workbook."""
    reports = tmp_path / "reports"
    reports.mkdir()
    for i, rows in enumerate([[("North", 10), ("South", 5)], [("North", 7), ("East", 1)]]):
        wb = Workbook()
        wb.active.append(["Region", "Sales"])
        for r in rows:
            wb.active.append(list(r))
        wb.save(reports / f"report{i}.xlsx")
    out = tmp_path / "out" / "summary.xlsx"
    result = h.run([
        step("files.list", {"folder": str(reports), "pattern": "*.xlsx"}, outputs={"files": "files"}),
        step("control.for_each", {"items": "{{files}}", "item_variable": "file"}, blocks={"body": [
            step("excel.read", {"file": "{{file}}"}, outputs={"table": "part"}),
            step("data.append_tables", {"first": "{{all}}", "second": "{{part}}"}, outputs={"table": "all"}),
        ]}),
        step("data.group", {"table": "{{all}}", "group_by": ["Region"],
                            "calculations": [{"column": "Sales", "function": "sum", "result_column": "Total"}]},
             outputs={"table": "summary"}),
        step("data.sort", {"table": "{{summary}}", "column": "total", "descending": True}, outputs={"table": "summary"}),
        step("excel.write_table", {"table": "{{summary}}", "file": str(out), "sheet": "Summary"}),
    ], variables=[{"name": "all", "type": "table"}])
    assert result.status == "succeeded", result.error
    ws = load_workbook(out)["Summary"]
    assert [[c.value for c in r] for r in ws.iter_rows()] == [
        ["Region", "Total"], ["North", 17], ["South", 5], ["East", 1],
    ]


def test_excel_append_row_and_cells(h, tmp_path):
    xlsx = tmp_path / "log.xlsx"
    result = h.run([
        step("excel.append_row", {"file": str(xlsx), "sheet": "Log", "values": {"Id": 1, "Note": "first"}}),
        step("excel.append_row", {"file": str(xlsx), "sheet": "Log", "values": {"Id": 2, "Extra": "x"}}),
        step("excel.write_cell", {"file": str(xlsx), "sheet": "Log", "cell": "h1", "value": "Checked"}),
        step("excel.read_cell", {"file": str(xlsx), "sheet": "Log", "cell": "B2"}, outputs={"value": "note"}),
        step("excel.list_sheets", {"file": str(xlsx)}, outputs={"sheets": "sheets"}),
    ])
    assert result.status == "succeeded", result.error
    ws = load_workbook(xlsx)["Log"]
    assert [c.value for c in ws[1]][:3] == ["Id", "Note", "Extra"]
    assert ws["A3"].value == 2 and ws["C3"].value == "x" and ws["H1"].value == "Checked"
    assert h.vars["note"] == "first" and h.vars["sheets"] == ["Log"]


def test_excel_missing_file_is_friendly(h, tmp_path):
    result = h.run([step("excel.read", {"file": str(tmp_path / "nope.xlsx")})])
    assert result.status == "failed"
    assert "does not exist" in result.error["message"]


def test_files_copy_move_rename_zip(h, tmp_path):
    src = tmp_path / "a.txt"
    result = h.run([
        step("files.write_text", {"file": str(src), "text": "hello {{who}}"}),
        step("files.copy", {"source": str(src), "destination": str(tmp_path / "backup")}, outputs={"file": "copy"}),
        step("files.rename", {"file": "{{copy}}", "new_name": "b"}, outputs={"file": "renamed"}),
        step("files.zip", {"source": str(tmp_path / "backup"), "zip_file": str(tmp_path / "b.zip")}),
        step("files.unzip", {"zip_file": str(tmp_path / "b.zip"), "destination": str(tmp_path / "unz")},
             outputs={"files": "unzipped"}),
        step("files.read_text", {"file": str(tmp_path / "unz" / "b.txt")}, outputs={"text": "content"}),
        step("files.exists", {"path": str(tmp_path / "backup" / "a.txt")}, outputs={"exists": "old_exists"}),
    ], variables=[{"name": "who", "default": "robot"}])
    assert result.status == "succeeded", result.error
    assert h.vars["content"] == "hello robot"
    assert h.vars["renamed"].endswith("b.txt")
    assert h.vars["old_exists"] is False


def test_csv_round_trip_and_wait_for_file(h, tmp_path):
    csv_in = tmp_path / "in.csv"
    csv_in.write_text("Name;Score\nA;3\nB;9\n", encoding="utf-8")
    result = h.run([
        step("files.read_csv", {"file": str(csv_in)}, outputs={"table": "t"}),
        step("data.filter", {"table": "{{t}}", "condition": {"rules": [
            {"left": '{{row["Score"]}}', "op": "greater", "right": 5}]}}, outputs={"table": "high"}),
        step("files.write_csv", {"table": "{{high}}", "file": str(tmp_path / "out.csv")}),
        step("files.wait_for_file", {"folder": str(tmp_path), "pattern": "out.csv", "timeout": 5,
                                     "newer_than_start": False}, outputs={"file": "found"}),
    ])
    assert result.status == "succeeded", result.error
    assert h.vars["found"].endswith("out.csv")
    assert (tmp_path / "out.csv").read_text(encoding="utf-8-sig").splitlines() == ["Name,Score", "B,9"]


def test_data_operations(h):
    people = [{"Id": "1", "Name": "Ann", "Dept": "IT"}, {"Id": "2", "Name": "Bob", "Dept": "HR"},
              {"Id": "2", "Name": "Bob", "Dept": "HR"}]
    depts = [{"Dept": "IT", "Floor": 3}, {"Dept": "HR", "Floor": 1}]
    result = h.run([
        step("data.remove_duplicates", {"table": "{{people}}"}, outputs={"table": "people"}),
        step("data.merge", {"left": "{{people}}", "right": "{{depts}}", "left_column": "Dept",
                            "right_column": "dept"}, outputs={"table": "joined"}),
        step("data.add_column", {"table": "{{joined}}", "column": "Label",
                                 "value": '{{row["Name"] + " (" + TEXT(row["Floor"]) + ")"}}'},
             outputs={"table": "joined"}),
        step("data.lookup", {"table": "{{joined}}", "column": "Name", "value": "bob", "return_column": "Floor"},
             outputs={"value": "bob_floor"}),
        step("data.select_columns", {"table": "{{joined}}", "columns": ["Label"]}, outputs={"table": "labels"}),
        step("data.column_to_list", {"table": "{{labels}}", "column": "Label"}, outputs={"list": "label_list"}),
        step("data.count", {"table": "{{people}}"}, outputs={"count": "n"}),
    ], variables=[{"name": "people", "type": "table", "is_input": True},
                  {"name": "depts", "type": "table", "is_input": True}],
        inputs={"people": people, "depts": depts})
    assert result.status == "succeeded", result.error
    assert h.vars["n"] == 2
    assert h.vars["bob_floor"] == 1
    assert h.vars["label_list"] == ["Ann (3)", "Bob (1)"]


def test_text_activities(h):
    text = "Invoice No: INV-0042\nTotal: 1,250.50 EUR\nContact: billing@acme.com"
    result = h.run([
        step("text.extract_between", {"text": "{{doc}}", "after": "Invoice No:"}, outputs={"result": "inv"}),
        step("text.extract_pattern", {"text": "{{doc}}", "find": "number", "all_matches": True},
             outputs={"result": "numbers"}),
        step("text.extract_pattern", {"text": "{{doc}}", "find": "email"}, outputs={"result": "email"}),
        step("text.replace", {"text": "{{inv}}", "find": "inv-", "replace_with": ""}, outputs={"result": "num"}),
        step("text.split", {"text": "a, b,,c", "separator": "comma"}, outputs={"list": "parts"}),
        step("text.format_date", {"date": "2026-03-09", "format": "DD MMM YYYY"}, outputs={"text": "nice"}),
        step("text.add_to_date", {"date": "2026-01-31", "amount": 1, "unit": "months"}, outputs={"date": "next"}),
    ], variables=[{"name": "doc", "default": text}])
    assert result.status == "succeeded", result.error
    assert h.vars["inv"] == "INV-0042"
    assert h.vars["numbers"] == [42, 1250.5]  # "-0042" is not read as negative
    assert h.vars["email"] == "billing@acme.com"
    assert h.vars["num"] == "0042"
    assert h.vars["parts"] == ["a", "b", "c"]
    assert h.vars["nice"] == "09 Mar 2026"
    assert h.vars["next"] == dt.datetime(2026, 2, 28)
