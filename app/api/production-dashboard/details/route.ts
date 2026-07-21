import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type PalletDetailRow = {
  id: number;
  pallet_id: string;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | null;
  quantity: number | null;
  status: string | null;
  note: string | null;
  has_been_edited: boolean | null;
  edit_count: number | null;
  has_been_return: boolean | null;
  working_day: string;
  created_at: string;
  updated_at: string;
  scanned_at: string | null;
  wh_receipt: string | null;
};

type PalletVersionRow = {
  id: number;
  pallet_id: string;
  quantity: number | null;
  status: string | null;
  note: string | null;
  old_data_refer: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  effect_to: string | null;
  has_been_edited: boolean | null;
  edit_count: number | null;
  has_been_return: boolean | null;
};

type ReturnHistoryRow = {
  id: number;
  pallet_id: string;
  change_type: string;
  scanned_by: string | null;
  scanned_at: string;
  cancelled_by: string;
  cancelled_at: string;
  created_at: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  employee_code: string | null;
};

type HistoryEvent = {
  id: string;
  type: "edit" | "return";
  occurredAt: string;
  actor: string;
  title: string;
  description: string;
  reason: string | null;
};

function isValidDate(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function extractEditReason(note: string | null) {
  if (!note) return null;
  const matches = note
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("edit:"));
  if (!matches.length) return null;
  return matches[matches.length - 1].slice(5).trim() || null;
}

function fallbackActor(userId: string | null) {
  if (!userId) return "Không xác định";
  return `User ${userId.slice(0, 8)}`;
}

async function authorizeAdmin() {
  const profile = await getCurrentProfile();
  if (!profile) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: "Phiên đăng nhập đã hết hạn." },
        { status: 401 },
      ),
    };
  }
  if (!profile.is_active || !["admin", "superadmin"].includes(profile.role)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: "Bạn không có quyền xem dashboard." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const };
}

async function loadPalletDetails(url: URL) {
  const mode = url.searchParams.get("mode") === "item" ? "item" : "wo";
  const key = (url.searchParams.get("key") ?? "").trim();
  const requestedFrom = url.searchParams.get("from");
  const requestedTo = url.searchParams.get("to");

  if (!key || !isValidDate(requestedFrom) || !isValidDate(requestedTo)) {
    return NextResponse.json(
      { success: false, error: "Bộ lọc chi tiết pallet không hợp lệ." },
      { status: 400 },
    );
  }

  let startDate = requestedFrom!;
  let endDate = requestedTo!;
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate];

  const supabase = await createClient();
  const rows: PalletDetailRow[] = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    let query = supabase
      .from("pallet_data")
      .select(
        "id,pallet_id,itemcode,product_name,customer,wo,quanorder,quantity,status,note,has_been_edited,edit_count,has_been_return,working_day,created_at,updated_at,scanned_at,wh_receipt",
      )
      .is("effect_to", null)
      .gte("working_day", startDate)
      .lte("working_day", endDate)
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    query = mode === "item" ? query.eq("itemcode", key) : query.eq("wo", key);
    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const pageRows = (data ?? []) as PalletDetailRow[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return NextResponse.json({
    success: true,
    pallets: rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity) || 0,
      status: row.status ?? "",
      has_been_edited: Boolean(row.has_been_edited),
      edit_count: Number(row.edit_count) || 0,
      has_been_return: Boolean(row.has_been_return),
    })),
  });
}

async function loadPalletHistory(palletId: string) {
  const supabase = await createClient();
  const [versionResult, returnResult] = await Promise.all([
    supabase
      .from("pallet_data")
      .select(
        "id,pallet_id,quantity,status,note,old_data_refer,created_by,created_at,updated_at,effect_to,has_been_edited,edit_count,has_been_return",
      )
      .eq("pallet_id", palletId)
      .order("created_at", { ascending: true }),
    supabase
      .from("pallet_change_history")
      .select("id,pallet_id,change_type,scanned_by,scanned_at,cancelled_by,cancelled_at,created_at")
      .eq("pallet_id", palletId)
      .order("cancelled_at", { ascending: true }),
  ]);

  if (versionResult.error) {
    return NextResponse.json(
      { success: false, error: versionResult.error.message },
      { status: 500 },
    );
  }
  if (returnResult.error) {
    return NextResponse.json(
      { success: false, error: returnResult.error.message },
      { status: 500 },
    );
  }

  const versions = (versionResult.data ?? []) as PalletVersionRow[];
  const returns = (returnResult.data ?? []) as ReturnHistoryRow[];
  if (!versions.length) {
    return NextResponse.json({ success: false, error: "Không tìm thấy pallet." }, { status: 404 });
  }

  const actorIds = Array.from(
    new Set(
      [...versions.map((row) => row.created_by), ...returns.map((row) => row.cancelled_by)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  const profileMap = new Map<string, ProfileRow>();
  if (actorIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id,full_name,employee_code")
      .in("id", actorIds);
    for (const profile of (profiles ?? []) as ProfileRow[]) profileMap.set(profile.id, profile);
  }

  const actorName = (userId: string | null) => {
    if (!userId) return fallbackActor(userId);
    const profile = profileMap.get(userId);
    if (!profile) return fallbackActor(userId);
    return profile.employee_code
      ? `${profile.full_name || "Không rõ tên"} · ${profile.employee_code}`
      : profile.full_name || fallbackActor(userId);
  };

  const byId = new Map(versions.map((row) => [row.id, row]));
  const events: HistoryEvent[] = [];

  for (const version of versions) {
    if (!version.old_data_refer) continue;
    const previous = byId.get(version.old_data_refer);
    const reason = extractEditReason(version.note);
    if (!reason && !version.has_been_edited) continue;

    events.push({
      id: `edit-${version.id}`,
      type: "edit",
      occurredAt: version.created_at,
      actor: actorName(version.created_by),
      title: "Chỉnh sửa số lượng pallet",
      description: `Số lượng thay đổi từ ${previous?.quantity ?? "—"} thành ${version.quantity ?? "—"}.`,
      reason,
    });
  }

  if (!events.some((event) => event.type === "edit")) {
    const current = versions[versions.length - 1];
    const fallbackReasons = (current.note ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith("edit:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    fallbackReasons.forEach((reason, index) => {
      events.push({
        id: `edit-fallback-${index}`,
        type: "edit",
        occurredAt: current.updated_at || current.created_at,
        actor: actorName(current.created_by),
        title: "Chỉnh sửa pallet",
        description: `Số lượng hiện tại: ${current.quantity ?? "—"}.`,
        reason,
      });
    });
  }

  for (const row of returns) {
    events.push({
      id: `return-${row.id}`,
      type: "return",
      occurredAt: row.cancelled_at,
      actor: actorName(row.cancelled_by),
      title: "Return pallet về Production",
      description: `Pallet đã scan lúc ${new Date(row.scanned_at).toLocaleString("vi-VN")} và được return về trạng thái production.`,
      reason: null,
    });
  }

  events.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return NextResponse.json({ success: true, palletId, events });
}

export async function GET(request: Request) {
  const authorization = await authorizeAdmin();
  if (!authorization.ok) return authorization.response;

  try {
    const url = new URL(request.url);
    const palletId = (url.searchParams.get("palletId") ?? "").trim();
    if (palletId) return loadPalletHistory(palletId);
    return loadPalletDetails(url);
  } catch (error) {
    console.error("Production dashboard details failed", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Không thể tải chi tiết dashboard.",
      },
      { status: 500 },
    );
  }
}
