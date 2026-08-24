import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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
    return NextResponse.json({ success: false, error: "QR không chứa mã pallet hợp lệ." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("scan_pallet_to_pending", { p_pallet_id: palletId });

  if (error) {
    const message = error.message || "";
    if (message.includes("PALLET_NOT_FOUND")) {
      return NextResponse.json(
        {
          success: false,
          code: "PALLET_NOT_FOUND",
          error: `Không tìm thấy pallet ${palletId}.`,
        },
        { status: 404 },
      );
    }
    if (message.includes("INVALID_STATUS:")) {
      const palletStatus = message.split("INVALID_STATUS:")[1]?.split(/[\s\n]/)[0] || "không xác định";
      const duplicate = palletStatus === "pendingWH" || palletStatus === "processingWH";
      return NextResponse.json({
        success: false,
        code: "INVALID_STATUS",
        palletStatus,
        error: duplicate
          ? `Pallet ${palletId} đã được quét hoặc đang xử lý kho.`
          : `Pallet ${palletId} có trạng thái ${palletStatus}, chỉ nhận trạng thái production.`,
      }, { status: 409 });
    }
    if (message.includes("MAX_SCAN_PALLETS")) {
      return NextResponse.json(
        {
          success: false,
          code: "MAX_SCAN_PALLETS",
          error: "Đã đạt giới hạn tối đa 200 pallet. Hãy tạo phiếu trước khi scan thêm.",
        },
        { status: 409 },
      );
    }
    if (message.includes("INVALID_PALLET_ID")) {
      return NextResponse.json({ success: false, error: "Mã pallet không hợp lệ." }, { status: 400 });
    }

    console.error("Scan pallet database error", { palletId, message });
    return NextResponse.json(
      { success: false, code: "SCAN_FAILED", error: "Không thể tải dữ liệu. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, pallet: data });
}
