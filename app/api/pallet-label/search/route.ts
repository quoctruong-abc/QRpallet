import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.edit");
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error },
      { status: authorization.status },
    );
  }

  const { searchParams } = new URL(request.url);
  const wo = searchParams.get("wo")?.trim() ?? "";
  const itemcode = searchParams.get("itemcode")?.trim() ?? "";
  const supabase = await createClient();

  let query = supabase
    .from("pallet_data")
    .select("pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,note,created_at")
    .is("effect_to", null)
    .order("created_at", { ascending: false })
    .limit(300);

  if (wo) query = query.ilike("wo", `%${wo}%`);
  if (itemcode) query = query.ilike("itemcode", `%${itemcode}%`);
  if (!wo && !itemcode) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Search pallets failed", error);
    return NextResponse.json({ error: `Không thể tải pallet: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true, pallets: data ?? [] });
}
