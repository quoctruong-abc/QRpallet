import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.edit");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const body = await request.json().catch(() => null) as {
    itemcode?: string;
    quantity_per_pallet?: number;
  } | null;

  const itemcode = String(body?.itemcode ?? "").trim();
  const quantityPerPallet = Number(body?.quantity_per_pallet);

  if (!itemcode) {
    return NextResponse.json({ error: "Itemcode không hợp lệ." }, { status: 400 });
  }
  if (!Number.isInteger(quantityPerPallet) || quantityPerPallet <= 0) {
    return NextResponse.json(
      { error: "Số lượng mỗi pallet phải là số nguyên lớn hơn 0." },
      { status: 400 },
    );
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("item_pallet_config")
    .upsert(
      { itemcode, quantity_per_pallet: quantityPerPallet },
      { onConflict: "itemcode" },
    );

  if (error) {
    return NextResponse.json(
      { error: `Không thể cập nhật cấu hình pallet: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, itemcode, quantity_per_pallet: quantityPerPallet });
}
