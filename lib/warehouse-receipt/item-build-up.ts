import { MAX_MASTER_ROWS } from "./master-data";

export type ItemBuildUpRow = {
  excel_row: number;
  parent_itemcode: string;
  child_itemcode_1: string | null;
  child_itemcode_2: string | null;
  child_itemcode_3: string | null;
};

const headerKey = (value: string) => value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replaceAll("đ", "d").replace(/[^a-z0-9]/g, "");
const parentHeaders = new Set(["codeme", "itemcodeme", "itemcodecha", "mame", "mahangme", "masanphamme", "parentitemcode", "parentcode", "parentitem", "parent"]);
const codePattern = /^[^\s*\u0000]{1,200}$/u;

function code(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

export function parseWarehouseItemBuildUp(sheet: readonly (readonly unknown[])[]) {
  const rows: ItemBuildUpRow[] = [];
  const errors: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  let errorCount = 0;
  let duplicateCount = 0;
  let count = 0;
  let first = true;
  const positions = ["C", "E", "G"];

  for (let index = 0; index < sheet.length; index++) {
    const row = index + 1;
    const [a, , c, , e, , g] = sheet[index];
    const parent = code(a);
    const children = [code(c), code(e), code(g)];
    if (parent === null && children.every((child) => child === null)) continue;
    if (first) {
      first = false;
      if (parent && parentHeaders.has(headerKey(parent))
        && children.some((child) => child && /^(?:(?:item)?codecon|macon|child(?:item)?code|childitem)\d*$/.test(headerKey(child)))) continue;
    }
    if (++count > MAX_MASTER_ROWS) throw new Error("Mỗi file được nạp tối đa 20.000 dòng dữ liệu.");

    const invalidChild = children.findIndex((child) => child === undefined || (child !== null && !codePattern.test(child)));
    if (!parent || !codePattern.test(parent) || invalidChild >= 0 || children.every((child) => child === null)) {
      errorCount++;
      if (errors.length < 100) errors.push({ row, message: !parent || !codePattern.test(parent)
        ? "Itemcode mẹ cột A không hợp lệ."
        : invalidChild >= 0 ? `Itemcode con cột ${positions[invalidChild]} không hợp lệ.`
          : "Cần có ít nhất một itemcode con ở cột C, E hoặc G." });
      continue;
    }

    const [child_itemcode_1, child_itemcode_2, child_itemcode_3] = children.map((child) => child ?? null);
    const key = JSON.stringify([parent, child_itemcode_1, child_itemcode_2, child_itemcode_3]);
    if (seen.has(key)) { duplicateCount++; continue; }
    seen.add(key);
    rows.push({ excel_row: row, parent_itemcode: parent, child_itemcode_1, child_itemcode_2, child_itemcode_3 });
  }
  if (!rows.length && !errorCount) throw new Error("Sheet Master Data không có dữ liệu ở các cột A, C, E và G.");
  return { rows, errors, errorCount, duplicateCount };
}
