import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const MAX_CONFIRM_PALLETS = 200;
const MAX_PALLET_ID_LENGTH = 128;

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return Response.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletIds?: unknown } | null;
  if (!Array.isArray(body?.palletIds)) {
    return Response.json({ success: false, error: "Danh sách pallet không hợp lệ." }, { status: 400 });
  }

  if (body.palletIds.length > MAX_CONFIRM_PALLETS) {
    return Response.json(
      { success: false, error: "Mỗi phiếu chỉ được xác nhận tối đa 200 pallet." },
      { status: 400 },
    );
  }

  const rawPalletIds = body.palletIds;
  if (rawPalletIds.some((id) => typeof id !== "string" || !id.trim() || id.trim().length > MAX_PALLET_ID_LENGTH)) {
    return Response.json({ success: false, error: "Danh sách pallet không hợp lệ." }, { status: 400 });
  }

  const palletIds = Array.from(new Set(rawPalletIds.map((id) => (id as string).trim())));
  if (!palletIds.length) {
    return Response.json({ success: false, error: "Không có pallet để xác nhận." }, { status: 400 });
  }
  if (palletIds.length !== rawPalletIds.length) {
    return Response.json({ success: false, error: "Danh sách pallet có mã trùng lặp." }, { status: 400 });
  }

  const supabase = await createClient();
  const isAdmin = authorization.profile.role === "admin" || authorization.profile.role === "superadmin";

  let palletQuery = supabase
    .from("pallet_data")
    .select("pallet_id,scanned_by")
    .in("pallet_id", palletIds)
    .is("effect_to", null)
    .eq("status", "pendingWH");

  if (!isAdmin) palletQuery = palletQuery.eq("scanned_by", authorization.profile.id);

  const { data: palletData, error: palletError } = await palletQuery;
  if (palletError) {
    console.error("Confirm scan pallet lookup database error", {
      message: palletError.message,
      palletCount: palletIds.length,
    });
    return Response.json(
      { success: false, error: "Không thể tải dữ liệu. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  if (!palletData || palletData.length !== palletIds.length) {
    return Response.json(
      { success: false, error: "Bạn chỉ được xác nhận các pallet do chính bạn scan. Danh sách có thể đã thay đổi, vui lòng tải lại." },
      { status: 409 },
    );
  }

  const { data, error } = await supabase.rpc("create_warehouse_receipt_from_scan", {
    p_pallet_ids: palletIds,
  });

  if (error || !data?.[0]) {
    const message = error?.message || "";
    if (message.includes("PALLET_STATUS_CHANGED_OR_NOT_OWNER")) {
      return Response.json(
        { success: false, error: "Danh sách đã thay đổi hoặc có pallet không thuộc người đang đăng nhập. Vui lòng tải lại." },
        { status: 409 },
      );
    }
    if (message.includes("MAX_CONFIRM_PALLETS")) {
      return Response.json(
        { success: false, error: "Mỗi phiếu chỉ được xác nhận tối đa 200 pallet." },
        { status: 400 },
      );
    }
    if (message.includes("DUPLICATE_PALLETS") || message.includes("INVALID_PALLET_ID")) {
      return Response.json({ success: false, error: "Danh sách pallet không hợp lệ." }, { status: 400 });
    }

    console.error("Create warehouse receipt from scan database error", {
      message,
      palletCount: palletIds.length,
    });
    return Response.json(
      { success: false, error: "Không thể tải dữ liệu. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  const receipt = data[0] as {
    receipt_id: string;
    receipt_date: string;
    total_pallet: number;
    total_quantity: number;
  };

  return Response.json({
    success: true,
    receiptId: receipt.receipt_id,
    receiptDate: receipt.receipt_date,
    totalPallet: Number(receipt.total_pallet),
    totalQuantity: Number(receipt.total_quantity),
  });
}
