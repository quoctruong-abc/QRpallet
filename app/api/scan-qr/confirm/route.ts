import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletIds?: string[] } | null;
  const palletIds = Array.from(new Set((body?.palletIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (palletIds.length === 0) {
    return NextResponse.json({ success: false, error: "Không có pallet để xác nhận." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirm_pending_pallets", { p_pallet_ids: palletIds });
  if (error) {
    const message = error.message || "Không thể xác nhận pallet.";
    const friendly = message.includes("PALLET_STATUS_CHANGED")
      ? "Danh sách đã thay đổi trên thiết bị khác. Vui lòng tải lại trang."
      : message;
    return NextResponse.json({ success: false, error: friendly }, { status: 409 });
  }

  return NextResponse.json({ success: true, pallets: data });
}
