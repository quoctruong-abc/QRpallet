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
    return Response.json({ success: false, error: "Chưa chọn pallet." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: palletData, error: palletError } = await supabase
    .from("pallet_data")
    .select("pallet_id,itemcode,customer,product_name,quantity,wo,working_day")
    .in("pallet_id", palletIds)
    .is("effect_to", null)
    .eq("status", "processingWH");

  if (palletError || !palletData || palletData.length !== palletIds.length) {
    return Response.json({ success: false, error: "Danh sách pallet đã thay đổi. Vui lòng tải lại." }, { status: 409 });
  }

  const { data, error } = await supabase.rpc("create_warehouse_receipt", { p_pallet_ids: palletIds });
  if (error || !data?.[0]) {
    const message = error?.message.includes("PALLET_STATUS_CHANGED")
      ? "Danh sách pallet đã thay đổi. Vui lòng tải lại."
      : error?.message || "Không thể tạo phiếu.";
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
    },
  });
}
