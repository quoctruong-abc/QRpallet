import { createHash } from "node:crypto";
import type { CellValue } from "read-excel-file/node";
import { isInventoryDate } from "./incoming";
import { normalizeWarehouseItemcode } from "./itemcode";

export const MAX_OPENING_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_ROWS = 20_000;
const FIRST_DATA_ROW = 6;

type Cell = CellValue | null | undefined;

export type OpeningLine = {
  excel_row: number;
  kind: "opening" | "receipt";
  received_date: string;
  production_date: string | null;
  itemcode: string;
  product_name: string;
  wo: string | null;
  received_qty: number;
  issued_qty: number;
  balance_qty: number;
};

export type OpeningPreview = {
  fingerprint: string;
  rows: OpeningLine[];
  summary: { lines: number; opening: number; received: number; issued: number; balance: number };
};

export type OpeningResult = {
  already_imported: boolean;
  line_count: number;
  missing_customer_count: number;
};

const blank = (value: Cell) => value == null || (typeof value === "string" && value.trim() === "");

function readDate(value: Cell, order: "mdy" | "dmy", column: string): string {
  const fail = () => new Error(`Cột ${column}: ngày không hợp lệ (${order === "mdy" ? "tháng/ngày/năm" : "ngày/tháng/năm"}).`);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw fail();
    const iso = value.toISOString().slice(0, 10);
    if (!isInventoryDate(iso)) throw fail();
    return iso;
  }
  if (typeof value !== "string") throw fail();
  const match = value.trim().replace(/^'/, "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw fail();
  const [, first, second, year] = match;
  const [month, day] = order === "mdy" ? [first, second] : [second, first];
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (!isInventoryDate(iso)) throw fail();
  return iso;
}

function readQuantity(value: Cell, column: string): number {
  if (blank(value)) return 0;
  let number = typeof value === "number" ? value : NaN;
  if (typeof value === "string") {
    const raw = value.trim().replace(/^'/, "");
    if (/^\d+$/.test(raw)) number = Number(raw);
    else if (/^\d{1,3}(,\d{3})+$/.test(raw)) number = Number(raw.replaceAll(",", ""));
  }
  if (!Number.isInteger(number) || number < 0 || number > 2147483647) {
    throw new Error(`Cột ${column}: số lượng phải là số nguyên từ 0 đến 2.147.483.647.`);
  }
  return number;
}

function readText(value: Cell, column: string, max: number, allowNumber = false): string {
  if (blank(value)) return "";
  const text = typeof value === "string" ? value.trim().replace(/^'/, "").trim()
    : allowNumber && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 1e15 ? String(value) : "";
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text) || /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)$/.test(text)) {
    throw new Error(`Cột ${column}: dữ liệu không hợp lệ. Mã dài hoặc có số 0 ở đầu cần lưu dạng Text trong Excel.`);
  }
  return text;
}

export function parseOpeningInventory(sheet: Cell[][]) {
  if (sheet.length > MAX_DETAIL_ROWS + FIRST_DATA_ROW - 1) {
    throw new Error(`Sheet Detail hỗ trợ tối đa ${MAX_DETAIL_ROWS.toLocaleString("vi-VN")} dòng dữ liệu mỗi file.`);
  }
  // The parser keeps the original Excel row/column positions, including gaps.
  if (!sheet[4] || [1, 2, 3, 4, 6, 7, 8, 9, 10].some((i) => {
    const header = sheet[4][i];
    return typeof header !== "string" || !/\p{L}/u.test(header);
  })) {
    throw new Error("Dòng 5 của sheet Detail phải có tiêu đề ở các cột B–E và G–K.");
  }
  const rows: OpeningLine[] = [];
  const errors: { row: number; message: string }[] = [];
  let errorCount = 0;
  const summary = { lines: 0, opening: 0, received: 0, issued: 0, balance: 0 };
  for (let i = FIRST_DATA_ROW - 1; i < sheet.length; i++) {
    const [, b, c, d, e, , g, h, inCell, j, k] = sheet[i];
    if ([b, c, d, e, g, h, inCell, j, k].every(blank)) continue;
    try {
      const opening = readQuantity(h, "H");
      const received = readQuantity(inCell, "I");
      const issued = readQuantity(j, "J");
      const balance = readQuantity(k, "K");
      if (received > 0 || issued > 0) {
        if (blank(k) || issued > received || balance !== received - issued) {
          throw new Error(`Cột K phải bằng I − J (${received} − ${issued} = ${received - issued}) và J không được lớn hơn I.`);
        }
      } else if (balance !== 0 && balance !== opening) {
        throw new Error("Cột K không khớp: dòng chỉ có tồn đầu phải để trống, bằng 0 hoặc bằng cột H.");
      }
      if (opening === 0 && received === 0) continue;
      const rawCode = readText(d, "D", 200, true);
      if (!rawCode) throw new Error("Cột D: thiếu mã sản phẩm.");
      const productName = readText(e, "E", 500);
      if (!productName) throw new Error("Cột E: thiếu tên sản phẩm.");
      const common = {
        excel_row: i + 1, received_date: readDate(b, "mdy", "B"),
        itemcode: normalizeWarehouseItemcode(rawCode), product_name: productName, wo: readText(g, "G", 200, true) || null,
      };
      const productionDate = received > 0 && !blank(c) ? readDate(c, "dmy", "C") : null;
      if (opening > 0) {
        rows.push({ ...common, kind: "opening", production_date: null, received_qty: opening, issued_qty: 0, balance_qty: opening });
      }
      if (received > 0) {
        rows.push({ ...common, kind: "receipt", production_date: productionDate, received_qty: received, issued_qty: issued, balance_qty: balance });
      }
      summary.opening += opening;
      summary.received += received;
      summary.issued += issued;
      summary.balance += opening + (received - issued);
    } catch (error) {
      errorCount++;
      if (errors.length < 100) errors.push({ row: i + 1, message: error instanceof Error ? error.message : "Dữ liệu không hợp lệ." });
    }
  }
  summary.lines = rows.length;
  if (!rows.length && !errorCount) throw new Error("Không có dòng tồn đầu hoặc số lượng nhập hợp lệ trong sheet Detail.");
  return { rows, summary, errors, errorCount };
}

export function openingFingerprint(rows: OpeningLine[]) {
  const values = rows.map((row) => JSON.stringify([
    row.kind, row.received_date, row.production_date, row.itemcode, row.wo,
    row.received_qty, row.issued_qty, row.balance_qty,
  ])).sort();
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
