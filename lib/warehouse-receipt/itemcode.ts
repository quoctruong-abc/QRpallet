export function normalizeWarehouseItemcode(value: string): string {
  const itemcode = value.trim();
  if (!itemcode || itemcode.length > 200) {
    throw new Error("Vui lòng nhập mã sản phẩm hợp lệ.");
  }
  if (!itemcode.includes("*")) return itemcode;

  const parts = itemcode.split("*");
  const fixedLength = itemcode.length - 1;
  if (parts.length !== 2 || fixedLength < 1 || fixedLength >= 13 || /\s/.test(itemcode)) {
    throw new Error("Mã viết tắt cần một dấu * và từ 1 đến 12 ký tự còn lại để điền số 0 cho đủ 13 ký tự.");
  }
  return parts[0] + "0".repeat(13 - fixedLength) + parts[1];
}
