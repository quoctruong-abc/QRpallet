import { isInventoryDate } from "./incoming";
import { normalizeWarehouseItemcode } from "./itemcode";

export type DeliveryInput = {
  excel_row: number;
  delivery_date: string;
  purorder: string;
  sales_id: string;
  itemcode: string;
  product_name: string;
  customer: string;
  unit: "EA" | "SET";
  unit_label: string;
  ordered_qty: number;
};
export type DeliveryRequest = DeliveryInput & {
  id: string; shipped_qty: number; reserved_qty: number; shortage_qty: number;
  cancelled: boolean; version: number; status: "pending" | "partial" | "done" | "cancelled";
};
export type DeliveryCandidate = {
  id: string; delivery_date: string; ordered_qty: number; shipped_qty: number; reserved_qty: number;
  version: number; unit: string; cancelled: boolean;
};
export type DeliveryPreviewLine = DeliveryInput & {
  existing: DeliveryCandidate | null; candidates: DeliveryCandidate[];
  available_qty: number; suggested_reserved: number; shortage_qty: number;
};
export type DeliveryHistory = {
  id: string; quantity: number; shipped_date: string; created_at: string; entered_by_name: string;
  allocations: { incoming_id: number; quantity: number; production_date: string | null; received_date: string }[];
};
export const MAX_DELIVERY_ROWS = 500;

export function parseDeliveryDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const text = value.trim().replace(/^'/, "");
    if (isInventoryDate(text)) return text;
    // Text in this ERP report is interpreted as day/month/year.
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (match) {
      const date = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
      if (isInventoryDate(date)) return date;
    }
  }
  throw new Error("Ngày giao hàng không hợp lệ.");
}

function text(value: unknown, label: string, max = 200) {
  const result = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) throw new Error(`${label} không hợp lệ.`);
  return result;
}

export function parseDeliverySheet(sheet: unknown[][]) {
  const header = sheet.findIndex((row) => String(row[1] ?? "").replace(/\s/g, "").toLowerCase() === "deliverydate"
    && String(row[13] ?? "").replace(/\s/g, "").toLowerCase() === "salesid"
    && String(row[18] ?? "").trim().toLowerCase() === "item");
  if (header < 0) throw new Error("Không nhận diện được header Delivery Date / Sales Id / Item.");
  if (sheet.length > 25000) throw new Error("File vượt giới hạn 25.000 dòng.");
  const rows: DeliveryInput[] = [];
  const errors: { row: number; message: string }[] = [];
  const seen = new Map<string, number>();
  for (let i = header + 1; i < sheet.length; i++) {
    const cells = sheet[i];
    // Detail rows have a numeric No. Ignore report headings and signature/footer areas.
    const no = cells[16];
    if (no == null && cells[18] == null) continue;
    if (!/^\d+$/.test(String(no ?? "").trim())) {
      if (cells[18] != null && typeof cells[28] === "number") errors.push({ row: i + 1, message: "Dòng hàng thiếu số thứ tự No." });
      continue;
    }
    try {
      const qty = typeof cells[28] === "number" ? cells[28] : /^\d+$/.test(String(cells[28] ?? "").trim()) ? Number(cells[28]) : NaN;
      if (!Number.isInteger(qty) || qty <= 0 || qty > 2147483647) throw new Error("Sales Qty phải là số nguyên dương.");
      const label = text(cells[31], "Đơn vị").normalize("NFC");
      const normalizedUnit = label.toLowerCase();
      const unit = ["pcs", "cái", "cai", "ea", "pc"].includes(normalizedUnit) ? "EA"
        : ["bộ", "bo", "set"].includes(normalizedUnit) ? "SET" : null;
      if (!unit) throw new Error(`Đơn vị ${label} chưa được hỗ trợ; cần quy đổi trước khi nạp.`);
      const row: DeliveryInput = {
        excel_row: i + 1, delivery_date: parseDeliveryDate(cells[1]),
        purorder: text(cells[8], "Purchorder"), sales_id: text(cells[13], "Sales ID"),
        itemcode: normalizeWarehouseItemcode(text(cells[18], "Item")),
        product_name: typeof cells[23] === "string" ? cells[23].trim() : "",
        customer: typeof cells[3] === "string" ? cells[3].trim() : "",
        unit, unit_label: label, ordered_qty: qty,
      };
      const key = JSON.stringify([row.purorder, row.sales_id, row.itemcode, row.delivery_date]);
      if (seen.has(key)) throw new Error(`Trùng khóa với dòng ${seen.get(key)}. Kiểm tra/gộp dòng trên ERP trước khi nạp.`);
      seen.set(key, i + 1);
      rows.push(row);
    } catch (error) {
      errors.push({ row: i + 1, message: error instanceof Error ? error.message : "Dữ liệu không hợp lệ." });
    }
  }
  if (rows.length > MAX_DELIVERY_ROWS) throw new Error(`Mỗi file tối đa ${MAX_DELIVERY_ROWS} dòng hàng.`);
  if (!rows.length && !errors.length) throw new Error("Không tìm thấy dòng hàng trong file.");
  return { rows, errors };
}
