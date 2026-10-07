import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

export type WoReceiptPdfRow = {
  wo: string;
  pallet_id: string;
  itemcode: string;
  product_name: string;
  quantity: number;
  working_day: string | null;
  created_at: string;
};

const BORDER = rgb(0.25, 0.29, 0.35);
const HEADER_FILL = rgb(0.92, 0.95, 0.98);
const TEXT = rgb(0.08, 0.1, 0.14);

function formatDate(value: string | null) {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatVietnamDateTime(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function textWidth(font: PDFFont, text: string, size: number) {
  return font.widthOfTextAtSize(text, size);
}

function wrapText(font: PDFFont, value: string, maxWidth: number, size: number) {
  const text = value || "-";
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(font, candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) lines.push(line);
      if (textWidth(font, word, size) <= maxWidth) {
        line = word;
        continue;
      }

      let chunk = "";
      for (const character of word) {
        const nextChunk = `${chunk}${character}`;
        if (chunk && textWidth(font, nextChunk, size) > maxWidth) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk = nextChunk;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }

  return lines.length ? lines : ["-"];
}

function drawCell(
  page: PDFPage,
  font: PDFFont,
  lines: string[],
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
  options?: { fill?: boolean; align?: "left" | "center" | "right" },
) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: options?.fill ? HEADER_FILL : undefined,
    borderColor: BORDER,
    borderWidth: 0.65,
  });

  const lineHeight = size + 2;
  const contentHeight = lines.length * lineHeight - 2;
  let textY = y + (height + contentHeight) / 2 - size;
  for (const line of lines) {
    const lineWidth = textWidth(font, line, size);
    const textX = options?.align === "center"
      ? x + Math.max(3, (width - lineWidth) / 2)
      : options?.align === "right"
        ? x + Math.max(3, width - lineWidth - 4)
        : x + 4;
    page.drawText(line, { x: textX, y: textY, size, font, color: TEXT });
    textY -= lineHeight;
  }
}

export async function createWoReceiptPdf(wos: string[], pallets: WoReceiptPdfRow[], printedAt: Date) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(path.join(process.cwd(), "public", "fonts", "Arial-Regular.ttf")),
    readFile(path.join(process.cwd(), "public", "fonts", "Arial-Bold.ttf")),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });

  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const margin = 24;
  const footerHeight = 24;
  const tableHeaderHeight = 28;
  const rowFontSize = 7.5;
  const lineHeight = rowFontSize + 2;
  const columns = [74, 116, 82, 220, 55, 76, 133];
  const headers = ["WO", "PALLET ID", "ITEMCODE", "TÊN SẢN PHẨM", "SỐ LƯỢNG", "WORKING DAY", "THỜI GIAN IN TEM"];
  const totalWidth = columns.reduce((sum, width) => sum + width, 0);
  const startX = margin + (pageWidth - margin * 2 - totalWidth) / 2;
  const pages: PDFPage[] = [];
  const printedAtText = formatVietnamDateTime(printedAt);
  const woLines = wrapText(regular, `WO: ${wos.join(", ")}`, totalWidth, 9);

  let page: PDFPage;
  let currentY = 0;

  const drawTableHeader = () => {
    let x = startX;
    currentY -= tableHeaderHeight;
    headers.forEach((header, index) => {
      drawCell(
        page,
        bold,
        wrapText(bold, header, columns[index] - 8, 7.2),
        x,
        currentY,
        columns[index],
        tableHeaderHeight,
        7.2,
        { fill: true, align: "center" },
      );
      x += columns[index];
    });
  };

  const addPage = (firstPage: boolean) => {
    page = pdf.addPage([pageWidth, pageHeight]);
    pages.push(page);
    page.drawText("WO receipt", {
      x: startX,
      y: pageHeight - margin - 18,
      size: 18,
      font: bold,
      color: TEXT,
    });

    if (firstPage) {
      let woY = pageHeight - margin - 39;
      for (const line of woLines) {
        page.drawText(line, { x: startX, y: woY, size: 9, font: regular, color: TEXT });
        woY -= 12;
      }
      currentY = woY - 4;
    } else {
      page.drawText("Danh sách pallet (tiếp theo)", {
        x: startX,
        y: pageHeight - margin - 36,
        size: 9,
        font: regular,
        color: TEXT,
      });
      currentY = pageHeight - margin - 48;
    }

    drawTableHeader();
  };

  addPage(true);

  for (const pallet of pallets) {
    const values = [
      pallet.wo,
      pallet.pallet_id,
      pallet.itemcode,
      pallet.product_name,
      pallet.quantity.toLocaleString("vi-VN"),
      formatDate(pallet.working_day),
      formatVietnamDateTime(pallet.created_at),
    ];
    const cellLines = values.map((value, index) => (
      wrapText(regular, value || "-", columns[index] - 8, rowFontSize)
    ));
    const maxLines = Math.max(...cellLines.map((lines) => lines.length));
    const rowHeight = Math.max(23, maxLines * lineHeight + 8);

    if (currentY - rowHeight < margin + footerHeight) addPage(false);

    currentY -= rowHeight;
    let x = startX;
    cellLines.forEach((lines, index) => {
      const align = index === 4 ? "right" : index === 5 || index === 6 ? "center" : "left";
      drawCell(page, regular, lines, x, currentY, columns[index], rowHeight, rowFontSize, { align });
      x += columns[index];
    });
  }

  pages.forEach((pdfPage, index) => {
    pdfPage.drawLine({
      start: { x: startX, y: margin + 16 },
      end: { x: startX + totalWidth, y: margin + 16 },
      color: BORDER,
      thickness: 0.6,
    });
    pdfPage.drawText(`Thời gian in: ${printedAtText}`, {
      x: startX,
      y: margin + 4,
      size: 8,
      font: regular,
      color: TEXT,
    });
    const pageText = `Trang ${index + 1}/${pages.length}`;
    pdfPage.drawText(pageText, {
      x: startX + totalWidth - textWidth(regular, pageText, 8),
      y: margin + 4,
      size: 8,
      font: regular,
      color: TEXT,
    });
  });

  return pdf.save();
}
