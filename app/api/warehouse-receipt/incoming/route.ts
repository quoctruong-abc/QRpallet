import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseManualIncomingRequest } from "@/lib/warehouse-receipt/incoming";

export async function POST(request: Request) {
  const authorization = await authorizePermission("receipt.view");
  if (!authorization.ok) return Response.json({ success: false, error: authorization.error }, { status: authorization.status });

  let body: ReturnType<typeof parseManualIncomingRequest>;
  try {
    body = parseManualIncomingRequest(await request.json().catch(() => null));
  } catch (error) {
    return Response.json({ success: false, error: error instanceof Error ? error.message : "Dữ liệu nhập kho không hợp lệ." }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("post_manual_inventory", { p_request_id: body.request_id, p_rows: body.rows });
    if (error) {
      const message = error.message || "";
      if (message.includes("INV_ITEM_NOT_FOUND:")) {
        const itemcode = message.slice(message.indexOf("INV_ITEM_NOT_FOUND:") + "INV_ITEM_NOT_FOUND:".length).trim();
        return Response.json({ success: false, itemcode, error: "Không tìm thấy item, vui lòng cập nhật database" }, { status: 404 });
      }
      if (message.includes("NOT_AUTHORIZED")) return Response.json({ success: false, error: "Bạn không có quyền nhập kho." }, { status: 403 });
      if (message.includes("INV_REQUEST_CONFLICT")) return Response.json({ success: false, error: "Mã yêu cầu đã được dùng cho danh sách khác. Vui lòng tải lại trang và kiểm tra lần nhập trước." }, { status: 409 });
      if (message.includes("INV_INVALID_")) return Response.json({ success: false, error: "Danh sách có ngày nhập, số lượng hoặc thông tin không hợp lệ. Vui lòng kiểm tra lại." }, { status: 400 });
      throw error;
    }
    if (!data?.[0]) throw new Error("Missing inventory posting result");
    return Response.json({ success: true, batch: data[0] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Post manual inventory failed", { requestId: body.request_id, error });
    return Response.json({ success: false, error: "Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại để kiểm tra và tránh ghi trùng." }, { status: 500 });
  }
}
