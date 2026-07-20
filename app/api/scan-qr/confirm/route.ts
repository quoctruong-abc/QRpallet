import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createReceiptPdf, safeReceiptFilename, type ReceiptPalletRow } from "@/lib/warehouse-receipt/pdf";

type PalletRow = ReceiptPalletRow & { pallet_id: string };

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
    .select("pallet_id,itemcode,customer,product_name,quantity,scanned_by")
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

  const pdfBytes = await createReceiptPdf(
    receipt.receipt_id,
    receipt.receipt_date,
    palletData as PalletRow[],
    { pallets: Number(receipt.total_pallet), quantity: Number(receipt.total_quantity) },
  );

  return new Response(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeReceiptFilename(receipt.receipt_id)}.pdf"`,
      "X-Receipt-Id": receipt.receipt_id,
      "X-Pallet-Count": String(receipt.total_pallet),
    },
  });
}
