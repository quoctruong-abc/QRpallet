import { authorizeWarehouse, hasPermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseManualIncomingRequest } from "@/lib/warehouse-receipt/incoming";

const fail = (error: string, status = 400) => Response.json({ success: false, error }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function dbError(error: { code?: string; message?: string }) {
  const message = error.message || "";
  if (message.includes("NOT_AUTHORIZED")) return fail("Bạn không có quyền duyệt hoặc chỉnh sửa đề xuất nhập kho.", 403);
  if (message.includes("INV_PROPOSAL_STALE")) return fail("Đề xuất đã được sửa, xóa hoặc duyệt ở phiên khác. Tải lại danh sách trước khi tiếp tục.", 409);
  if (message.includes("INV_REQUEST_CONFLICT")) return fail("Mã thao tác đã được dùng cho nội dung khác. Tải lại và kiểm tra lần ghi nhận trước.", 409);
  if (message.includes("INV_ITEM_NOT_FOUND:")) {
    const itemcode = message.split("INV_ITEM_NOT_FOUND:")[1];
    return Response.json({ success: false, itemcode, error: `Item ${itemcode} chưa có thông tin hợp lệ. Vui lòng cập nhật database.` }, { status: 404 });
  }
  if (["PGRST202", "42883", "42P01"].includes(error.code || "")) return fail("Cần chạy migration 20261118140000_warehouse_permissions.sql và 20261118150000_incoming_supervisor_approval.sql.", 503);
  if (message.includes("INV_INVALID") || ["22P02", "22003", "22007", "22008", "23514"].includes(error.code || "")) return fail("Kiểm tra mã sản phẩm, số lượng, ngày nhập và ngày sản xuất của các dòng đã chọn.");
  console.error("Incoming proposal failed", error);
  return fail("Chưa xác nhận được kết quả. Giữ nguyên thao tác và thử lại để tránh ghi trùng.", 500);
}

export async function GET(request: Request) {
  const auth = await authorizeWarehouse();
  if (!auth.ok) return fail(auth.error, auth.status);
  const offset = Number(new URL(request.url).searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) return fail("Trang không hợp lệ.");
  const db = await createClient();
  const { data, error } = await db.rpc("list_incoming_proposals", { p_offset: offset });
  if (error) return dbError(error);
  return Response.json({ success: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizeWarehouse();
  if (!auth.ok) return fail(auth.error, auth.status);
  const input = await request.json().catch(() => null);
  if (!input || input.profile_id !== auth.profile.id) return fail("Tài khoản đã thay đổi. Tải lại trang trước khi tiếp tục.", 403);
  const action = input.action ?? "propose";
  if (!["propose", "approve", "edit", "delete"].includes(action)) return fail("Thao tác không hợp lệ.");
  if (action !== "propose" && !hasPermission(auth.profile, "edit-WH")) return fail("Bạn cần quyền edit-WH để duyệt hoặc chỉnh sửa đề xuất nhập kho.", 403);
  const db = await createClient();
  if (action === "propose") {
    let body: ReturnType<typeof parseManualIncomingRequest>;
    try { body = parseManualIncomingRequest(input); }
    catch (error) { return fail(error instanceof Error ? error.message : "Đề xuất không hợp lệ."); }
    const { data, error } = await db.rpc("propose_manual_inventory", { p_request_id: body.request_id, p_rows: body.rows });
    if (error) return dbError(error);
    return Response.json({ success: true, batch: data?.[0], proposed: true });
  }
  if (action === "approve") {
    if (!uuid(input.request_id) || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 500
      || !input.rows.every((row: { id?: unknown; version?: unknown } | null) => row && uuid(row.id) && Number.isSafeInteger(row.version) && Number(row.version) > 0)) return fail("Danh sách duyệt không hợp lệ.");
    const { data, error } = await db.rpc("approve_incoming_proposals", { p_request_id: input.request_id, p_rows: input.rows });
    if (error) return dbError(error);
    return Response.json({ success: true, batch: data?.[0] });
  }
  if (!uuid(input.id) || !Number.isSafeInteger(input.version) || input.version < 1) return fail("Dòng đề xuất không hợp lệ.");
  let row = null;
  if (action === "edit") {
    try { row = parseManualIncomingRequest({ request_id: input.id, rows: [input.row] }).rows[0]; }
    catch (error) { return fail(error instanceof Error ? error.message : "Dòng đề xuất không hợp lệ."); }
  }
  const { data, error } = await db.rpc("edit_incoming_proposal", { p_id: input.id, p_version: input.version, p_row: row, p_delete: action === "delete" });
  if (error) return dbError(error);
  return Response.json({ success: true, result: data });
}
