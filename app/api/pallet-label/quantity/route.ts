import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { palletQuantity } from "@/lib/pallet-label/quantity";

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  const itemcode = (new URL(request.url).searchParams.get("itemcode") ?? "").trim();
  if (!itemcode || itemcode.length > 200) return NextResponse.json({ success: false, error: "Itemcode không hợp lệ." }, { status: 400 });
  const supabase = await createClient();
  const { data, error } = await supabase.from("item_pallet_config")
    .select("itemcode,quantity_per_pallet").eq("itemcode", itemcode).maybeSingle();
  if (error) {
    console.error("Pallet quantity lookup failed", { itemcode, error });
    return NextResponse.json({ success: false, error: "Chưa tải được số lượng pallet chẵn. Vui lòng thử lại." }, { status: 503 });
  }
  return NextResponse.json({ success: true, itemcode, quantity_per_pallet: palletQuantity(data?.quantity_per_pallet) }, { headers: { "Cache-Control": "no-store" } });
}
