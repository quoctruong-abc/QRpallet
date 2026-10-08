import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { isShiftReportDate, type ShiftReportPlanRow, type ShiftReportPrintMode } from "./shift-report";

const mm = (value: number) => value * 72 / 25.4;
const PAGE_WIDTH = mm(297);
const PAGE_HEIGHT = mm(210);

type TextBox = { x: number; y: number; width: number; height: number; size: number; minSize?: number; bold?: boolean };

// A4 landscape, millimetres from the TOP LEFT of the supplied full-page scan.
// Both print modes MUST use these same boxes, with no printable-margin scaling.
export const SHIFT_REPORT_LAYOUT = {
  product_name: { x: 8.8, y: 25.5, width: 72.3, height: 9.9, size: 12, minSize: 4.5, bold: true },
  machine: { x: 100, y: 22.1, width: 33.8, height: 5.8, size: 11, bold: true },
  wo: { x: 157, y: 22.1, width: 44.7, height: 5.8, size: 11, bold: true },
  date: { x: 221, y: 22.1, width: 66.3, height: 5.8, size: 11 },
  material: { x: 100, y: 29.7, width: 33.8, height: 5.8, size: 10 },
  quanorder: { x: 252, y: 29.7, width: 27.1, height: 5.8, size: 10 },
  itemcode: { x: 29, y: 37.3, width: 52.1, height: 5.8, size: 11, bold: true },
  netweight: { x: 101, y: 37.3, width: 26.2, height: 5.8, size: 10 },
  color: { x: 153, y: 37.3, width: 48.7, height: 5.8, size: 10 },
  quanperh: { x: 43.5, y: 45.0, width: 18.4, height: 5.5, size: 10 },
} satisfies Record<string, TextBox>;

function cleanText(value: unknown) {
  return value === null || value === undefined ? "" : String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function numberText(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString("vi-VN", { maximumFractionDigits: 6 }) : cleanText(value);
}

function wrapText(font: PDFFont, text: string, width: number, size: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    // Long itemcodes or product tokens also wrap, without dropping characters.
    for (const character of word) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = character;
      } else line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawFitText(page: PDFPage, font: PDFFont, value: unknown, box: TextBox) {
  const text = cleanText(value);
  if (!text) return;
  const width = mm(box.width);
  const height = mm(box.height);
  for (let size = box.size; size >= (box.minSize ?? 5); size -= 0.25) {
    const lines = wrapText(font, text, width, size);
    const lineHeight = size * 1.15;
    const fontHeight = font.heightAtSize(size);
    const contentHeight = fontHeight + (lines.length - 1) * lineHeight;
    if (contentHeight > height || lines.some((line) => font.widthOfTextAtSize(line, size) > width)) continue;
    const ascent = font.heightAtSize(size, { descender: false });
    let y = PAGE_HEIGHT - mm(box.y) - (height - contentHeight) / 2 - ascent;
    for (const line of lines) {
      page.drawText(line, { x: mm(box.x), y, size, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    }
    return;
  }
  throw new Error("Thông tin quá dài để điền đủ vào ô báo ca. Vui lòng kiểm tra tên sản phẩm hoặc dữ liệu kế hoạch.");
}

export async function createShiftReportPdf(rows: ShiftReportPlanRow[], date: string, mode: ShiftReportPrintMode) {
  if (!rows.length || !isShiftReportDate(date)) throw new Error("Danh sách máy hoặc ngày báo ca không hợp lệ.");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes, templateBytes] = await Promise.all([
    readFile(path.join(process.cwd(), "public/fonts/Arial-Regular.ttf")),
    readFile(path.join(process.cwd(), "public/fonts/Arial-Bold.ttf")),
    mode === "with-background" ? readFile(path.join(process.cwd(), "public/templates/shift-report.pdf")) : Promise.resolve(null),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  // Embed once and reuse the same background on every batch page.
  const background = templateBytes ? (await pdf.embedPdf(templateBytes, [0]))[0] : null;
  const [year, month, day] = date.split("-");
  const formattedDate = `${day}/${month}/${year}`;
  for (const row of rows) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    if (background) page.drawPage(background, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
    const values = {
      product_name: row.product_name,
      machine: row.machine,
      wo: row.wo,
      date: formattedDate,
      material: row.material,
      quanorder: numberText(row.quanorder),
      itemcode: row.itemcode,
      netweight: numberText(row.netweight),
      color: row.color,
      quanperh: numberText(row.quanperh),
    };
    for (const key of Object.keys(SHIFT_REPORT_LAYOUT) as Array<keyof typeof SHIFT_REPORT_LAYOUT>) {
      const box: TextBox = SHIFT_REPORT_LAYOUT[key];
      drawFitText(page, box.bold ? bold : regular, values[key], box);
    }
  }
  pdf.setTitle(`Báo cáo ca - ${formattedDate}`);
  pdf.setCreator("SVN Warehouse");
  return pdf.save();
}
