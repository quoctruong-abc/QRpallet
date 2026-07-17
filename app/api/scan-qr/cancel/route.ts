import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authorizePermission } from "@/lib/auth";

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletId?: string } | null;
  const palletId = body?.palletId?.trim();
  if (!palletId) {
    return NextResponse.json({ success: false, error: "Thiếu mã pallet cần hủy." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_pending_pallet", { p_pallet_id: palletId });

  if (error) {
    const message = error.message || "Không thể hủy pallet.";
    if (message.includes("PALLET_NOT_FOUND")) {
      return NextResponse.json({ success: false, error: `Không tìm thấy pallet ${palletId}.` }, { status: 404 });
    }
    if (message.includes("INVALID_STATUS:")) {
      const status = message.split("INVALID_STATUS:")[1]?.split(/[\s\n]/)[0] || "không xác định";
      return NextResponse.json({
        success: false,
        error: `Pallet ${palletId} hiện có trạng thái ${status}, chỉ có thể hủy khi đang pendingWH.`,
      }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }

  return NextResponse.json({ success: true, pallet: data });
}
