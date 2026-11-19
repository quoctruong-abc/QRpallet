import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { itemcodeCatalog } from "@/lib/pallet-label/itemcode-print";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";

function normalizeDateOnly(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;

  const date = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;

  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return undefined;
  }

  return date;
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  try {
    const body = await request.json();
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 2147483647) {
      return NextResponse.json({ error: "Số lượng pallet phải là số nguyên lớn hơn 0." }, { status: 400 });
    }

    const workingDay = normalizeDateOnly(body.working_day);
    if (workingDay === undefined) {
      return NextResponse.json({ error: "Ngày trên tem không hợp lệ." }, { status: 400 });
    }

    const supabase = await createClient();
    // This new intake path requires explicit date/order/WO and current catalog
    // identity. Re-read it at save time; never trust the browser's snapshot.
    if (body.source === "old-itemcode") {
      const itemcode = normalizeWarehouseItemcode(String(body.itemcode ?? ""));
      const wo = String(body.wo ?? "").trim();
      const orderQuantity = Number(body.quanorder);
      if (/\s/.test(itemcode) || !wo || wo.length > 120 || !workingDay || !Number.isFinite(orderQuantity) || orderQuantity <= 0) {
        return NextResponse.json({ error: "Vui lòng nhập đầy đủ WO, ngày sản xuất, số lượng và số lượng đơn hàng hợp lệ." }, { status: 400 });
      }
      const { data: config, error: configError } = await supabase.from("item_pallet_config")
        .select('itemcode,product_name,"ERP_name",customer,quantity_per_pallet').eq("itemcode", itemcode).maybeSingle();
      if (configError) return NextResponse.json({ error: "Chưa kiểm tra được thông tin itemcode. Vui lòng thử lại." }, { status: 500 });
      if (!config) return NextResponse.json({ error: "Itemcode chưa được khai báo trong danh mục sản phẩm." }, { status: 409 });
      const item = itemcodeCatalog(config);
      if (!item.customer) return NextResponse.json({ error: "Vui lòng cập nhật tên khách hàng trong thông tin sản phẩm trước khi in tem." }, { status: 409 });
      if (!item.product_name) return NextResponse.json({ error: "Vui lòng cập nhật tên sản phẩm trong thông tin sản phẩm trước khi in tem." }, { status: 409 });
      Object.assign(body, item, { wo, quanorder: orderQuantity, machine: null });
    }

    const configuredQuantity = Number(body.quantity_per_pallet);
    const evenPallet = typeof body.even_pallet === "boolean"
      ? body.even_pallet
      : Number.isInteger(configuredQuantity) && configuredQuantity > 0 && quantity === configuredQuantity;

    const { data, error } = await supabase.rpc("create_pallet_record", {
      p_itemcode: String(body.itemcode ?? "").trim(),
      p_product_name: body.product_name ? String(body.product_name) : null,
      p_customer: body.customer ? String(body.customer) : null,
      p_wo: String(body.wo ?? "").trim(),
      p_quanorder: body.quanorder === null || body.quanorder === "" ? null : Number(body.quanorder),
      p_machine: body.machine ? String(body.machine) : null,
      p_quantity: quantity,
      p_note: body.note ? String(body.note) : null,
      p_working_day: workingDay,
      p_even_pallet: evenPallet,
    });

    if (error) {
      console.error("create_pallet_record failed", error);
      return NextResponse.json({ error: `Không thể lưu pallet: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, pallet: data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dữ liệu gửi lên không hợp lệ." },
      { status: 400 },
    );
  }
}
