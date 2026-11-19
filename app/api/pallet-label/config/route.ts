import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { itemcodeCatalog } from "@/lib/pallet-label/itemcode-print";

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const url = new URL(request.url);
  const search = (url.searchParams.get("itemcode") ?? "").trim();
  if (!search || search.length > 200) {
    return NextResponse.json({ error: "Vui lòng nhập Itemcode cần tìm." }, { status: 400 });
  }

  const supabase = await createClient();
  const [{ data, error }, customerResult] = await Promise.all([supabase
    .from("item_pallet_config")
    .select('itemcode,quantity_per_pallet,product_name,"ERP_name",customer,updated_at')
    .ilike("itemcode", `%${search}%`)
    .order("itemcode", { ascending: true })
    .limit(50), supabase.rpc("pallet_customer_options")]);

  if (error || customerResult.error) {
    console.error("Pallet config lookup failed", error ?? customerResult.error);
    return NextResponse.json(
      { error: "Không thể tải cấu hình pallet và danh sách khách hàng. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  const configs = (data ?? []).map((row) => ({ ...itemcodeCatalog(row), updated_at: row.updated_at })).sort((left, right) => {
    const leftExact = left.itemcode.toLowerCase() === search.toLowerCase();
    const rightExact = right.itemcode.toLowerCase() === search.toLowerCase();
    return Number(rightExact) - Number(leftExact);
  });

  return NextResponse.json({ success: true, configs, customers: customerResult.data?.customers ?? [] });
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const body = await request.json().catch(() => null) as {
    itemcode?: string;
    quantity_per_pallet?: number;
    customer?: string;
  } | null;

  const itemcode = String(body?.itemcode ?? "").trim();
  const quantityPerPallet = Number(body?.quantity_per_pallet);

  if (!itemcode || itemcode.length > 200 || /[\s*]/.test(itemcode)) {
    return NextResponse.json({ error: "Itemcode không hợp lệ." }, { status: 400 });
  }
  if (!Number.isInteger(quantityPerPallet) || quantityPerPallet <= 0 || quantityPerPallet > 2147483647) {
    return NextResponse.json(
      { error: "Số lượng mỗi pallet phải là số nguyên lớn hơn 0." },
      { status: 400 },
    );
  }

  if (body && Object.hasOwn(body, "customer") && (typeof body.customer !== "string" || body.customer.trim().length > 500)) {
    return NextResponse.json({ error: "Khách hàng không hợp lệ." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pallet_config_save", {
    p_itemcode: itemcode, p_quantity_per_pallet: quantityPerPallet,
    ...(body?.customer !== undefined ? { p_customer: body.customer.trim() } : {}),
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("PALLET_CONFIG_UNKNOWN_CUSTOMER")) return NextResponse.json({ error: "Vui lòng chọn khách hàng trong danh sách lấy từ dữ liệu pallet, hoặc giữ khách hàng hiện tại." }, { status: 409 });
    if (message.includes("PALLET_CONFIG_CUSTOMER_REQUIRED")) return NextResponse.json({ error: "Không thể để trống khách hàng hiện có. Vui lòng chọn khách hàng trong danh sách." }, { status: 400 });
    if (message.includes("NOT_AUTHORIZED")) return NextResponse.json({ error: "Bạn không có quyền cập nhật cấu hình pallet." }, { status: 403 });
    if (message.includes("PALLET_CONFIG_BUSY")) return NextResponse.json({ error: "Dữ liệu đang được cập nhật. Chưa lưu thay đổi, vui lòng thử lại." }, { status: 503 });
    console.error("Pallet config save failed", error);
    return NextResponse.json(
      { error: "Không thể cập nhật cấu hình pallet. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, ...data });
}
