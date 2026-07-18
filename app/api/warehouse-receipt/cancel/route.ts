import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("receipt.edit");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletIds?: string[] } | null;
  const palletIds = Array.from(new Set((body?.palletIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!palletIds.length) {
    return NextResponse.json({ success: false, error: "Chưa chọn pallet." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_processing_pallets", { p_pallet_ids: palletIds });
  if (error) {
    const friendly = error.message.includes("PALLET_STATUS_CHANGED")
      ? "Danh sách đã thay đổi. Vui lòng tải lại trang."
      : error.message;
    return NextResponse.json({ success: false, error: friendly }, { status: 409 });
  }

  return NextResponse.json({ success: true, pallets: data ?? [] });
}
