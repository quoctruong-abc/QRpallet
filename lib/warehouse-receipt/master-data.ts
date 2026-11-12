export const MAX_MASTER_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_MASTER_ROWS = 20_000;
export const MAX_MASTER_WEIGHT = 1e15;

export type MasterDataRow = { excel_row: number; itemcode: string; erp_name: string; netweight: number | null };
export type MasterDataCounts = { inserted: number; updated: number; unchanged: number };
export type MasterDataPreview = { fingerprint: string; counts: MasterDataCounts; rows: MasterDataRow[]; duplicateCount: number };

const textCell = (value: unknown) => typeof value === "string" ? value.trim() : "";
const empty = (value: unknown) => value == null || (typeof value === "string" && !value.trim());
const headerKey = (value: unknown) => textCell(value).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replaceAll("đ", "d").replace(/[^a-z0-9]/g, "");
const codeHeaders = new Set(["item", "itemcode", "itemnumber", "itemno", "itemid", "code", "productcode", "productnumber", "materialcode", "materialnumber", "mahang", "masanpham", "masp", "mavattu", "ma"]);
const nameHeaders = new Set(["name", "itemname", "productname", "materialname", "itemdescription", "productdescription", "description", "erpname", "ten", "tenhang", "tensanpham", "tenvattu"]);
const weightHeaders = /^(netweight|weight|khoiluong|trongluong)(kg|g|lb)?$/;

function itemCode(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return textCell(value);
}

function weight(value: unknown): number | null {
  if (empty(value)) return null;
  let normalized = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(text)) normalized = text.replaceAll(".", "").replace(",", ".");
    else if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(text)) normalized = text.replaceAll(",", "");
    else if (/^[+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text)) normalized = text.replace(",", ".");
    else return NaN;
  }
  if (typeof normalized !== "string" && typeof normalized !== "number") return NaN;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_MASTER_WEIGHT ? amount : NaN;
}

export function parseWarehouseMasterData(sheet: readonly (readonly unknown[])[]) {
  const rows = new Map<string, MasterDataRow>();
  const errors: { row: number; message: string }[] = [];
  let errorCount = 0;
  let duplicateCount = 0;
  let first = true;
  let count = 0;
  for (let index = 0; index < sheet.length; index++) {
    const row = index + 1;
    const [a, b, , , , f] = sheet[index];
    if ([a, b, f].every(empty)) continue;
    if (first) {
      first = false;
      if (codeHeaders.has(headerKey(a)) && (nameHeaders.has(headerKey(b)) || weightHeaders.test(headerKey(f)))) continue;
    }
    if (++count > MAX_MASTER_ROWS) throw new Error("Mỗi file được nạp tối đa 20.000 dòng dữ liệu.");
    const itemcode = itemCode(a);
    const erp_name = textCell(b);
    const netweight = weight(f);
    const previous = rows.get(itemcode);
    let message = "";
    if (!itemcode || itemcode.length > 200 || /[\s*\u0000]/u.test(itemcode)) message = "Mã sản phẩm cột A không hợp lệ.";
    else if (!erp_name || erp_name.length > 500 || erp_name.includes("\u0000")) message = "Tên ERP cột B phải có từ 1 đến 500 ký tự.";
    else if (Number.isNaN(netweight)) message = "Khối lượng cột F phải là số không âm hợp lệ.";
    else if (previous && (previous.erp_name !== erp_name || previous.netweight !== netweight)) {
      message = `Mã ${itemcode} trùng dòng ${previous.excel_row} nhưng khác tên ERP hoặc khối lượng.`;
    }
    if (message) {
      errorCount++;
      if (errors.length < 100) errors.push({ row, message });
    } else if (previous) duplicateCount++;
    else rows.set(itemcode, { excel_row: row, itemcode, erp_name, netweight });
  }
  if (!rows.size && !errorCount) throw new Error("Sheet data không có dữ liệu ở các cột A, B và F.");
  return { rows: [...rows.values()], errors, errorCount, duplicateCount };
}
