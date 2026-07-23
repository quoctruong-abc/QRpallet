import { authorizeProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type ReceiptRecord = {
  receipt_id: string;
  receipt_date: string;
  total_pallet: number | string;
  total_quantity: number | string;
  status: string;
  created_at: string;
  cancelled_at: string | null;
  uid_user?: string | null;
  created_by?: string | null;
  user_id?: string | null;
  created_by_user_id?: string | null;
};

function getCreatorId(receipt: ReceiptRecord) {
  return receipt.uid_user
    ?? receipt.created_by
    ?? receipt.user_id
    ?? receipt.created_by_user_id
    ?? null;
}

export async function GET(request: Request) {
  const authorization = await authorizeProfile();
  if (!authorization.ok) {
    return Response.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const url = new URL(request.url);
  const date = url.searchParams.get("date")?.trim() || "";
  const since = new Date();
  since.setDate(since.getDate() - 6);
  const sinceText = since.toISOString().slice(0, 10);

  // The endpoint is authenticated above. Use the server-only admin client for
  // read-only cross-department access so table RLS does not restrict normal users.
  const supabase = createAdminClient();
  let query = supabase
    .from("wh_receipt")
    .select("*")
    .order("created_at", { ascending: false });

  query = date ? query.eq("receipt_date", date) : query.gte("receipt_date", sinceText);

  const { data, error } = await query;
  if (error) return Response.json({ success: false, error: error.message }, { status: 500 });

  const receiptRows = (data ?? []) as ReceiptRecord[];
  const creatorIds = Array.from(new Set(
    receiptRows
      .map(getCreatorId)
      .filter((id): id is string => Boolean(id)),
  ));

  const creatorNameMap = new Map<string, string>();
  if (creatorIds.length) {
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id,full_name,username")
      .in("id", creatorIds);

    if (profileError) {
      return Response.json({ success: false, error: profileError.message }, { status: 500 });
    }

    for (const profile of profiles ?? []) {
      creatorNameMap.set(
        String(profile.id),
        String(profile.full_name || profile.username || "—"),
      );
    }
  }

  const receipts = receiptRows.map((receipt) => {
    const creatorId = getCreatorId(receipt);
    return {
      receipt_id: receipt.receipt_id,
      receipt_date: receipt.receipt_date,
      total_pallet: receipt.total_pallet,
      total_quantity: receipt.total_quantity,
      status: receipt.status,
      created_at: receipt.created_at,
      cancelled_at: receipt.cancelled_at,
      creator_name: creatorId ? creatorNameMap.get(creatorId) ?? "—" : "—",
    };
  });

  return Response.json({ success: true, receipts });
}
