import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  const canView = Boolean(
    profile?.is_active &&
    (profile.role === "superadmin" || profile.role === "admin" || profile.position === "warehouse"),
  );

  if (!canView) {
    return Response.json({ success: false, error: "Không có quyền xem phiếu nhập kho." }, { status: 403 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date")?.trim() || "";
  const since = new Date();
  since.setDate(since.getDate() - 6);
  const sinceText = since.toISOString().slice(0, 10);

  const supabase = await createClient();
  let query = supabase
    .from("wh_receipt")
    .select("receipt_id,receipt_date,total_pallet,total_quantity,status,created_at,cancelled_at")
    .order("created_at", { ascending: false });

  query = date ? query.eq("receipt_date", date) : query.gte("receipt_date", sinceText);

  const { data, error } = await query;
  if (error) return Response.json({ success: false, error: error.message }, { status: 500 });

  return Response.json({ success: true, receipts: data ?? [] });
}
