import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const MAX_WO_LENGTH = 120;
const PAGE_SIZE = 1000;
const PALLET_FIELDS =
  "pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,note,working_day,even_pallet,created_at,effect_to,reprint_count";

type OldWoPalletRow = {
  pallet_id: string;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | string | null;
  machine: string | null;
  quantity: number | string | null;
  status: string | null;
  note: string | null;
  working_day: string | null;
  even_pallet: boolean | null;
  created_at: string;
  effect_to: string | null;
  reprint_count: number | string | null;
};

async function loadPalletRows(wo: string, deleted: boolean) {
  const supabase = await createClient();
  const rows: OldWoPalletRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from("pallet_data")
      .select(PALLET_FIELDS)
      .eq("wo", wo)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    query = deleted
      ? query.not("effect_to", "is", null).ilike("note", "delete:%")
      : query.is("effect_to", null);

    const { data, error } = await query;
    if (error) throw error;

    const pageRows = (data ?? []) as OldWoPalletRow[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }

  return rows;
}

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const wo = new URL(request.url).searchParams.get("wo")?.trim() ?? "";
  if (!wo || wo.length > MAX_WO_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Vui lòng nhập WO hợp lệ." },
      { status: 400 },
    );
  }

  try {
    const [activeRows, deletedRows] = await Promise.all([
      loadPalletRows(wo, false),
      loadPalletRows(wo, true),
    ]);

    const allRows = [...activeRows, ...deletedRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    const source = activeRows[0] ?? deletedRows[0];

    if (!source) {
      return NextResponse.json(
        { success: false, error: `Không tìm thấy dữ liệu pallet của WO ${wo}.` },
        { status: 404 },
      );
    }

    const itemcode = source.itemcode?.trim() ?? "";
    const historicalEvenPallet = allRows.find((row) => (
      row.even_pallet && Number.isInteger(Number(row.quantity)) && Number(row.quantity) > 0
    ));
    let quantityPerPallet = historicalEvenPallet ? Number(historicalEvenPallet.quantity) : null;
    if (quantityPerPallet === null && itemcode) {
      const supabase = await createClient();
      const { data: config, error: configError } = await supabase
        .from("item_pallet_config")
        .select("quantity_per_pallet")
        .eq("itemcode", itemcode)
        .maybeSingle();

      if (configError) throw configError;
      const configuredQuantity = Number(config?.quantity_per_pallet);
      quantityPerPallet = Number.isInteger(configuredQuantity) && configuredQuantity > 0
        ? configuredQuantity
        : null;
    }

    const producedQuantity = activeRows.reduce(
      (sum, row) => sum + (Number(row.quantity) || 0),
      0,
    );
    const warehouseQuantity = activeRows
      .filter((row) => (row.status ?? "").toLowerCase() !== "production")
      .reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);

    return NextResponse.json({
      success: true,
      workOrder: {
        machine: source.machine?.trim() ?? "",
        itemcode,
        product_name: source.product_name?.trim() ?? "",
        customer: source.customer?.trim() ?? "",
        wo: source.wo?.trim() ?? wo,
        quanorder: source.quanorder === null ? null : Number(source.quanorder),
        produced_quantity: producedQuantity,
        warehouse_quantity: warehouseQuantity,
        quantity_per_pallet: quantityPerPallet,
      },
      pallets: allRows.map((row) => ({
        pallet_id: row.pallet_id,
        wo: row.wo ?? wo,
        itemcode: row.itemcode ?? "",
        quantity: Number(row.quantity) || 0,
        status: row.effect_to ? "deleted" : row.status ?? "",
        working_day: row.working_day,
        created_at: row.created_at,
        reprint_count: Number(row.reprint_count) || 0,
        is_deleted: Boolean(row.effect_to),
      })),
    });
  } catch (error) {
    console.error("Old WO pallet lookup failed", {
      wo,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: "Không thể tải dữ liệu WO cũ. Vui lòng thử lại." },
      { status: 500 },
    );
  }
}
