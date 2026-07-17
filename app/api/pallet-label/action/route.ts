import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.edit");
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error },
      { status: authorization.status },
    );
  }

  try {
    const body = await request.json();
    const action = String(body.action ?? "");
    const palletId = String(body.pallet_id ?? "").trim();
    const supabase = await createClient();

    if (action === "edit") {
      const quantity = Number(body.quantity);
      if (!palletId || !Number.isInteger(quantity) || quantity <= 0) {
        return NextResponse.json({ error: "Pallet ID hoặc số lượng không hợp lệ." }, { status: 400 });
      }
      const { data: currentPallet, error: currentError } = await supabase
        .from("pallet_data")
        .select("status")
        .eq("pallet_id", palletId)
        .is("effect_to", null)
        .single();
      if (currentError || !currentPallet) return NextResponse.json({ error: "Không tìm thấy pallet đang hiệu lực." }, { status: 404 });
      if (currentPallet.status !== "production") {
        return NextResponse.json({ error: "Chỉ được sửa pallet đang ở trạng thái production." }, { status: 400 });
      }
      const { data, error } = await supabase.rpc("edit_pallet_quantity", { p_pallet_id: palletId, p_quantity: quantity });
      if (error) throw error;
      return NextResponse.json({ success: true, pallet: data });
    }

    if (action === "delete") {
      if (!palletId) return NextResponse.json({ error: "Thiếu Pallet ID." }, { status: 400 });
      const { data: currentPallet, error: currentError } = await supabase
        .from("pallet_data")
        .select("status")
        .eq("pallet_id", palletId)
        .is("effect_to", null)
        .single();
      if (currentError || !currentPallet) return NextResponse.json({ error: "Không tìm thấy pallet đang hiệu lực." }, { status: 404 });
      if (currentPallet.status !== "production") {
        return NextResponse.json({ error: "Chỉ được xóa pallet đang ở trạng thái production." }, { status: 400 });
      }
      const { data, error } = await supabase.rpc("delete_pallet_record", { p_pallet_id: palletId });
      if (error) throw error;
      return NextResponse.json({ success: true, pallet: data });
    }

    if (action === "merge") {
      const wo1 = String(body.wo1 ?? "").trim();
      const wo2 = String(body.wo2 ?? "").trim();
      const quantity = Number(body.quantity);
      if (!wo1 || !wo2 || wo1 === wo2 || !Number.isInteger(quantity) || quantity <= 0) {
        return NextResponse.json({ error: "Chọn 2 WO khác nhau và nhập số lượng hợp lệ." }, { status: 400 });
      }
      const { data: plan, error: planError } = await supabase
        .from("planning_inject")
        .select("itemcode,product_name,customer,wo,quanorder,machine")
        .eq("wo", wo1)
        .limit(1)
        .single();
      if (planError || !plan) return NextResponse.json({ error: `Không tìm thấy WO ${wo1} trong kế hoạch.` }, { status: 404 });
      const { data, error } = await supabase.rpc("create_pallet_record", {
        p_itemcode: plan.itemcode,
        p_product_name: plan.product_name,
        p_customer: plan.customer,
        p_wo: plan.wo,
        p_quanorder: plan.quanorder,
        p_machine: plan.machine,
        p_quantity: quantity,
        p_note: `merge: ${wo1} + ${wo2}`,
      });
      if (error) throw error;
      return NextResponse.json({ success: true, pallet: data });
    }

    return NextResponse.json({ error: "Tính năng không hợp lệ." }, { status: 400 });
  } catch (error) {
    console.error("Pallet action failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Không thể thực hiện thao tác." }, { status: 500 });
  }
}
