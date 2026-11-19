import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { itemcodeCatalog, type ItemcodeWorkOrder } from "@/lib/pallet-label/itemcode-print";

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });

  let itemcode: string;
  try {
    itemcode = normalizeWarehouseItemcode(new URL(request.url).searchParams.get("itemcode") ?? "");
    if (/\s/.test(itemcode)) throw new Error("Itemcode không được chứa khoảng trắng.");
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const workOrders: ItemcodeWorkOrder[] = [];
    // The database aggregates history; page WO summaries, never raw pallets.
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.rpc("pallet_itemcode_work_orders", { p_itemcode: itemcode })
        .order("last_created_at", { ascending: false }).order("wo", { ascending: true }).range(offset, offset + 999);
      if (error) throw error;
      for (const row of (data ?? []) as ItemcodeWorkOrder[]) workOrders.push({
        ...row, quanorder: row.quanorder === null ? null : Number(row.quanorder),
        produced_quantity: Number(row.produced_quantity), warehouse_quantity: Number(row.warehouse_quantity), pallet_count: Number(row.pallet_count),
      });
      if ((data ?? []).length < 1000) break;
    }
    const { data, error } = await supabase.from("item_pallet_config")
      .select('itemcode,product_name,"ERP_name",customer,quantity_per_pallet').eq("itemcode", itemcode).maybeSingle();
    const item = data ? itemcodeCatalog(data) : null;
    const newWoError = error ? "Chưa tải được thông tin cấu hình để in WO mới. Vui lòng tra cứu itemcode lại."
      : !item ? "Itemcode chưa có trong danh mục sản phẩm. Vui lòng cập nhật mã sản phẩm trước khi in WO mới."
      : !item.customer ? `Item ${itemcode} chưa có tên khách hàng. Vui lòng cập nhật tên khách hàng trong thông tin sản phẩm trước khi in tem.`
      : !item.product_name ? `Item ${itemcode} chưa có tên sản phẩm. Vui lòng cập nhật thông tin sản phẩm trước khi in tem.` : null;
    // An incomplete catalog must not hide existing WOs or prevent reprinting.
    if (!workOrders.length && newWoError) return NextResponse.json({ success: false, error: newWoError }, { status: error ? 500 : !item ? 404 : 409 });
    return NextResponse.json({ success: true, itemcode, workOrders, item: newWoError ? null : item, newWoError });
  } catch (error) {
    console.error("Old itemcode pallet lookup failed", { itemcode, error });
    return NextResponse.json({ success: false, error: "Không thể tra cứu itemcode. Vui lòng thử lại." }, { status: 500 });
  }
}
