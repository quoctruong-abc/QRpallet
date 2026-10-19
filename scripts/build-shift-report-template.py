"""Export the editable Excel shift-report form to the application's PDF template.

Requires LibreOffice, pypdf and pdfplumber. Run from any working directory:
    python scripts/build-shift-report-template.py
The Excel file owns all text, cells, table borders and the transparent stamp image.
The final page is aligned to the existing fill coordinates after native export.
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from xml.sax.saxutils import escape

import pdfplumber
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import RectangleObject

ROOT = Path(__file__).resolve().parents[1]
PAGE_W, PAGE_H = 297 * 72 / 25.4, 210 * 72 / 25.4


def build(output: Path, source: Path):
    office = shutil.which("soffice") or shutil.which("libreoffice")
    if not office:
        raise RuntimeError("LibreOffice is required to export the Excel form.")
    if not source.is_file():
        raise FileNotFoundError(source)
    with tempfile.TemporaryDirectory(prefix="shift-report-excel-") as temp:
        work = Path(temp)
        workbook = work / "shift-report.xlsx"
        shutil.copyfile(source, workbook)
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
            edges = [e for e in page.edges if e["orientation"] == "v"
                     and .83 * page.height < e["bottom"] - e["top"] < .95 * page.height]
            if len(edges) < 2:
                raise RuntimeError("Cannot locate the outside frame for print alignment.")
            left, right = min(edges, key=lambda e: e["x0"]), max(edges, key=lambda e: e["x0"])
            x0, x1 = left["x0"], right["x0"]
            top, bottom = min(left["top"], right["top"]), max(left["bottom"], right["bottom"])
            source_height = page.height
        target_left, target_right = 51 * PAGE_W / 2048, 1992 * PAGE_W / 2048
        target_top, target_bottom = 82 * PAGE_H / 1444, 1389 * PAGE_H / 1444
        sx = (target_right - target_left) / (x1 - x0)
        sy = (target_bottom - target_top) / (bottom - top)
        tx = target_left - sx * x0
        ty = (PAGE_H - target_bottom) - sy * (source_height - bottom)
        reader = PdfReader(exported)
        page = reader.pages[0]
        page.add_transformation(Transformation((sx, 0, 0, sy, tx, ty)))
        page.mediabox = RectangleObject([0, 0, PAGE_W, PAGE_H])
        page.cropbox = RectangleObject([0, 0, PAGE_W, PAGE_H])
        writer = PdfWriter()
        writer.add_page(page)
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
