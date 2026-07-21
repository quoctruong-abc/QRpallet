import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return Response.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { palletIds?: string[] } | null;
  const palletIds = Array.from(new Set((body?.palletIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!palletIds.length) {
    return Response.json({ success: false, error: "Không có pallet để xác nhận." }, { status: 400 });
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
  if (palletError || !palletData || palletData.length !== palletIds.length) {
    return Response.json(
      { success: false, error: "Bạn chỉ được xác nhận các pallet do chính bạn scan. Danh sách có thể đã thay đổi, vui lòng tải lại." },
      { status: 409 },
    );
  }

  const { data, error } = await supabase.rpc("create_warehouse_receipt_from_scan", {
    p_pallet_ids: palletIds,
  });

  if (error || !data?.[0]) {
    const message = error?.message.includes("PALLET_STATUS_CHANGED_OR_NOT_OWNER")
      ? "Danh sách đã thay đổi hoặc có pallet không thuộc người đang đăng nhập. Vui lòng tải lại."
      : error?.message || "Không thể tạo phiếu nhập kho.";
    return Response.json({ success: false, error: message }, { status: 409 });
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
