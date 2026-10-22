import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const authorization = await authorizePermission("receipt.view");
  if (!authorization.ok) {
    return Response.json({ success: false, error: authorization.error }, { status: authorization.status });
  }

  const body = await request.json().catch(() => null) as { itemcode?: unknown } | null;
  const itemcode = typeof body?.itemcode === "string" ? body.itemcode.trim() : "";
  if (!itemcode || itemcode.length > 200) {
    return Response.json({ success: false, error: "Vui lòng nhập mã sản phẩm hợp lệ." }, { status: 400 });
  }

  try {
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.rpc("resolve_warehouse_item", { p_itemcode: itemcode });
    if (error) throw error;
    const item = data?.[0];
    if (!item) {
      return Response.json(
        { success: false, error: "Không tìm thấy item, vui lòng cập nhật database" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json({ success: true, item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Warehouse item lookup failed", { itemcode, error });
    return Response.json(
      { success: false, error: "Không thể tra cứu sản phẩm. Vui lòng thử lại." },
      { status: 500 },
    );
  }
}
