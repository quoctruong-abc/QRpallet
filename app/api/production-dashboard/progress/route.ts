import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type ProgressRow = {
  mode: "wo" | "item";
  key: string;
  order_quantity: number | string | null;
  pallet_count: number | string | null;
  produced_quantity: number | string | null;
  scanned_quantity: number | string | null;
  warehouse_quantity: number | string | null;
};

function isValidDate(value: string | null) {
  return value === null || /^\d{4}-\d{2}-\d{2}$/.test(value);
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
    const mode = url.searchParams.get("mode") === "item" ? "item" : "wo";
    const key = (url.searchParams.get("key") ?? "").trim();
    let from = url.searchParams.get("from");
    let to = url.searchParams.get("to");

    if (!key) {
      return NextResponse.json({ success: false, error: "Thiếu WO hoặc Item cần kiểm tra." }, { status: 400 });
    }

    if (!isValidDate(from) || !isValidDate(to)) {
      return NextResponse.json({ success: false, error: "Khoảng ngày không hợp lệ." }, { status: 400 });
    }

    if (from && to && from > to) [from, to] = [to, from];

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("dashboard_progress", {
      p_mode: mode,
      p_key: key,
      p_from: from,
      p_to: to,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const row = ((data ?? [])[0] ?? null) as ProgressRow | null;
    if (!row) {
      return NextResponse.json({ success: false, error: "Không tìm thấy dữ liệu tiến độ." }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      progress: {
        mode: row.mode,
        key: row.key,
        orderQuantity: Number(row.order_quantity) || 0,
        palletCount: Number(row.pallet_count) || 0,
        producedQuantity: Number(row.produced_quantity) || 0,
        scannedQuantity: Number(row.scanned_quantity) || 0,
        warehouseQuantity: Number(row.warehouse_quantity) || 0,
      },
    });
  } catch (error) {
    console.error("Dashboard progress failed", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Không thể tải tiến độ dashboard.",
      },
      { status: 500 },
    );
  }
}
