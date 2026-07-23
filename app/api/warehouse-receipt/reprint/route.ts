import { authorizeProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createReceiptPdf, safeReceiptFilename, type ReceiptPalletRow } from "@/lib/warehouse-receipt/pdf";

export async function POST(request: Request) {
  const authorization = await authorizeProfile();
  if (!authorization.ok) {
    return Response.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as { receiptId?: string } | null;
  const receiptId = body?.receiptId?.trim();
  if (!receiptId) return Response.json({ success: false, error: "Thiếu mã phiếu." }, { status: 400 });

  // Authentication is enforced above. Use the server-only admin client for
  // read-only cross-department access and PDF regeneration regardless of RLS.
  const supabase = createAdminClient();
  const { data: receipt, error: receiptError } = await supabase
    .from("wh_receipt")
    .select("receipt_id,receipt_date,total_pallet,total_quantity,status")
    .eq("receipt_id", receiptId)
    .single();

  if (receiptError || !receipt) {
    return Response.json({ success: false, error: "Không tìm thấy phiếu." }, { status: 404 });
  }
  if (receipt.status === "cancelled") {
    return Response.json({ success: false, error: "Phiếu đã hủy, không thể in lại." }, { status: 409 });
  }

  const { data: pallets, error: palletError } = await supabase
    .from("pallet_data")
    .select("itemcode,customer,product_name,quantity")
    .eq("wh_receipt", receiptId)
    .is("effect_to", null);

  if (palletError || !pallets?.length) {
    return Response.json({ success: false, error: "Không tìm thấy dữ liệu pallet của phiếu." }, { status: 404 });
  }

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
