import { authorizeProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const actions = new Set(["lookup", "customers", "save_item", "save_build_up"]);
const fail = (error: string, status: number) => Response.json({ success: false, error }, { status });

export async function POST(request: Request) {
  const auth = await authorizeProfile();
  if (!auth.ok) return fail(auth.error, auth.status);
  if (auth.profile.role !== "superadmin") return fail("Chỉ Super Admin có quyền cập nhật danh mục kho.", 403);
  const input = await request.json().catch(() => null);
  if (!input || !actions.has(input.action) || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    return fail("Dữ liệu không hợp lệ.", 400);
  }
  const db = await createClient();
  const { data, error } = await db.rpc("warehouse_catalog_manage", { p_action: input.action, p_payload: input.payload });
  if (error || !data) {
    const message = error?.message ?? "";
    if (message.includes("WAREHOUSE_CATALOG_FORBIDDEN")) return fail("Chỉ Super Admin có quyền cập nhật danh mục kho.", 403);
    if (message.includes("WAREHOUSE_CATALOG_UNKNOWN_CUSTOMER")) return fail("Khách hàng không còn trong danh sách. Mở lại form để cập nhật.", 409);
    if (message.includes("WAREHOUSE_CATALOG_CONFIRM_REPLACEMENT")) return fail("Mã mẹ đã có tổ hợp. Hãy tra lại và chọn tổ hợp cần thay thế.", 409);
    if (message.includes("WAREHOUSE_CATALOG_STALE_RECIPE")) return fail("Tổ hợp đã thay đổi. Hãy tra lại trước khi thay thế.", 409);
    if (message.includes("WAREHOUSE_CATALOG_DUPLICATE_RECIPE")) return fail("Mã mẹ đã có một tổ hợp khác giống dữ liệu mới.", 409);
    if (message.startsWith("WAREHOUSE_CATALOG_UNKNOWN_ITEM:")) return fail(`Itemcode ${message.split(":").slice(1).join(":")} chưa có trong danh mục.`, 409);
    if (message.startsWith("WAREHOUSE_CATALOG_ITEM_WITHOUT_NAME:")) return fail(`Itemcode ${message.split(":").slice(1).join(":")} chưa có tên sản phẩm và tên ERP.`, 409);
    if (message.includes("WAREHOUSE_CATALOG_INVALID")) return fail("Kiểm tra mã sản phẩm, tên, khối lượng và các mã con trước khi lưu.", 400);
    if (error?.code === "PGRST202" || error?.code === "42883") return fail("Cần áp dụng migration 20261116100000_warehouse_catalog_link_existing_items.sql.", 503);
    console.error("Warehouse catalog request failed", { action: input.action, error });
    return fail("Không xử lý được danh mục kho. Vui lòng thử lại.", 500);
  }
  return Response.json({ success: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}
