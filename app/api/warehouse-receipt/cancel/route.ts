import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || (profile.role !== "admin" && profile.position !== "warehouse")) {
    return NextResponse.json({ success: false, error: "Không có quyền hủy pallet." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { palletIds?: string[] } | null;
  const palletIds = Array.from(new Set((body?.palletIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!palletIds.length) return NextResponse.json({ success: false, error: "Chưa chọn pallet." }, { status: 400 });

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
