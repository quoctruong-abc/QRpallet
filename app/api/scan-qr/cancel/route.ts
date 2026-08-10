import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authorizePermission } from "@/lib/auth";

const MAX_PALLET_ID_LENGTH = 128;

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletId?: unknown } | null;
  const palletId = typeof body?.palletId === "string" ? body.palletId.trim() : "";
  if (!palletId || palletId.length > MAX_PALLET_ID_LENGTH) {
    return NextResponse.json({ success: false, error: "Mã pallet không hợp lệ." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_pending_pallet", { p_pallet_id: palletId });

  if (error) {
    const message = error.message || "";
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
    if (message.includes("NOT_SCAN_OWNER")) {
      return NextResponse.json(
        { success: false, error: "Bạn chỉ được hủy pallet do chính bạn scan." },
        { status: 403 },
      );
    }

    console.error("Cancel pending pallet database error", { palletId, message });
    return NextResponse.json(
      { success: false, error: "Không thể tải dữ liệu. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, pallet: data });
}
