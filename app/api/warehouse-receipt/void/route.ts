import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || (profile.role !== "admin" && profile.position !== "warehouse")) {
    return Response.json({ success: false, error: "Không có quyền hủy phiếu." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { receiptId?: string } | null;
  const receiptId = body?.receiptId?.trim();
  if (!receiptId) return Response.json({ success: false, error: "Thiếu mã phiếu." }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_warehouse_receipt", { p_receipt_id: receiptId });
  if (error) {
    const message = error.message.includes("RECEIPT_ALREADY_CANCELLED")
      ? "Phiếu này đã được hủy trước đó."
      : error.message.includes("RECEIPT_NOT_FOUND")
        ? "Không tìm thấy phiếu."
        : error.message;
    return Response.json({ success: false, error: message }, { status: 409 });
  }
  return Response.json({ success: true, palletCount: Number(data ?? 0) });
}
