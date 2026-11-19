import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isInventoryDate } from "@/lib/warehouse-receipt/incoming";

const fail = (error: string, status = 400) => Response.json({ success: false, error }, { status });

export async function GET(request: Request) {
  const auth = await authorizePermission("receipt.view");
  if (!auth.ok) return fail(auth.error, auth.status);
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get("offset") || 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 2147483647) return fail("Trang không hợp lệ.");

  const db = await createClient();
  const itemcode = params.get("itemcode");
  const shipped = params.get("shipped");
  const parent = params.get("parent");
  let result;
  if (parent !== null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parent) || !isInventoryDate(shipped)) return fail("Ngày xuất hoặc yêu cầu mã mẹ không hợp lệ.");
    result = await db.rpc("outgoing_parent_receipt_details", { p_shipped_date: shipped, p_parent_id: parent, p_offset: offset });
  } else if (itemcode !== null || shipped !== null) {
    if (!itemcode?.trim() || itemcode.length > 200 || !isInventoryDate(shipped)) return fail("Ngày xuất hoặc mã sản phẩm không hợp lệ.");
    result = await db.rpc("outgoing_receipt_details", { p_shipped_date: shipped, p_itemcode: itemcode, p_offset: offset });
  } else {
    let from = params.get("from") || null;
    let to = params.get("to") || null;
    if ((from || to) && (!isInventoryDate(from) || !isInventoryDate(to))) return fail("Vui lòng chọn đầy đủ Từ ngày và Đến ngày.");
    if (from && to && from > to) [from, to] = [to, from];
    result = await db.rpc("list_outgoing_receipts", { p_from: from, p_to: to, p_offset: offset });
  }
  if (result.error) {
    if (result.error.code === "PGRST202") return fail("Cần chạy migration 20261118130000_parent_outgoing_receipt_layout.sql để xem lịch sử xuất kho mẹ–con.", 503);
    if (result.error.message.includes("DELIVERY_NOT_AUTHORIZED")) return fail("Bạn không có quyền xem lịch sử xuất kho.", 403);
    console.error("Outgoing history lookup failed", result.error);
    return fail("Không tải được lịch sử xuất kho. Vui lòng thử lại.", 500);
  }
  if (parent === null && itemcode === null && result.data?.receipt_layout_version !== 1) return fail("Cần chạy migration 20261118130000_parent_outgoing_receipt_layout.sql để hiển thị lịch sử xuất kho mẹ–con.", 503);
  return Response.json({ success: true, ...result.data }, { headers: { "Cache-Control": "no-store" } });
}
