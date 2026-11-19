import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { palletQuantity } from "@/lib/pallet-label/quantity";

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
    // New-WO validation and creation run together under database locks. A blur
    // check is advisory only; the database re-checks duplicates and catalog data.
    if (body.source === "old-itemcode") {
      const itemcode = normalizeWarehouseItemcode(String(body.itemcode ?? ""));
      const wo = String(body.wo ?? "").trim();
      const orderQuantity = Number(body.quanorder);
      if (/\s/.test(itemcode) || !wo || wo.length > 120 || !workingDay || !Number.isFinite(orderQuantity) || orderQuantity <= 0) {
        return NextResponse.json({ error: "Vui lòng nhập đầy đủ WO, ngày sản xuất, số lượng và số lượng đơn hàng hợp lệ." }, { status: 400 });
      }
      const { data, error } = await supabase.rpc("create_pallet_from_new_wo", {
        p_itemcode: itemcode, p_wo: wo, p_quanorder: orderQuantity, p_quantity: quantity, p_working_day: workingDay,
      });
      if (error) {
        const message = error.message ?? "";
        if (/PALLET_NEW_WO_(EXISTS|ID_CONFLICT)/.test(message)) return NextResponse.json({ error: "WO đã tồn tại hoặc mã pallet bị trùng. Vui lòng chọn WO đã có hoặc nhập WO mới khác." }, { status: 409 });
        if (message.includes("PALLET_NEW_WO_CUSTOMER_MISSING")) return NextResponse.json({ error: "Vui lòng cập nhật tên khách hàng trong thông tin sản phẩm trước khi in tem." }, { status: 409 });
        if (/PALLET_NEW_WO_(NAME|ITEM)_MISSING/.test(message)) return NextResponse.json({ error: "Vui lòng khai báo itemcode và tên sản phẩm trước khi in tem." }, { status: 409 });
        if (message.includes("PALLET_NEW_WO_INVALID")) return NextResponse.json({ error: "Thông tin WO mới không hợp lệ. Vui lòng kiểm tra các trường bắt buộc." }, { status: 400 });
        if (message.includes("NOT_AUTHORIZED")) return NextResponse.json({ error: "Bạn không có quyền tạo tem pallet." }, { status: 403 });
        if (message.includes("PALLET_NEW_WO_BUSY")) return NextResponse.json({ error: "WO đang được xử lý. Chưa tạo tem, vui lòng kiểm tra lại WO rồi thử lại." }, { status: 503 });
        console.error("New WO pallet creation failed", error);
        return NextResponse.json({ error: "Không thể tạo tem WO mới. Vui lòng thử kiểm tra WO lại." }, { status: 500 });
      }
      if (!data) return NextResponse.json({ error: "Chưa nhận được kết quả tạo tem. Vui lòng kiểm tra lại WO trước khi thử tiếp." }, { status: 500 });
      return NextResponse.json({ success: true, pallet: data });
    }

    const configuredQuantity = palletQuantity(body.quantity_per_pallet);
    const evenPallet = typeof body.even_pallet === "boolean"
      ? body.even_pallet
      : configuredQuantity !== null && quantity === configuredQuantity;

    if (evenPallet) {
      const itemcode = String(body.itemcode ?? "").trim();
      const { data: config, error: configError } = await supabase.from("item_pallet_config")
        .select("quantity_per_pallet").eq("itemcode", itemcode).maybeSingle();
      if (configError) return NextResponse.json({ error: "Chưa kiểm tra được số lượng pallet chẵn. Chưa tạo tem, vui lòng thử lại." }, { status: 503 });
      const currentQuantity = palletQuantity(config?.quantity_per_pallet);
      if (currentQuantity === null) return NextResponse.json({ code: "PALLET_QUANTITY_MISSING", error: "Item chưa có số lượng pallet chẵn hợp lệ. Vui lòng cập nhật trong Cài đặt pallet." }, { status: 409 });
      if (currentQuantity !== quantity) return NextResponse.json({ code: "PALLET_QUANTITY_CHANGED", quantity_per_pallet: currentQuantity, error: `Số lượng pallet chẵn đã thay đổi thành ${currentQuantity.toLocaleString("vi-VN")}. Vui lòng kiểm tra lại trước khi in.` }, { status: 409 });
    }

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
