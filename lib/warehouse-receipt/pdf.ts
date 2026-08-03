import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFPage, type PDFFont, rgb } from "pdf-lib";

export type ReceiptPalletRow = {
  itemcode: string;
  customer: string | null;
  product_name: string | null;
  quantity: number;
  wo: string | null;
  working_day: string | null;
};

type SummaryRow = {
  itemcode: string;
  customer: string;
  productName: string;
  wo: string;
  productionDate: string;
  palletCount: number;
  totalQuantity: number;
};

export function safeReceiptFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function textWidth(font: PDFFont, text: string, size: number) {
  return font.widthOfTextAtSize(text, size);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const datePart = value.slice(0, 10);
  const parts = datePart.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return value;
}

function wrapText(font: PDFFont, value: string, maxWidth: number, size: number, maxLines = 3) {
  const text = (value || "-").trim();
  if (!text) return ["-"];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(font, candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;
  const joinedLength = lines.join(" ").length;
  if (joinedLength < text.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && textWidth(font, `${last}...`, size) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}...`;
  }
  return lines;
}

function drawCenteredLines(page: PDFPage, font: PDFFont, lines: string[], x: number, y: number, width: number, height: number, size: number, lineGap = 1) {
  const lineHeight = size + lineGap;
  const totalHeight = lines.length * lineHeight - lineGap;
  let ty = y + (height + totalHeight) / 2 - size;
  for (const line of lines) {
    const tx = x + (width - textWidth(font, line, size)) / 2;
    page.drawText(line, { x: tx, y: ty, size, font });
    ty -= lineHeight;
  }
}

function drawCell(page: PDFPage, x: number, y: number, width: number, height: number, fill = false) {
  page.drawRectangle({
    x, y, width, height,
    color: fill ? rgb(0.86, 0.92, 0.97) : undefined,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.8,
  });
}

export function summarizeReceiptPallets(pallets: ReceiptPalletRow[]) {
  const grouped = new Map<string, SummaryRow>();
  for (const pallet of pallets) {
    const productionDate = formatDate(pallet.working_day);
    const key = `${pallet.itemcode}::${pallet.customer ?? ""}::${pallet.product_name ?? ""}::${pallet.wo ?? ""}::${productionDate}`;
    const current = grouped.get(key) ?? {
      itemcode: pallet.itemcode,
      customer: pallet.customer ?? "",
      productName: pallet.product_name ?? "",
      wo: pallet.wo ?? "",
      productionDate,
      palletCount: 0,
      totalQuantity: 0,
    };
    current.palletCount += 1;
    current.totalQuantity += Number(pallet.quantity) || 0;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) =>
    a.itemcode.localeCompare(b.itemcode)
    || a.productionDate.localeCompare(b.productionDate)
    || a.wo.localeCompare(b.wo)
  );
}

export async function createReceiptPdf(
  receiptId: string,
  receiptDate: string,
  pallets: ReceiptPalletRow[],
  totals?: { pallets: number; quantity: number },
) {
  const rows = summarizeReceiptPallets(pallets);
  const calculatedTotals = totals ?? {
    pallets: pallets.length,
    quantity: pallets.reduce((sum, pallet) => sum + Number(pallet.quantity || 0), 0),
  };

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
  const margin = 20;
  const tableWidth = 788;
  const left = (pageWidth - tableWidth) / 2;
  const colWidths = [28, 58, 72, 78, 135, 68, 60, 64, 75, 72, 78];
  const footerHeight = 118;
  const dataRowHeight = 27;
  const tableHeaderHeight = 56;
  const contentBottom = footerHeight + 10;
  const receiptDateText = formatDate(receiptDate);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const drawDocumentHeader = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    pages.push(page);

    const top = pageHeight - margin;
    const headerBoxHeight = 66;
    page.drawRectangle({ x: margin, y: top - headerBoxHeight, width: pageWidth - margin * 2, height: headerBoxHeight, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });

    page.drawRectangle({ x: margin + 7, y: top - 45, width: 115, height: 34, color: rgb(0.91, 0.04, 0.08) });
    page.drawCircle({ x: margin + 24, y: top - 28, size: 11, color: rgb(1, 1, 1) });
    page.drawText("S", { x: margin + 20, y: top - 34, size: 16, font: bold, color: rgb(0.91, 0.04, 0.08) });
    page.drawText("Srithai", { x: margin + 39, y: top - 37, size: 18, font: bold, color: rgb(1, 1, 1) });
    page.drawText("SRITHAI (VIETNAM)", { x: margin + 10, y: top - 61, size: 8.5, font: bold });

    const titleX = margin + 135;
    const titleW = pageWidth - margin - titleX;
    page.drawLine({ start: { x: titleX, y: top - headerBoxHeight }, end: { x: titleX, y: top }, color: rgb(0,0,0), thickness: 0.8 });
    drawCenteredLines(page, bold, ["PHIẾU NHẬP KHO THÀNH PHẨM"], titleX, top - 34, titleW, 34, 18);
    drawCenteredLines(page, bold, ["Finished Good Transfer to WH"], titleX, top - 62, titleW, 28, 15);

    const infoY = top - headerBoxHeight - 30;
    page.drawLine({ start: { x: margin, y: infoY }, end: { x: pageWidth - margin, y: infoY }, color: rgb(0,0,0), thickness: 0.8 });
    page.drawText("Từ Bộ phận/ Section: ÉP", { x: margin + 4, y: infoY + 9, size: 10, font: bold });
    page.drawText("Ngày/ Date:", { x: 405, y: infoY + 9, size: 10, font: bold });
    page.drawText(receiptDateText, { x: 469, y: infoY + 9, size: 10, font: regular });
    page.drawText("Số phiếu:", { x: 605, y: infoY + 9, size: 10, font: bold });
    page.drawText(receiptId, { x: 665, y: infoY + 9, size: 10, font: regular });

    y = infoY - tableHeaderHeight;
    const headers = [
      ["STT", "No."],
      ["KHÁCH HÀNG", "Customer"],
      ["SỐ CÔNG VIỆC", "WO No."],
      ["MÃ SẢN PHẨM", "Item code"],
      ["TÊN SẢN PHẨM", "Item Name"],
      ["TỔNG SỐ LƯỢNG", "Total Q'ty"],
      ["SỐ PALLET", "Pallet Q'ty"],
      ["SỐ CÂY/ THÙNG", "Bag/ Box Q'ty"],
      ["SP MỖI CÂY/ THÙNG", "Q'ty per Bag/ Box"],
      ["NGÀY SX", "Production Date"],
      ["GHI CHÚ", "Remark"],
    ];

    let x = left;
    for (let i = 0; i < colWidths.length; i += 1) {
      drawCell(page, x, y, colWidths[i], tableHeaderHeight, true);
      const lines = headers[i];
      drawCenteredLines(page, bold, lines, x + 2, y + 2, colWidths[i] - 4, tableHeaderHeight - 4, i === 0 ? 7.2 : 7.6, 1.2);
      x += colWidths[i];
    }

    const groupStart = left + colWidths.slice(0, 5).reduce((a, b) => a + b, 0);
    const groupWidth = colWidths.slice(5, 10).reduce((a, b) => a + b, 0);
    page.drawRectangle({ x: groupStart, y: y + tableHeaderHeight - 18, width: groupWidth, height: 18, color: rgb(0.86, 0.92, 0.97), borderColor: rgb(0,0,0), borderWidth: 0.8 });
    drawCenteredLines(page, bold, ["SỐ LƯỢNG NHẬP KHO/ Quantity Transfer to FG WH (CÁI/ Pcs)"], groupStart, y + tableHeaderHeight - 18, groupWidth, 18, 7.8);
    y -= dataRowHeight;
  };

  drawDocumentHeader();

  rows.forEach((row, index) => {
    if (y < contentBottom + dataRowHeight) drawDocumentHeader();
    const values = [
      String(index + 1),
      row.customer || "-",
      row.wo || "-",
      row.itemcode || "-",
      row.productName || "-",
      row.totalQuantity.toLocaleString("vi-VN"),
      String(row.palletCount),
      "",
      "",
      row.productionDate || "-",
      "",
    ];

    let x = left;
    for (let i = 0; i < colWidths.length; i += 1) {
      drawCell(page, x, y, colWidths[i], dataRowHeight, false);
      const size = i === 4 ? 7.8 : 8.2;
      const lines = wrapText(regular, values[i], colWidths[i] - 6, size, 2);
      drawCenteredLines(page, regular, lines, x + 3, y + 2, colWidths[i] - 6, dataRowHeight - 4, size, 0.8);
      x += colWidths[i];
    }
    y -= dataRowHeight;
  });

  if (y < contentBottom + dataRowHeight) drawDocumentHeader();
  const totalValues = ["", "", "", "", "TỔNG/ TOTAL", calculatedTotals.quantity.toLocaleString("vi-VN"), String(calculatedTotals.pallets), "", "", "", ""];
  let tx = left;
  for (let i = 0; i < colWidths.length; i += 1) {
    drawCell(page, tx, y, colWidths[i], dataRowHeight, i >= 4 && i <= 6);
    if (totalValues[i]) {
      const font = i >= 4 && i <= 6 ? bold : regular;
      drawCenteredLines(page, font, [totalValues[i]], tx + 2, y + 2, colWidths[i] - 4, dataRowHeight - 4, 8.5);
    }
    tx += colWidths[i];
  }

  const drawFooter = (footerPage: PDFPage, pageIndex: number) => {
    const x = 40;
    const width = pageWidth - 80;
    const signTop = 109;
    const signHeight = 74;
    const cols = [width * 0.29, width * 0.33, width * 0.19, width * 0.19];
    const prodWidth = cols[0] + cols[1];
    const whWidth = cols[2] + cols[3];

    footerPage.drawRectangle({ x, y: signTop - signHeight, width, height: signHeight, borderColor: rgb(0,0,0), borderWidth: 0.8 });
    footerPage.drawRectangle({ x, y: signTop - 18, width: prodWidth, height: 18, color: rgb(0.86,0.92,0.97), borderColor: rgb(0,0,0), borderWidth: 0.8 });
    footerPage.drawRectangle({ x: x + prodWidth, y: signTop - 18, width: whWidth, height: 18, color: rgb(0.86,0.92,0.97), borderColor: rgb(0,0,0), borderWidth: 0.8 });
    drawCenteredLines(footerPage, bold, ["BỘ PHẬN SẢN XUẤT XÁC NHẬN/ Production confirmed"], x, signTop - 18, prodWidth, 18, 8.3);
    drawCenteredLines(footerPage, bold, ["XÁC NHẬN CỦA KHO THÀNH PHẨM/ FG Ware house confirmed"], x + prodWidth, signTop - 18, whWidth, 18, 8.3);

    const subY = signTop - 33;
    let sx = x;
    const subHeaders = [
      "Người giao/ Transfered by",
      "Người kiểm tra/ Checked by",
      "Người nhận/ Received by",
      "Người phê duyệt/ Approved by",
    ];
    cols.forEach((w, i) => {
      footerPage.drawRectangle({ x: sx, y: subY, width: w, height: 15, color: rgb(0.86,0.92,0.97), borderColor: rgb(0,0,0), borderWidth: 0.8 });
      drawCenteredLines(footerPage, regular, [subHeaders[i]], sx, subY, w, 15, 7.6);
      sx += w;
    });

    const signBodyY = signTop - signHeight;
    sx = x;
    cols.forEach((w) => {
      footerPage.drawLine({ start: { x: sx, y: signBodyY + 22 }, end: { x: sx + w, y: signBodyY + 22 }, color: rgb(0,0,0), thickness: 0.8 });
      drawCenteredLines(footerPage, regular, ["Kí-ghi rõ họ tên/ Sign-full name"], sx, signBodyY + 22, w, 14, 7.4);
      drawCenteredLines(footerPage, regular, ["........./......./............."], sx, signBodyY + 2, w, 16, 8);
      sx += w;
      if (sx < x + width) footerPage.drawLine({ start: { x: sx, y: signBodyY }, end: { x: sx, y: signTop - 18 }, color: rgb(0,0,0), thickness: 0.8 });
    });

    footerPage.drawText("Kí hiệu/ Code: QP-PRO-06-FM-03", { x: 22, y: 11, size: 7.5, font: regular });
    footerPage.drawText("Hiệu lực/ Eff. date: 24.07.2026", { x: 327, y: 11, size: 7.5, font: regular });
    footerPage.drawText("Lần soát xét/ Eff. date: 05", { x: 480, y: 11, size: 7.5, font: regular });
    footerPage.drawText(`Trang/page: ${pageIndex + 1}/${pages.length}`, { x: pageWidth - 105, y: 11, size: 7.5, font: regular });
  };

  pages.forEach(drawFooter);
  return pdf.save();
}
