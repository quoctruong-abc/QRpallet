import { normalizeWarehouseItemcode } from "./itemcode";

export const MAX_MANUAL_INCOMING_ROWS = 500;
export type ManualIncomingLine = {
  itemcode: string;
  received_date: string;
  production_date: string | null;
  wo: string | null;
  quantity: number;
  note: string;
};

export function todayInVietnam(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isInventoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseManualIncomingRequest(value: unknown): { request_id: string; rows: ManualIncomingLine[] } {
  if (!value || typeof value !== "object") throw new Error("Danh sách nhập kho không hợp lệ.");
  const body = value as Record<string, unknown>;
  if (typeof body.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id)) {
    throw new Error("Mã yêu cầu nhập kho không hợp lệ.");
  }
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_MANUAL_INCOMING_ROWS) {
    throw new Error(`Mỗi lần ghi nhận từ 1 đến ${MAX_MANUAL_INCOMING_ROWS} dòng.`);
  }
  const rows = body.rows.map((value, index): ManualIncomingLine => {
    if (!value || typeof value !== "object") throw new Error(`Dòng ${index + 1} không hợp lệ.`);
    const row = value as Record<string, unknown>;
    const itemcode = normalizeWarehouseItemcode(typeof row.itemcode === "string" ? row.itemcode : "");
    if (!isInventoryDate(row.received_date)) throw new Error(`Dòng ${index + 1}: ngày nhập kho không hợp lệ.`);
    if (row.production_date !== null && row.production_date !== undefined && row.production_date !== "" && !isInventoryDate(row.production_date)) {
      throw new Error(`Dòng ${index + 1}: ngày sản xuất không hợp lệ.`);
    }
    if (typeof row.quantity !== "number" || !Number.isInteger(row.quantity) || row.quantity <= 0 || row.quantity > 2147483647) {
      throw new Error(`Dòng ${index + 1}: số lượng phải là số nguyên dương hợp lệ.`);
    }
    if (typeof row.note !== "string" || !row.note.trim() || row.note.trim().length > 2000) throw new Error(`Dòng ${index + 1}: vui lòng nhập ghi chú, tối đa 2000 ký tự.`);
    if (row.wo !== null && row.wo !== undefined && (typeof row.wo !== "string" || row.wo.trim().length > 200)) throw new Error(`Dòng ${index + 1}: WO không hợp lệ.`);
    return {
      itemcode,
      received_date: row.received_date,
      production_date: typeof row.production_date === "string" && row.production_date ? row.production_date : null,
      wo: typeof row.wo === "string" ? row.wo.trim() || null : null,
      quantity: row.quantity,
      note: row.note.trim(),
    };
  });
  return { request_id: body.request_id.toLowerCase(), rows };
}
