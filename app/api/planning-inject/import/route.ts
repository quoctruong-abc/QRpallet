import readXlsxFile, { type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const EXPECTED_COLUMN_COUNT = 12;
const MAX_ROWS = 20000;

type CellPrimitive = CellValue | null;

function toText(value: CellPrimitive): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return text === "" ? null : text;
}

function toNumber(value: CellPrimitive, excelRow: number, columnName: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`Dòng ${excelRow}, cột ${columnName}: giá trị số không hợp lệ.`);
  }

  const raw = String(value).trim().replace(/\s/g, "");
  if (!raw) return null;
  const isParenthesizedNegative = raw.startsWith("(") && raw.endsWith(")");
  const unsignedRaw = isParenthesizedNegative ? raw.slice(1, -1) : raw;
  let normalized = unsignedRaw;
  if (unsignedRaw.includes(",") && unsignedRaw.includes(".")) {
    normalized = unsignedRaw.replace(/,/g, "");
  } else if (unsignedRaw.includes(",")) {
    normalized = unsignedRaw.replace(",", ".");
  }
  if (isParenthesizedNegative) normalized = `-${normalized}`;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Dòng ${excelRow}, cột ${columnName}: “${raw}” không phải là số.`);
  }
  return parsed;
}

function isEmptyRow(row: PlanningRow) {
  return Object.values(row).every((value) => value === null || value === "");
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("planning.upload");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Vui lòng chọn file Excel." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "File Excel đang trống." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File vượt quá 4 MB." }, { status: 413 });
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return NextResponse.json(
        { error: "Hiện tại hệ thống nhận file .xlsx. Hãy Save As file cũ sang định dạng .xlsx." },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sheets = await readXlsxFile(buffer);
    const worksheet = sheets.find((sheet) => sheet.sheet.trim().toLowerCase() === "data");
    if (!worksheet) {
      return NextResponse.json({ error: "Không tìm thấy sheet tên data trong file Excel." }, { status: 400 });
    }

    const widestRow = worksheet.data.reduce((max, row) => Math.max(max, row.length), 0);
    if (widestRow < EXPECTED_COLUMN_COUNT) {
      return NextResponse.json(
        { error: `Sheet data phải có ít nhất ${EXPECTED_COLUMN_COUNT} cột từ A đến L.` },
        { status: 400 },
      );
    }

    const rows: PlanningRow[] = [];
    for (let dataIndex = 1; dataIndex < worksheet.data.length; dataIndex += 1) {
      const excelRow = dataIndex + 1;
      const row = worksheet.data[dataIndex];
      const parsedRow: PlanningRow = {
        machine: toText(row[0] ?? null),
        itemcode: toText(row[1] ?? null),
        product_name: toText(row[2] ?? null),
        customer: toText(row[3] ?? null),
        wo: toText(row[4] ?? null),
        netweight: toNumber(row[5] ?? null, excelRow, "Netweight"),
        quanperh: toNumber(row[6] ?? null, excelRow, "quanperh"),
        quanperday: toNumber(row[7] ?? null, excelRow, "quanperday"),
        color: toText(row[8] ?? null),
        material: toText(row[9] ?? null),
        package: toText(row[10] ?? null),
        quanorder: toNumber(row[11] ?? null, excelRow, "quanorder"),
      };
      if (!isEmptyRow(parsedRow)) rows.push(parsedRow);
      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { error: `File vượt quá giới hạn ${MAX_ROWS.toLocaleString("vi-VN")} dòng dữ liệu.` },
          { status: 400 },
        );
      }
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "Sheet data không có dữ liệu sau dòng header." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("replace_planning_inject", {
      p_rows: rows,
      p_source_file: file.name,
    });
    if (error) {
      console.error("replace_planning_inject failed", error);
      return NextResponse.json({ error: `Không thể cập nhật database: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, imported: Number(data ?? rows.length), fileName: file.name });
  } catch (error) {
    console.error("Planning Inject import failed", error);
    const message = error instanceof Error ? error.message : "Không thể đọc file Excel.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
