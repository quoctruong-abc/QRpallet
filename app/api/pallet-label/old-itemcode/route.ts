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
    if (workOrders.length) return NextResponse.json({ success: true, itemcode, workOrders, item: null });

    const { data, error } = await supabase.from("item_pallet_config")
      .select('itemcode,product_name,"ERP_name",customer,quantity_per_pallet').eq("itemcode", itemcode).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ success: false, error: "Không tìm thấy itemcode trong dữ liệu pallet hoặc danh mục sản phẩm. Vui lòng cập nhật mã sản phẩm trước khi in tem." }, { status: 404 });
    const item = itemcodeCatalog(data);
    if (!item.customer) return NextResponse.json({ success: false, error: `Item ${itemcode} chưa có tên khách hàng. Vui lòng cập nhật tên khách hàng trong thông tin sản phẩm trước khi in tem.` }, { status: 409 });
    if (!item.product_name) return NextResponse.json({ success: false, error: `Item ${itemcode} chưa có tên sản phẩm. Vui lòng cập nhật thông tin sản phẩm trước khi in tem.` }, { status: 409 });
    return NextResponse.json({ success: true, itemcode, workOrders: [], item });
  } catch (error) {
    console.error("Old itemcode pallet lookup failed", { itemcode, error });
    return NextResponse.json({ success: false, error: "Không thể tra cứu itemcode. Vui lòng thử lại." }, { status: 500 });
  }
}
