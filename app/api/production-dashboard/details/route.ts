import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const DATABASE_ERROR_MESSAGE = "Không thể tải dữ liệu. Vui lòng thử lại.";

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
  is_deleted: boolean;
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
  scanned_by: string | null;
  scanned_at: string | null;
  wh_receipt: string | null;
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
  username: string | null;
  full_name: string | null;
  employee_code: string | null;
};

type ReceiptRow = {
  receipt_id: string;
  user_id: string | null;
  uid_user: string | null;
  created_at: string;
};

type HistoryEvent = {
  id: string;
  type: "edit" | "return" | "delete";
  occurredAt: string;
  actor: string;
  title: string;
  description: string;
  reason: string | null;
};

function isValidDate(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function extractPrefixedReason(note: string | null, prefix: "edit" | "delete") {
  if (!note) return null;
  const marker = `${prefix}:`;
  const matches = note
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(marker));
  if (!matches.length) return null;
  return matches[matches.length - 1].slice(marker.length).trim() || null;
}

function fallbackActor(userId: string | null) {
  if (!userId) return "Không xác định";
  return `User ${userId.slice(0, 8)}`;
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
  const detailFields =
    "id,pallet_id,itemcode,product_name,customer,wo,quanorder,quantity,status,note,has_been_edited,edit_count,has_been_return,working_day,created_at,updated_at,scanned_at,wh_receipt";

  async function appendRows(isDeleted: boolean) {
    for (let offset = 0; ; offset += pageSize) {
      let query = supabase
        .from("pallet_data")
        .select(detailFields)
        .gte("working_day", startDate)
        .lte("working_day", endDate)
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      query = isDeleted
        ? query.not("effect_to", "is", null).ilike("note", "delete:%")
        : query.is("effect_to", null);
      query = mode === "item" ? query.eq("itemcode", key) : query.eq("wo", key);

      const { data, error } = await query;
      if (error) {
        console.error("Dashboard pallet detail database error", {
          mode,
          key,
          startDate,
          endDate,
          isDeleted,
          message: error.message,
        });
        return false;
      }

      const pageRows = (data ?? []) as Omit<PalletDetailRow, "is_deleted">[];
      rows.push(...pageRows.map((row) => ({ ...row, is_deleted: isDeleted })));
      if (pageRows.length < pageSize) break;
    }

    return true;
  }

  if (!(await appendRows(false)) || !(await appendRows(true))) {
    return NextResponse.json({ success: false, error: DATABASE_ERROR_MESSAGE }, { status: 500 });
  }

  rows.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return NextResponse.json({
    success: true,
    pallets: rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity) || 0,
      status: row.is_deleted ? "deleted" : row.status ?? "",
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
        "id,pallet_id,quantity,status,note,old_data_refer,created_by,created_at,updated_at,effect_to,has_been_edited,edit_count,has_been_return,scanned_by,scanned_at,wh_receipt",
      )
      .eq("pallet_id", palletId)
      .order("created_at", { ascending: true }),
    supabase
      .from("pallet_change_history")
      .select("id,pallet_id,change_type,scanned_by,scanned_at,cancelled_by,cancelled_at,created_at")
      .eq("pallet_id", palletId)
      .order("cancelled_at", { ascending: true }),
  ]);

  if (versionResult.error || returnResult.error) {
    console.error("Dashboard pallet history database error", {
      palletId,
      versionError: versionResult.error?.message ?? null,
      returnError: returnResult.error?.message ?? null,
    });
    return NextResponse.json(
      { success: false, error: DATABASE_ERROR_MESSAGE },
      { status: 500 },
    );
  }

  const versions = (versionResult.data ?? []) as PalletVersionRow[];
  const returns = (returnResult.data ?? []) as ReturnHistoryRow[];
  if (!versions.length) {
    return NextResponse.json({ success: false, error: "Không tìm thấy pallet." }, { status: 404 });
  }

  const original = versions[0];
  const current = versions[versions.length - 1];
  const adminSupabase = createAdminClient();

  let receipt: ReceiptRow | null = null;
  if (current.wh_receipt) {
    const { data: receiptData, error: receiptError } = await adminSupabase
      .from("wh_receipt")
      .select("receipt_id,user_id,uid_user,created_at")
      .eq("receipt_id", current.wh_receipt)
      .maybeSingle();

    if (receiptError) {
      console.error("Dashboard receipt lookup failed", {
        palletId,
        receiptId: current.wh_receipt,
        message: receiptError.message,
      });
    } else {
      receipt = receiptData as ReceiptRow | null;
    }
  }

  const receiptActorId = receipt?.user_id ?? receipt?.uid_user ?? null;
  const actorIds = Array.from(
    new Set(
      [
        original.created_by,
        current.scanned_by,
        receiptActorId,
        ...versions.map((row) => row.created_by),
        ...returns.map((row) => row.scanned_by),
        ...returns.map((row) => row.cancelled_by),
      ].filter((value): value is string => Boolean(value)),
    ),
  );

  const profileMap = new Map<string, ProfileRow>();
  if (actorIds.length) {
    const { data: profiles, error: profileError } = await adminSupabase
      .from("profiles")
      .select("id,username,full_name,employee_code")
      .in("id", actorIds);

    if (profileError) {
      console.error("Dashboard actor profile lookup failed", profileError);
    } else {
      for (const profile of (profiles ?? []) as ProfileRow[]) profileMap.set(profile.id, profile);
    }
  }

  const actorName = (userId: string | null) => {
    if (!userId) return "Chưa có";
    const profile = profileMap.get(userId);
    if (!profile) return fallbackActor(userId);

    const displayName = profile.full_name?.trim() || profile.username?.trim();
    if (!displayName) return fallbackActor(userId);
    return profile.employee_code ? `${displayName} · ${profile.employee_code}` : displayName;
  };

  const byId = new Map(versions.map((row) => [row.id, row]));
  const events: HistoryEvent[] = [];

  for (const version of versions) {
    if (!version.old_data_refer) continue;
    const previous = byId.get(version.old_data_refer);
    const deleteReason = extractPrefixedReason(version.note, "delete");

    if (deleteReason) {
      events.push({
        id: `delete-${version.id}`,
        type: "delete",
        occurredAt: version.effect_to || version.created_at,
        actor: actorName(version.created_by),
        title: "Xóa pallet",
        description: `Pallet đã bị xóa khỏi dữ liệu active. Số lượng tại thời điểm xóa: ${previous?.quantity ?? version.quantity ?? "—"}.`,
        reason: deleteReason,
      });
      continue;
    }

    const reason = extractPrefixedReason(version.note, "edit");
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

  return NextResponse.json({
    success: true,
    palletId,
    flow: {
      created: {
        actor: actorName(original.created_by),
        at: original.created_at,
      },
      scanned: current.scanned_at
        ? {
            actor: actorName(current.scanned_by),
            at: current.scanned_at,
          }
        : null,
      warehouse: current.wh_receipt
        ? {
            actor: receipt ? actorName(receiptActorId) : "Không xác định",
            at: receipt?.created_at ?? null,
            receiptId: current.wh_receipt,
          }
        : null,
    },
    events,
  });
}

export async function GET(request: Request) {
  const authorization = await authorizePermission("dashboard.view");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  try {
    const url = new URL(request.url);
    const palletId = (url.searchParams.get("palletId") ?? "").trim();
    if (palletId) return loadPalletHistory(palletId);
    return loadPalletDetails(url);
  } catch (error) {
    console.error("Production dashboard details failed", error);
    return NextResponse.json(
      { success: false, error: DATABASE_ERROR_MESSAGE },
      { status: 500 },
    );
  }
}
