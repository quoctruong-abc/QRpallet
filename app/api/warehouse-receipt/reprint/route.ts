import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createReceiptPdf, safeReceiptFilename, type ReceiptPalletRow } from "@/lib/warehouse-receipt/pdf";

export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || (profile.role !== "admin" && profile.position !== "warehouse")) {
    return Response.json({ success: false, error: "Không có quyền in lại phiếu." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { receiptId?: string } | null;
  const receiptId = body?.receiptId?.trim();
  if (!receiptId) return Response.json({ success: false, error: "Thiếu mã phiếu." }, { status: 400 });

  const supabase = await createClient();
  const { data: receipt, error: receiptError } = await supabase.from("wh_receipt")
    .select("receipt_id,receipt_date,total_pallet,total_quantity,status")
    .eq("receipt_id", receiptId).single();
  if (receiptError || !receipt) return Response.json({ success: false, error: "Không tìm thấy phiếu." }, { status: 404 });
  if (receipt.status === "cancelled") return Response.json({ success: false, error: "Phiếu đã hủy, không thể in lại." }, { status: 409 });

  const { data: pallets, error: palletError } = await supabase.from("pallet_data")
    .select("itemcode,customer,product_name,quantity")
    .eq("wh_receipt", receiptId).is("effect_to", null);
  if (palletError || !pallets?.length) return Response.json({ success: false, error: "Không tìm thấy dữ liệu pallet của phiếu." }, { status: 404 });

  const pdfBytes = await createReceiptPdf(
    receipt.receipt_id,
    receipt.receipt_date,
    pallets as ReceiptPalletRow[],
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
