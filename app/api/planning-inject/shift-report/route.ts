import { NextResponse } from "next/server";
import { authorizeProfile, hasPosition } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createShiftReportPdf } from "@/lib/planning-inject/shift-report-pdf";
import {
  hasShiftReportWO,
  isShiftReportDate,
  parseShiftReportSelections,
  SHIFT_REPORT_FIELDS,
  type ShiftReportPlanRow,
} from "@/lib/planning-inject/shift-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE = 1000;

async function authorizeReport() {
  const authorization = await authorizeProfile();
  if (!authorization.ok) return authorization;
  if (!hasPosition(authorization.profile, "planning")) {
    return { ok: false as const, status: 403, error: "Bạn không có quyền truy cập kế hoạch sản xuất." };
  }
  return authorization;
}

export async function GET() {
  const authorization = await authorizeReport();
  if (!authorization.ok) return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  try {
    const supabase = await createClient();
    const rows: ShiftReportPlanRow[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("planning_inject")
        .select(SHIFT_REPORT_FIELDS)
        .not("machine", "is", null)
        .not("wo", "is", null)
        .order("machine", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      const page = (data ?? []) as ShiftReportPlanRow[];
      rows.push(...page.filter(hasShiftReportWO));
      if (page.length < PAGE_SIZE) break;
    }
    return NextResponse.json({ success: true, rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Load shift report plan failed", error);
    return NextResponse.json({ error: "Không thể tải kế hoạch báo ca. Vui lòng thử lại." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeReport();
  if (!authorization.ok) return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  const body = await request.json().catch(() => null);
  const selections = parseShiftReportSelections(body?.selections);
  if (!selections) return NextResponse.json({ error: "Vui lòng chọn máy và một WO hợp lệ cho mỗi máy." }, { status: 400 });
  if (!isShiftReportDate(body?.date)) return NextResponse.json({ error: "Vui lòng chọn ngày báo ca hợp lệ." }, { status: 400 });
  if (body?.mode !== "without-background" && body?.mode !== "with-background") {
    return NextResponse.json({ error: "Chế độ in không hợp lệ." }, { status: 400 });
  }
  try {
    const supabase = await createClient();
    const found = new Map<number, ShiftReportPlanRow>();
    for (let start = 0; start < selections.length; start += 100) {
      const { data, error } = await supabase.from("planning_inject")
        .select(SHIFT_REPORT_FIELDS)
        .in("id", selections.slice(start, start + 100).map((selection) => selection.id));
      if (error) throw error;
      for (const row of (data ?? []) as ShiftReportPlanRow[]) found.set(row.id, row);
    }
    const rows: ShiftReportPlanRow[] = [];
    for (const selection of selections) {
      const row = found.get(selection.id);
      if (!row || !hasShiftReportWO(row) || row.machine?.trim() !== selection.machine || row.wo?.trim() !== selection.wo) {
        return NextResponse.json(
          { error: "Kế hoạch đã thay đổi. Vui lòng đóng và mở lại popup để chọn WO mới." },
          { status: 409 },
        );
      }
      rows.push(row);
    }
    const bytes = await createShiftReportPdf(rows, body.date, body.mode);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="shift-report-${body.date}.pdf"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    console.error("Generate shift report batch failed", error);
    const message = error instanceof Error && error.message.startsWith("Thông tin quá dài")
      ? error.message
      : "Không thể tạo PDF báo ca. Vui lòng thử lại.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
