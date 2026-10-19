"""Export the editable Excel shift-report form to the application's PDF template.

Requires LibreOffice, pypdf, pdfplumber and reportlab. Run from any working directory:
    python scripts/build-shift-report-template.py
The Excel file owns all text, cells, table borders and the transparent stamp image.
The final page is aligned to the existing fill coordinates after native export.
"""

import argparse
from io import BytesIO
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

import pdfplumber
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import RectangleObject
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
PAGE_W, PAGE_H = 297 * 72 / 25.4, 210 * 72 / 25.4


def footer_text(source: Path) -> str:
    """Read the centered footer from the workbook's visible print sheet."""
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    with zipfile.ZipFile(source) as workbook:
        book = ET.fromstring(workbook.read("xl/workbook.xml"))
        sheet = next(s for s in book.find("s:sheets", ns)
                     if s.get("state", "visible") == "visible")
        rel_id = sheet.get(f"{{{ns['r']}}}id")
        rels = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in rels if r.get("Id") == rel_id)
        sheet_path = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
        document = ET.fromstring(workbook.read(sheet_path))
        text = document.findtext("s:headerFooter/s:oddFooter", default="", namespaces=ns)
    # This template is the front page of a two-sided paper report.
    return text.replace("&C", "").replace("&L", "").replace("&R", "").strip()


def build(output: Path, source: Path):
    office = shutil.which("soffice") or shutil.which("libreoffice")
    if not office:
        raise RuntimeError("LibreOffice is required to export the Excel form.")
    if not source.is_file():
        raise FileNotFoundError(source)
    with tempfile.TemporaryDirectory(prefix="shift-report-excel-") as temp:
        work = Path(temp)
        workbook = work / "shift-report.xlsx"
        # Keep the source's native footer for Excel users, but omit it from the
        # temporary export. It is drawn once after final A4 form alignment.
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(workbook, "w", zipfile.ZIP_DEFLATED) as temporary:
            for name in original.namelist():
                data = original.read(name)
                if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                    data = re.sub(rb"<(?:\w+:)?headerFooter\b[^>]*>.*?</(?:\w+:)?headerFooter\s*>",
                                  b"", data, flags=re.S)
                temporary.writestr(name, data)
        font_config = work / "fonts.conf"
        font_config.write_text(
            '<?xml version="1.0"?><fontconfig><include>/etc/fonts/fonts.conf</include>'
            f'<dir>{escape(str(ROOT / "public/fonts"))}</dir>'
            f'<cachedir>{escape(str(work / "font-cache"))}</cachedir></fontconfig>'
        )
        env = {**os.environ, "FONTCONFIG_FILE": str(font_config)}
        subprocess.run([
            office, f"-env:UserInstallation={(work / 'profile').as_uri()}", "--headless",
            "--convert-to", 'pdf:calc_pdf_Export:{"UseLosslessCompression":{"type":"boolean","value":"true"},"ReduceImageResolution":{"type":"boolean","value":"false"}}',
            "--outdir", str(work), str(workbook),
        ], env=env, check=True, timeout=60, capture_output=True)
        exported = work / "shift-report.pdf"
        if not exported.is_file():
            raise RuntimeError("The Excel form did not export to PDF.")
        with pdfplumber.open(exported) as pdf:
            if len(pdf.pages) != 1:
                raise RuntimeError("The Excel form must print on one landscape A4 page.")
            page = pdf.pages[0]
            # Original Excel uses continuous right borders and segmented left
            # borders. Locate the full black table frame, excluding the stamp.
            edges = [e for e in page.edges if e.get("stroking_color") == (0, 0, 0)]
            if not edges:
                raise RuntimeError("Cannot locate the outside frame for print alignment.")
            x0, x1 = min(e["x0"] for e in edges), max(e["x1"] for e in edges)
            top, bottom = min(e["top"] for e in edges), max(e["bottom"] for e in edges)
            if x1 - x0 < page.width * .6 or bottom - top < page.height * .6:
                raise RuntimeError("The Excel print area does not contain the complete report frame.")
            source_height = page.height
        target_left, target_right = 51 * PAGE_W / 2048, 1992 * PAGE_W / 2048
        target_top, target_bottom = 82 * PAGE_H / 1444, 1389 * PAGE_H / 1444
        sx = (target_right - target_left) / (x1 - x0)
        sy = (target_bottom - target_top) / (bottom - top)
        tx = target_left - sx * x0
        ty = (PAGE_H - target_bottom) - sy * (source_height - bottom)
        reader = PdfReader(exported)
        writer = PdfWriter()
        page = writer.add_blank_page(PAGE_W, PAGE_H)
        form = reader.pages[0]
        # Keep the form clip and footer separate so the footer font and bottom
        # margin are independent of form alignment.
        form.cropbox = RectangleObject([x0 - .8, source_height - bottom - .8,
                                        x1 + .8, source_height - top + .8])
        page.merge_transformed_page(form, Transformation((sx, 0, 0, sy, tx, ty)))
        label = footer_text(source)
        if label:
            font_path = ROOT / "public/fonts/Arial-Regular.ttf"
            pdfmetrics.registerFont(TTFont("ShiftReportFooter", str(font_path)))
            buffer = BytesIO()
            footer = canvas.Canvas(buffer, pagesize=(PAGE_W, PAGE_H))
            footer.setFont("ShiftReportFooter", 6.3)
            footer.drawCentredString(PAGE_W / 2, 2.7 * 72 / 25.4, label)
            footer.save()
            page.merge_page(PdfReader(buffer).pages[0])
        writer.add_metadata({
            "/Title": "Báo cáo ca - Excel template",
            "/Creator": "LibreOffice Calc (Excel source)",
            "/Producer": "LibreOffice PDF export; A4 print alignment",
        })
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("wb") as stream:
            writer.write(stream)
        print(f"Exported Excel form: {output} (alignment X={sx:.5f}, Y={sy:.5f})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "public/templates/shift-report.xlsx")
    parser.add_argument("--output", type=Path, default=ROOT / "public/templates/shift-report.pdf")
    args = parser.parse_args()
    build(args.output, args.source)
