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
  let result;
  if (itemcode !== null || shipped !== null) {
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
    if (result.error.code === "PGRST202") return fail("Cần chạy migration 20261106150000_outgoing_receipt_history.sql để xem lịch sử xuất kho.", 503);
    if (result.error.message.includes("DELIVERY_NOT_AUTHORIZED")) return fail("Bạn không có quyền xem lịch sử xuất kho.", 403);
    console.error("Outgoing history lookup failed", result.error);
    return fail("Không tải được lịch sử xuất kho. Vui lòng thử lại.", 500);
  }
  return Response.json({ success: true, ...result.data }, { headers: { "Cache-Control": "no-store" } });
}
