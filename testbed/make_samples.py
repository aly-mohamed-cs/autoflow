"""Create sample documents for tests and demos (no extra libraries needed).

    python testbed/make_samples.py
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).parent / "samples"


def pdf(path: Path, texts: list[tuple[float, float, str, int]], lines: list[tuple[float, float, float, float]]) -> None:
    """A one-page PDF with Helvetica text (x, y, text, size) and straight lines."""
    content = []
    for x1, y1, x2, y2 in lines:
        content.append(f"{x1} {y1} m {x2} {y2} l S")
    for x, y, text, size in texts:
        safe = text.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)")
        content.append(f"BT /F1 {size} Tf {x} {y} Td ({safe}) Tj ET")
    stream = "\n".join(content).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def invoice(path: Path, number: str, customer: str, items: list[tuple[str, int, float]]) -> None:
    texts = [
        (50, 790, "ACME SUPPLIES LTD", 18),
        (50, 760, f"Invoice No: {number}", 11),
        (50, 742, "Invoice Date: 15/03/2026", 11),
        (50, 724, f"Customer: {customer}", 11),
        (50, 706, "Payment terms: 30 days", 11),
    ]
    # Item table with ruled lines, so it can be read as a table.
    cols = [50, 300, 380, 470, 545]
    top, row_h = 670, 22
    rows = [("Description", "Qty", "Unit price", "Amount")] + [
        (d, str(q), f"{p:,.2f}", f"{q * p:,.2f}") for d, q, p in items
    ]
    lines = []
    for r in range(len(rows) + 1):
        y = top - r * row_h
        lines.append((cols[0], y, cols[-1], y))
    for x in cols:
        lines.append((x, top, x, top - len(rows) * row_h))
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            texts.append((cols[c] + 5, top - (r + 1) * row_h + 7, cell, 10))
    total = sum(q * p for _, q, p in items)
    texts.append((380, top - len(rows) * row_h - 30, f"Total due: {total:,.2f} EGP", 12))
    pdf(path, texts, lines)


if __name__ == "__main__":
    HERE.mkdir(exist_ok=True)
    invoice(HERE / "invoice-INV-2026-0042.pdf", "INV-2026-0042", "Globex Corporation",
            [("Printer paper A4 (box)", 10, 245.0), ("Toner cartridge", 3, 1850.5), ("Desk lamp", 2, 799.0)])
    invoice(HERE / "invoice-INV-2026-0043.pdf", "INV-2026-0043", "Initech",
            [("USB keyboard", 5, 450.0)])
    print("samples written to", HERE)
