import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFPage, type PDFFont, rgb } from "pdf-lib";

export type ReceiptPalletRow = {
  wo: string | null;
  itemcode: string;
  customer: string | null;
  product_name: string | null;
  quantity: number;
  working_day: string | null;
};

type SummaryRow = {
  wo: string;
  itemcode: string;
  customer: string;
  productName: string;
  productionDate: string;
  palletCount: number;
  totalQuantity: number;
};

const LOGO_PNG_BASE64 = "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";
const BORDER = rgb(0.12, 0.12, 0.12);
const HEADER_FILL = rgb(0.84, 0.9, 0.96);

export function safeReceiptFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function textWidth(font: PDFFont, text: string, size: number) {
  return font.widthOfTextAtSize(text, size);
}

function fitText(font: PDFFont, value: string, maxWidth: number, size: number) {
  const text = value || "-";
  if (textWidth(font, text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && textWidth(font, `${result}...`, size) > maxWidth) result = result.slice(0, -1);
  return `${result}...`;
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

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const raw = value.slice(0, 10);
  const parts = raw.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value;
}

function mergeUnique(current: string, next: string) {
  if (!next) return current;
  const values = current ? current.split(" / ").filter(Boolean) : [];
  if (!values.includes(next)) values.push(next);
  return values.join(" / ");
}

function summarizeReceiptPalletsBy(
  pallets: ReceiptPalletRow[],
  groupBy: "wo" | "itemcode",
) {
  const grouped = new Map<string, SummaryRow>();
  for (const pallet of pallets) {
    const productionDate = pallet.working_day?.slice(0, 10) ?? "";
    const wo = pallet.wo?.trim() ?? "";
    const itemcode = pallet.itemcode.trim();
    const key = [groupBy === "wo" ? wo : itemcode, productionDate].join("::");
    const current = grouped.get(key) ?? {
      wo: "",
      itemcode: "",
      customer: "",
      productName: "",
      productionDate,
      palletCount: 0,
      totalQuantity: 0,
    };
    current.wo = mergeUnique(current.wo, wo);
    current.itemcode = mergeUnique(current.itemcode, itemcode);
    current.customer = mergeUnique(current.customer, pallet.customer ?? "");
    current.productName = mergeUnique(current.productName, pallet.product_name ?? "");
    current.palletCount += 1;
    current.totalQuantity += Number(pallet.quantity) || 0;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) => {
    const primaryA = groupBy === "wo" ? a.wo : a.itemcode;
    const primaryB = groupBy === "wo" ? b.wo : b.itemcode;
    return primaryA.localeCompare(primaryB) ||
      a.productionDate.localeCompare(b.productionDate) ||
      a.itemcode.localeCompare(b.itemcode);
  });
}

export function summarizeReceiptPalletsByWo(pallets: ReceiptPalletRow[]) {
  return summarizeReceiptPalletsBy(pallets, "wo");
}

export function summarizeReceiptPalletsByItem(pallets: ReceiptPalletRow[]) {
  return summarizeReceiptPalletsBy(pallets, "itemcode");
}

function drawCenteredText(page: PDFPage, font: PDFFont, text: string, size: number, x: number, y: number, width: number) {
  page.drawText(text, { x: x + Math.max(3, (width - textWidth(font, text, size)) / 2), y, size, font });
}

function drawMultilineCell(page: PDFPage, font: PDFFont, lines: string[], size: number, x: number, y: number, width: number, height: number, fill = false) {
  page.drawRectangle({ x, y, width, height, color: fill ? HEADER_FILL : undefined, borderColor: BORDER, borderWidth: 0.7 });
  const lineHeight = size + 2;
  const blockHeight = lines.length * lineHeight - 2;
  let ty = y + (height + blockHeight) / 2 - size;
  for (const line of lines) {
    drawCenteredText(page, font, line, size, x, ty, width);
    ty -= lineHeight;
  }
}

export async function createReceiptPdf(receiptId: string, receiptDate: string, pallets: ReceiptPalletRow[], totals?: { pallets: number; quantity: number }) {
  const rows = summarizeReceiptPalletsByWo(pallets);
  const calculatedTotals = totals ?? { pallets: pallets.length, quantity: pallets.reduce((sum, pallet) => sum + Number(pallet.quantity || 0), 0) };
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(path.join(process.cwd(), "public", "fonts", "Arial-Regular.ttf")),
    readFile(path.join(process.cwd(), "public", "fonts", "Arial-Bold.ttf")),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const logo = await pdf.embedPng(Buffer.from(LOGO_PNG_BASE64, "base64"));

  const pageWidth = 841.89, pageHeight = 595.28, margin = 22, topY = pageHeight - 18;
  const titleHeight = 50, infoHeight = 25, tableHeaderHeight = 30, minimumRowHeight = 20, totalRowHeight = 20, signatureHeight = 90, codeFooterHeight = 15;
  const productTextSize = 7.3, productLineHeight = productTextSize + 2, productVerticalPadding = 6;
  const columns = [22, 70, 70, 75, 320, 70, 50, 70, 50];
  const totalColumnsWidth = columns.reduce((sum, value) => sum + value, 0);
  const startX = margin + ((pageWidth - margin * 2) - totalColumnsWidth) / 2;
  const tableTop = topY - titleHeight - infoHeight;
  const headerY = tableTop - tableHeaderHeight;
  const signatureBottom = margin + codeFooterHeight;
  const signatureTop = signatureBottom + signatureHeight;
  const totalY = signatureTop + 3;
  const regularPageCapacity = headerY - (margin + codeFooterHeight + 3);
  const finalPageCapacity = headerY - (totalY + totalRowHeight);

  const layoutRows = rows.map((row, index) => {
    const productLines = wrapText(regular, row.productName || "-", columns[4] - 6, productTextSize);
    return {
      row,
      index,
      productLines,
      height: Math.max(minimumRowHeight, productLines.length * productLineHeight + productVerticalPadding),
    };
  });

  const pages: Array<typeof layoutRows> = [];
  let rowIndex = 0;
  while (rowIndex < layoutRows.length) {
    const pageRows: typeof layoutRows = [];
    let usedHeight = 0;
    while (rowIndex < layoutRows.length) {
      const nextRow = layoutRows[rowIndex];
      if (pageRows.length && usedHeight + nextRow.height > regularPageCapacity) break;
      pageRows.push(nextRow);
      usedHeight += nextRow.height;
      rowIndex += 1;
    }
    pages.push(pageRows);
  }

  if (!pages.length) {
    pages.push([]);
  } else {
    const lastPage = pages[pages.length - 1];
    const lastPageHeight = lastPage.reduce((sum, row) => sum + row.height, 0);
    if (lastPageHeight > finalPageCapacity) {
      const finalRow = lastPage.pop();
      if (!lastPage.length) pages.pop();
      if (finalRow) pages.push([finalRow]);
    }
  }
  const pageCount = pages.length;

  const drawHeader = (page: PDFPage) => {
    const titleBottom = topY - titleHeight;
    page.drawRectangle({ x: startX, y: titleBottom, width: totalColumnsWidth, height: titleHeight, borderColor: BORDER, borderWidth: 0.8 });
    page.drawLine({ start: { x: startX + 84, y: titleBottom }, end: { x: startX + 84, y: topY }, color: BORDER, thickness: 0.8 });
    page.drawImage(logo, { x: startX + 8, y: titleBottom + 18, width: 68, height: 20 });
    drawCenteredText(page, bold, "SRITHAI (VIETNAM)", 7.5, startX, titleBottom + 4, 84);
    drawCenteredText(page, bold, "PHIẾU NHẬP KHO THÀNH PHẨM", 17, startX + 84, titleBottom + 31, totalColumnsWidth - 84);
    drawCenteredText(page, bold, "Finished Good Transfer to WH", 15, startX + 84, titleBottom + 10, totalColumnsWidth - 84);
    const infoBottom = titleBottom - infoHeight;
    page.drawRectangle({ x: startX, y: infoBottom, width: totalColumnsWidth, height: infoHeight, borderColor: BORDER, borderWidth: 0.8 });
    page.drawText("Từ Bộ phận/ Section: ÉP", { x: startX + 5, y: infoBottom + 10, size: 9.2, font: bold });
    page.drawText(`Ngày/ Date: ${formatDate(receiptDate)}`, { x: startX + 390, y: infoBottom + 10, size: 9.2, font: bold });
    page.drawText(`Số phiếu: ${receiptId}`, { x: startX + 565, y: infoBottom + 10, size: 9.2, font: bold });
  };

  const drawTableHeader = (page: PDFPage, y: number) => {
    let x = startX;
    const headers = [["STT", "No."], ["KHÁCH HÀNG", "Customer"], ["SỐ CÔNG VIỆC", "WO No."], ["MÃ SẢN PHẨM", "Item code"], ["TÊN SẢN PHẨM", "Item Name"], ["TỔNG SỐ LƯỢNG", "Total Q'ty"], ["SỐ PALLET", "Pallet Q'ty"], ["NGÀY SX", "Production Date"], ["GHI CHÚ", "Remark"]];
    headers.forEach((lines, index) => { drawMultilineCell(page, bold, lines, index === 0 ? 7.2 : 7, x, y, columns[index], tableHeaderHeight, true); x += columns[index]; });
  };

  const drawSignatureFooter = (page: PDFPage) => {
    const footerBottom = signatureBottom;
    const productionWidth = totalColumnsWidth * 0.64, warehouseWidth = totalColumnsWidth - productionWidth;
    const halfProd = productionWidth / 2, halfWh = warehouseWidth / 2;
    page.drawRectangle({ x: startX, y: footerBottom, width: totalColumnsWidth, height: signatureHeight, borderColor: BORDER, borderWidth: 0.8 });
    page.drawRectangle({ x: startX, y: footerBottom + signatureHeight - 22, width: productionWidth, height: 22, color: HEADER_FILL, borderColor: BORDER, borderWidth: 0.8 });
    page.drawRectangle({ x: startX + productionWidth, y: footerBottom + signatureHeight - 22, width: warehouseWidth, height: 22, color: HEADER_FILL, borderColor: BORDER, borderWidth: 0.8 });
    drawCenteredText(page, bold, "BỘ PHẬN SẢN XUẤT XÁC NHẬN/ Production confirmed", 9, startX, footerBottom + signatureHeight - 15, productionWidth);
    drawCenteredText(page, bold, "XÁC NHẬN CỦA KHO THÀNH PHẨM/ FG Warehouse confirmed", 9, startX + productionWidth, footerBottom + signatureHeight - 15, warehouseWidth);
    const roleY = footerBottom + signatureHeight - 40, bodyY = roleY - 36, signLineHeight = 16;
    const cells = [{ x: startX, width: halfProd, label: "Người giao/ Transferred by" }, { x: startX + halfProd, width: halfProd, label: "Người kiểm tra/ Checked by" }, { x: startX + productionWidth, width: halfWh, label: "Người nhận/ Received by" }, { x: startX + productionWidth + halfWh, width: halfWh, label: "Người phê duyệt/ Approved by" }];
    cells.forEach((cell) => {
      page.drawRectangle({ x: cell.x, y: roleY, width: cell.width, height: 18, borderColor: BORDER, borderWidth: 0.7 });
      drawCenteredText(page, regular, cell.label, 7.4, cell.x, roleY + 5.5, cell.width);
      page.drawRectangle({ x: cell.x, y: bodyY, width: cell.width, height: 36, borderColor: BORDER, borderWidth: 0.7 });
      page.drawRectangle({ x: cell.x, y: footerBottom, width: cell.width, height: signLineHeight, borderColor: BORDER, borderWidth: 0.7 });
      drawCenteredText(page, regular, "Kí-ghi rõ họ tên/ Sign-full name", 7.2, cell.x, footerBottom + 7, cell.width);
      drawCenteredText(page, regular, "........../......../..............", 7.5, cell.x, footerBottom + 1, cell.width);
    });
  };

  const drawCodeFooter = (page: PDFPage, pageNumber: number) => {
    page.drawText("Kí hiệu/ Code: QP-PRO-06-FM-03", { x: startX, y: margin + 5, size: 7.5, font: regular });
    drawCenteredText(page, regular, "Hiệu lực/ Eff. date: 24.07.2026     Lần soát xét/ Eff. date: 05", 7.5, startX + 220, margin + 5, 390);
    page.drawText(`Trang/page: ${pageNumber}/${pageCount}`, { x: startX + totalColumnsWidth - 78, y: margin + 5, size: 7.5, font: regular });
  };

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    drawHeader(page);
    drawTableHeader(page, headerY);
    const pageRows = pages[pageIndex];
    let y = headerY;
    pageRows.forEach(({ row, index: globalIndex, productLines, height }) => {
      const rowBottom = y - height;
      const values = [String(globalIndex + 1), row.customer || "-", row.wo || "-", row.itemcode, row.productName || "-", row.totalQuantity.toLocaleString("vi-VN"), String(row.palletCount), formatDate(row.productionDate), ""];
      let x = startX;
      values.forEach((value, index) => {
        page.drawRectangle({ x, y: rowBottom, width: columns[index], height, borderColor: BORDER, borderWidth: 0.65 });
        const size = index === 4 ? productTextSize : 7.6;
        if (index === 4) {
          const blockHeight = productLines.length * productLineHeight - 2;
          let textY = rowBottom + (height + blockHeight) / 2 - size;
          productLines.forEach((line) => {
            page.drawText(line, { x: x + 3, y: textY, size, font: regular });
            textY -= productLineHeight;
          });
          x += columns[index];
          return;
        }
        const display = fitText(regular, value, columns[index] - 6, size);
        const tx = x + Math.max(3, (columns[index] - textWidth(regular, display, size)) / 2);
        const textY = rowBottom + (height - size) / 2 + 3.2;
        page.drawText(display, { x: tx, y: textY, size, font: regular });
        x += columns[index];
      });
      y = rowBottom;
    });
    if (pageIndex === pageCount - 1) {
      const pageTotalY = Math.max(totalY, y - totalRowHeight);
      let x = startX;
      const firstWidth = columns.slice(0, 5).reduce((a, b) => a + b, 0);
      page.drawRectangle({ x, y: pageTotalY, width: firstWidth, height: totalRowHeight, borderColor: BORDER, borderWidth: 0.7 });
      drawCenteredText(page, bold, "TỔNG CỘNG/ TOTAL", 8, x, pageTotalY + 9, firstWidth);
      x += firstWidth;
      [calculatedTotals.quantity.toLocaleString("vi-VN"), String(calculatedTotals.pallets), "", ""].forEach((value, index) => {
        const width = columns[index + 5];
        page.drawRectangle({ x, y: pageTotalY, width, height: totalRowHeight, borderColor: BORDER, borderWidth: 0.7 });
        drawCenteredText(page, bold, value, 8, x, pageTotalY + 9, width);
        x += width;
      });
      drawSignatureFooter(page);
    }
    drawCodeFooter(page, pageIndex + 1);
  }
  return pdf.save();
}
