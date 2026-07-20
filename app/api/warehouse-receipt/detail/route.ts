import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pallet_data")
    .select("pallet_id,wo,itemcode,product_name,customer,quantity")
    .eq("wh_receipt", receiptId)
    .is("effect_to", null)
    .order("pallet_id", { ascending: true });

  if (error) {
    return Response.json(
      { success: false, error: error.message || "Không thể tải chi tiết phiếu." },
      { status: 500 },
    );
  }

  return Response.json({ success: true, pallets: data ?? [] });
}
