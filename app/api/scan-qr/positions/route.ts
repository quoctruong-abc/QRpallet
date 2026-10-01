import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const MAX_PALLET_ID_LENGTH = 128;
const MAX_POSITION_CODE_LENGTH = 50;
const MAX_SEARCH_LENGTH = 80;
const SEARCH_RESULT_LIMIT = 20;

type PositionRow = {
  code: string;
  name: string;
};

function ilikePattern(value: string) {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `%${escaped}%`;
}

export async function GET(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const search = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (search.length > MAX_SEARCH_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Từ khóa vị trí quá dài." },
      { status: 400 },
    );
  }

  try {
    const adminClient = createAdminClient();

    if (!search) {
      const { data, error } = await adminClient
        .from("warehouse_positions")
        .select("code,name")
        .eq("is_active", true)
        .order("code", { ascending: true })
        .limit(SEARCH_RESULT_LIMIT);

      if (error) throw error;
      return NextResponse.json({ success: true, positions: data ?? [] });
    }

    const pattern = ilikePattern(search);
    const [codeResult, nameResult] = await Promise.all([
      adminClient
        .from("warehouse_positions")
        .select("code,name")
        .eq("is_active", true)
        .ilike("code", pattern)
        .order("code", { ascending: true })
        .limit(SEARCH_RESULT_LIMIT),
      adminClient
        .from("warehouse_positions")
        .select("code,name")
        .eq("is_active", true)
        .ilike("name", pattern)
        .order("code", { ascending: true })
        .limit(SEARCH_RESULT_LIMIT),
    ]);

    if (codeResult.error) throw codeResult.error;
    if (nameResult.error) throw nameResult.error;

    const positionMap = new Map<string, PositionRow>();
    for (const position of [...(codeResult.data ?? []), ...(nameResult.data ?? [])] as PositionRow[]) {
      positionMap.set(position.code, position);
    }

    const positions = Array.from(positionMap.values())
      .sort((a, b) => a.code.localeCompare(b.code, "vi"))
      .slice(0, SEARCH_RESULT_LIMIT);

    return NextResponse.json({ success: true, positions });
  } catch (error) {
    console.error("Warehouse position search failed", {
      search,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: "Không thể tải danh sách vị trí. Vui lòng thử lại." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("scan.standard");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as {
    palletId?: unknown;
    position?: unknown;
  } | null;
  const palletId = typeof body?.palletId === "string" ? body.palletId.trim() : "";
  const position = typeof body?.position === "string" ? body.position.trim().toUpperCase() : "";

  if (!palletId || palletId.length > MAX_PALLET_ID_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Mã pallet không hợp lệ." },
      { status: 400 },
    );
  }
  if (!position || position.length > MAX_POSITION_CODE_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Vị trí không hợp lệ." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_pending_pallet_position", {
    p_pallet_id: palletId,
    p_position: position,
  });

  if (error) {
    const message = error.message || "";
    if (message.includes("POSITION_NOT_FOUND")) {
      return NextResponse.json(
        { success: false, error: "Vị trí không tồn tại hoặc đã bị khóa." },
        { status: 404 },
      );
    }
    if (message.includes("PALLET_NOT_PENDING_OR_NOT_OWNER")) {
      return NextResponse.json(
        { success: false, error: "Pallet không còn chờ nhập kho hoặc không thuộc phiên scan của bạn." },
        { status: 409 },
      );
    }
    if (message.includes("INVALID_PALLET_ID") || message.includes("INVALID_POSITION")) {
      return NextResponse.json(
        { success: false, error: "Pallet hoặc vị trí không hợp lệ." },
        { status: 400 },
      );
    }

    console.error("Set pending pallet position failed", {
      palletId,
      position,
      message,
    });
    return NextResponse.json(
      { success: false, error: "Không thể lưu vị trí pallet. Vui lòng thử lại." },
      { status: 500 },
    );
  }

  const adminClient = createAdminClient();
  const { data: positionRow } = await adminClient
    .from("warehouse_positions")
    .select("code,name")
    .eq("code", position)
    .maybeSingle();

  return NextResponse.json({
    success: true,
    pallet: data,
    position: positionRow ?? { code: position, name: position },
  });
}
