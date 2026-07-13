import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn." }, { status: 401 });
  if (!profile.is_active || (profile.role !== "admin" && profile.position !== "pallet")) {
    return NextResponse.json({ error: "Bạn không có quyền xuất tem pallet." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: "Số lượng pallet phải là số nguyên lớn hơn 0." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_pallet_record", {
      p_itemcode: String(body.itemcode ?? "").trim(),
      p_product_name: body.product_name ? String(body.product_name) : null,
      p_customer: body.customer ? String(body.customer) : null,
      p_wo: String(body.wo ?? "").trim(),
      p_quanorder: body.quanorder === null || body.quanorder === "" ? null : Number(body.quanorder),
      p_machine: body.machine ? String(body.machine) : null,
      p_quantity: quantity,
      p_note: body.note ? String(body.note) : null,
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
