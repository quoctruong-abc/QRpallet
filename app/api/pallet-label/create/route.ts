import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: "Số lượng pallet phải là số nguyên lớn hơn 0." }, { status: 400 });
    }

    const workingDay = normalizeDateOnly(body.working_day);
    if (workingDay === undefined) {
      return NextResponse.json({ error: "Ngày trên tem không hợp lệ." }, { status: 400 });
    }

    const configuredQuantity = Number(body.quantity_per_pallet);
    const evenPallet = typeof body.even_pallet === "boolean"
      ? body.even_pallet
      : Number.isInteger(configuredQuantity) && configuredQuantity > 0 && quantity === configuredQuantity;

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
