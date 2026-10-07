import { NextResponse } from "next/server";

import { authorizePermission } from "@/lib/auth";
import { createWoReceiptPdf, type WoReceiptPdfRow } from "@/lib/pallet-label/wo-receipt-pdf";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WO_COUNT = 100;
const MAX_WO_LENGTH = 120;
const MAX_COMBINED_WO_LENGTH = 2000;
const QUERY_WO_CHUNK_SIZE = 25;
const PAGE_SIZE = 1000;
const PALLET_FIELDS = "wo,pallet_id,itemcode,product_name,quantity,working_day,created_at";
const ITEM_SUMMARY_FIELDS = "wo,quantity,working_day";

type ReceiptAction = "search" | "search-item" | "pdf";

type RequestBody = {
  action?: unknown;
  itemcode?: unknown;
  wos?: unknown;
};

type WoItemSummary = {
  wo: string;
  totalQuantity: number;
  palletCount: number;
  firstWorkingDay: string | null;
  lastWorkingDay: string | null;
};

type WoReceiptRow = {
  wo: string;
  pallet_id: string;
  itemcode: string;
  product_name: string | null;
  quantity: number | string | null;
  working_day: string | null;
  created_at: string;
};

type ItemSummaryRow = Pick<WoReceiptRow, "wo" | "quantity" | "working_day">;

function normalizeWorkOrders(value: unknown) {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, string>();
  for (const rawWo of value) {
    if (typeof rawWo !== "string") continue;
    const wo = rawWo.trim().toLocaleUpperCase("en-US");
    if (!wo) continue;
    if (!unique.has(wo)) unique.set(wo, wo);
  }
  return Array.from(unique.values());
}

function normalizeItemcode(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleUpperCase("en-US") : "";
}

function validateWorkOrders(wos: string[]) {
  if (!wos.length) return "Vui lòng nhập ít nhất một WO.";
  if (wos.length > MAX_WO_COUNT) return `Mỗi lần chỉ được tìm tối đa ${MAX_WO_COUNT} WO.`;
  if (wos.some((wo) => wo.length > MAX_WO_LENGTH)) return "WO không được dài quá 120 ký tự.";
  if (wos.reduce((sum, wo) => sum + wo.length, 0) > MAX_COMBINED_WO_LENGTH) {
    return "Tổng độ dài danh sách WO quá lớn. Vui lòng chia thành nhiều lần in.";
  }
  return null;
}

async function loadPalletsByWorkOrders(wos: string[]) {
  const supabase = await createClient();
  const rows: WoReceiptRow[] = [];

  for (let chunkStart = 0; chunkStart < wos.length; chunkStart += QUERY_WO_CHUNK_SIZE) {
    const woChunk = wos.slice(chunkStart, chunkStart + QUERY_WO_CHUNK_SIZE);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("pallet_data")
        .select(PALLET_FIELDS)
        .in("wo", woChunk)
        .is("effect_to", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw error;
      const pageRows = (data ?? []) as WoReceiptRow[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) break;
    }
  }

  const woOrder = new Map(wos.map((wo, index) => [wo, index]));
  return rows
    .map<WoReceiptPdfRow>((row) => ({
      wo: row.wo?.trim() ?? "",
      pallet_id: row.pallet_id?.trim() ?? "",
      itemcode: row.itemcode?.trim() ?? "",
      product_name: row.product_name?.trim() ?? "",
      quantity: Number(row.quantity) || 0,
      working_day: row.working_day,
      created_at: row.created_at,
    }))
    .sort((a, b) => (
      (woOrder.get(a.wo) ?? Number.MAX_SAFE_INTEGER) - (woOrder.get(b.wo) ?? Number.MAX_SAFE_INTEGER)
      || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      || a.pallet_id.localeCompare(b.pallet_id, "vi")
    ));
}

async function loadWorkOrderSummariesByItem(itemcode: string) {
  const supabase = await createClient();
  const rows: ItemSummaryRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pallet_data")
      .select(ITEM_SUMMARY_FIELDS)
      .eq("itemcode", itemcode)
      .is("effect_to", null)
      .order("working_day", { ascending: true })
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    const pageRows = (data ?? []) as ItemSummaryRow[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }

  const summaries = new Map<string, WoItemSummary>();
  for (const row of rows) {
    const wo = row.wo?.trim() ?? "";
    if (!wo) continue;
    const workingDay = row.working_day;
    const current = summaries.get(wo) ?? {
      wo,
      totalQuantity: 0,
      palletCount: 0,
      firstWorkingDay: workingDay,
      lastWorkingDay: workingDay,
    };
    current.totalQuantity += Number(row.quantity) || 0;
    current.palletCount += 1;
    if (workingDay && (!current.firstWorkingDay || workingDay < current.firstWorkingDay)) {
      current.firstWorkingDay = workingDay;
    }
    if (workingDay && (!current.lastWorkingDay || workingDay > current.lastWorkingDay)) {
      current.lastWorkingDay = workingDay;
    }
    summaries.set(wo, current);
  }

  return Array.from(summaries.values()).sort((a, b) => (
    (a.firstWorkingDay ?? "9999-12-31").localeCompare(b.firstWorkingDay ?? "9999-12-31")
    || a.wo.localeCompare(b.wo, "vi")
  ));
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    );
  }

  const body = await request.json().catch(() => null) as RequestBody | null;
  const action: ReceiptAction = body?.action === "pdf"
    ? "pdf"
    : body?.action === "search-item"
      ? "search-item"
      : "search";

  if (action === "search-item") {
    const itemcode = normalizeItemcode(body?.itemcode);
    if (!itemcode) {
      return NextResponse.json({ success: false, error: "Vui lòng nhập itemcode." }, { status: 400 });
    }
    if (itemcode.length > MAX_WO_LENGTH) {
      return NextResponse.json({ success: false, error: "Itemcode không được dài quá 120 ký tự." }, { status: 400 });
    }

    try {
      const woSummaries = await loadWorkOrderSummariesByItem(itemcode);
      return NextResponse.json({ success: true, requestedItemcode: itemcode, woSummaries });
    } catch (error) {
      console.error("WO receipt item search failed", {
        itemcode,
        message: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { success: false, error: "Không thể tải danh sách WO theo item. Vui lòng thử lại." },
        { status: 500 },
      );
    }
  }

  const wos = normalizeWorkOrders(body?.wos);
  const validationError = validateWorkOrders(wos);
  if (validationError) {
    return NextResponse.json({ success: false, error: validationError }, { status: 400 });
  }

  try {
    const pallets = await loadPalletsByWorkOrders(wos);
    const foundWoSet = new Set(pallets.map((pallet) => pallet.wo));
    const foundWos = wos.filter((wo) => foundWoSet.has(wo));
    const missingWos = wos.filter((wo) => !foundWoSet.has(wo));

    if (action === "pdf") {
      if (!pallets.length) {
        return NextResponse.json(
          { success: false, error: "Không tìm thấy pallet còn hiệu lực của các WO đã nhập." },
          { status: 404 },
        );
      }

      const printedAt = new Date();
      const pdfBytes = await createWoReceiptPdf(wos, pallets, printedAt);
      const filenameTime = printedAt.toISOString().replace(/[-:]/g, "").slice(0, 13);
      return new Response(Buffer.from(pdfBytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="WO-receipt-${filenameTime}.pdf"`,
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    return NextResponse.json({
      success: true,
      requestedWos: wos,
      foundWos,
      missingWos,
      pallets,
    });
  } catch (error) {
    console.error("WO receipt failed", {
      action,
      wos,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: "Không thể tải dữ liệu WO receipt. Vui lòng thử lại." },
      { status: 500 },
    );
  }
}
