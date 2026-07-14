import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFPage, type PDFFont, rgb } from "pdf-lib";

export type ReceiptPalletRow = {
  itemcode: string;
  customer: string | null;
  product_name: string | null;
  quantity: number;
};

type SummaryRow = {
  itemcode: string;
  customer: string;
  productName: string;
  palletCount: number;
  totalQuantity: number;
};

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

export function summarizeReceiptPallets(pallets: ReceiptPalletRow[]) {
  const grouped = new Map<string, SummaryRow>();
  for (const pallet of pallets) {
    const key = `${pallet.itemcode}::${pallet.customer ?? ""}::${pallet.product_name ?? ""}`;
    const current = grouped.get(key) ?? {
      itemcode: pallet.itemcode,
      customer: pallet.customer ?? "",
      productName: pallet.product_name ?? "",
      palletCount: 0,
      totalQuantity: 0,
    };
    current.palletCount += 1;
    current.totalQuantity += Number(pallet.quantity) || 0;
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) => a.itemcode.localeCompare(b.itemcode));
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
  const margin = 34;
  const rowHeight = 25;
  const headerHeight = 30;
  const columns = [105, 105, 245, 100, 120];
  const headers = ["ITEM CODE", "CUSTOMER", "PRODUCT NAME", "TOTAL PALLET", "TOTAL QUANTITY"];
  let page!: PDFPage;
  let y = 0;

  const drawPageHeader = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    page.drawText("PHIEU NHAP KHO THANH PHAM", { x: margin, y: pageHeight - 48, size: 18, font: bold });
    page.drawText("FINISHED GOODS WAREHOUSE RECEIPT", { x: margin, y: pageHeight - 67, size: 9, font: regular });
    page.drawText(`ID: ${receiptId}`, { x: pageWidth - margin - 220, y: pageHeight - 45, size: 11, font: bold });
    page.drawText(`Date: ${receiptDate.split("-").reverse().join("/")}`, { x: pageWidth - margin - 220, y: pageHeight - 63, size: 10, font: regular });
    y = pageHeight - 105;
    let x = margin;
    headers.forEach((header, index) => {
      page.drawRectangle({
        x,
        y,
        width: columns[index],
        height: headerHeight,
        color: rgb(0.91, 0.94, 0.98),
        borderColor: rgb(0.25, 0.32, 0.42),
        borderWidth: 0.8,
      });
      page.drawText(header, { x: x + 6, y: y + 10, size: 8.2, font: bold });
      x += columns[index];
    });
    y -= rowHeight;
  };

  drawPageHeader();
  rows.forEach((row) => {
    if (y < 110) drawPageHeader();
    const values = [
      row.itemcode,
      row.customer || "-",
      row.productName || "-",
      String(row.palletCount),
      row.totalQuantity.toLocaleString("vi-VN"),
    ];
    let x = margin;
    values.forEach((value, index) => {
      page.drawRectangle({ x, y, width: columns[index], height: rowHeight, borderColor: rgb(0.45, 0.48, 0.52), borderWidth: 0.6 });
      const centered = index >= 3;
      const display = fitText(regular, value, columns[index] - 12, 9);
      const tx = centered ? x + (columns[index] - textWidth(regular, display, 9)) / 2 : x + 6;
      page.drawText(display, { x: tx, y: y + 8, size: 9, font: regular });
      x += columns[index];
    });
    y -= rowHeight;
  });

  if (y < 105) drawPageHeader();
  y -= 8;
  page.drawText(`TOTAL: ${calculatedTotals.pallets} pallet(s)`, { x: margin + 420, y, size: 10, font: bold });
  page.drawText(`${calculatedTotals.quantity.toLocaleString("vi-VN")} pcs`, { x: margin + 565, y, size: 10, font: bold });
  const signY = 45;
  page.drawText("PRODUCTION", { x: margin + 125, y: signY + 45, size: 10, font: bold });
  page.drawText("Signature / Full name", { x: margin + 105, y: signY + 27, size: 8, font: regular });
  page.drawText("WAREHOUSE", { x: pageWidth - margin - 190, y: signY + 45, size: 10, font: bold });
  page.drawText("Signature / Full name", { x: pageWidth - margin - 205, y: signY + 27, size: 8, font: regular });
  return pdf.save();
}
