import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createReceiptExcel, safeExcelFilename } from "@/lib/warehouse-receipt/excel";
import type { ReceiptPalletRow } from "@/lib/warehouse-receipt/pdf";

export async function GET(request: Request) {
  const authorization = await authorizePermission("receipt.view");
  if (!authorization.ok) {
    return Response.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const url = new URL(request.url);
  const receiptId = url.searchParams.get("receiptId")?.trim();
  if (!receiptId) {
    return Response.json(
      { success: false, error: "Thiếu mã phiếu nhập kho." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data: receipt, error: receiptError } = await supabase
    .from("wh_receipt")
    .select("receipt_id,receipt_date,status")
    .eq("receipt_id", receiptId)
    .single();

  if (receiptError || !receipt) {
    return Response.json(
      { success: false, error: "Không tìm thấy phiếu nhập kho." },
      { status: 404 },
    );
  }

  if (receipt.status === "cancelled") {
    return Response.json(
      { success: false, error: "Phiếu đã hủy, không thể xuất Excel." },
      { status: 409 },
    );
  }

  const { data: pallets, error: palletError } = await supabase
    .from("pallet_data")
    .select("itemcode,customer,product_name,quantity,wo,working_day")
    .eq("wh_receipt", receiptId)
    .is("effect_to", null);

  if (palletError || !pallets?.length) {
    return Response.json(
      { success: false, error: "Không tìm thấy dữ liệu pallet của phiếu." },
      { status: 404 },
    );
  }

  const excelBytes = createReceiptExcel(
    receipt.receipt_id,
    receipt.receipt_date,
    pallets as ReceiptPalletRow[],
  );

  return new Response(excelBytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeExcelFilename(receipt.receipt_id)}.xlsx"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
