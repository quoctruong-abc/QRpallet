import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";

export async function POST(request: Request) {
  const authorization = await authorizePermission("receipt.view");
  if (!authorization.ok) {
    return Response.json({ success: false, error: authorization.error }, { status: authorization.status });
  }

  const body = await request.json().catch(() => null) as { itemcode?: unknown } | null;
  let itemcode: string;
  try {
    itemcode = normalizeWarehouseItemcode(typeof body?.itemcode === "string" ? body.itemcode : "");
  } catch (error) {
    return Response.json({ success: false, error: error instanceof Error ? error.message : "Mã sản phẩm không hợp lệ." }, { status: 400 });
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
