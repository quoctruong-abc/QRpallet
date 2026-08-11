import { readSheet, type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const EXPECTED_COLUMN_COUNT = 12;
const MAX_ROWS = 20000;

type CellPrimitive = CellValue | null | undefined;

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

function previewRow(row: CellValue[] | undefined) {
  return (row ?? []).slice(0, EXPECTED_COLUMN_COUNT).map((value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value.slice(0, 80);
    return value;
  });
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("planning.upload");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  let stage = "authorization";

  try {
    stage = "form-data";
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Vui lòng chọn file Excel." }, { status: 400 });
    }

    console.log("[planning-import] file received", {
      name: file.name,
      size: file.size,
      type: file.type,
    });

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

    stage = "buffer";
    const buffer = Buffer.from(await file.arrayBuffer());
    console.log("[planning-import] buffer ready", {
      bytes: buffer.length,
      signature: buffer.subarray(0, 4).toString("hex"),
    });

    stage = "read-sheet";
    let worksheet: CellValue[][];
    try {
      // We trim/normalize cells ourselves below. Disabling the library's string
      // trimming also helps isolate malformed/shared-string cells from parser errors.
      worksheet = await readSheet(buffer, { sheet: "data", trim: false });
    } catch (error) {
      console.error("[planning-import] readSheet failed", {
        stage,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof Error && error.name === "SheetNotFoundError") {
        return NextResponse.json(
          { error: "Không tìm thấy sheet tên data trong file Excel." },
          { status: 400 },
        );
      }
      throw error;
    }

    stage = "inspect-sheet";
    const widestRow = worksheet.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
    console.log("[planning-import] sheet loaded", {
      rows: worksheet.length,
      widestRow,
      header: previewRow(worksheet[0]),
      firstDataRow: previewRow(worksheet[1]),
    });

    if (widestRow < EXPECTED_COLUMN_COUNT) {
      return NextResponse.json(
        { error: `Sheet data phải có ít nhất ${EXPECTED_COLUMN_COUNT} cột từ A đến L.` },
        { status: 400 },
      );
    }

    stage = "parse-rows";
    const rows: PlanningRow[] = [];
    for (let dataIndex = 1; dataIndex < worksheet.length; dataIndex += 1) {
      const excelRow = dataIndex + 1;
      const row = worksheet[dataIndex] ?? [];

      try {
        const parsedRow: PlanningRow = {
          machine: toText(row[0]),
          itemcode: toText(row[1]),
          product_name: toText(row[2]),
          customer: toText(row[3]),
          wo: toText(row[4]),
          netweight: toNumber(row[5], excelRow, "Netweight"),
          quanperh: toNumber(row[6], excelRow, "quanperh"),
          quanperday: toNumber(row[7], excelRow, "quanperday"),
          color: toText(row[8]),
          material: toText(row[9]),
          package: toText(row[10]),
          quanorder: toNumber(row[11], excelRow, "quanorder"),
        };

        if (!isEmptyRow(parsedRow)) rows.push(parsedRow);
      } catch (error) {
        console.error("[planning-import] row parse failed", {
          excelRow,
          raw: previewRow(row),
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }

      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { error: `File vượt quá giới hạn ${MAX_ROWS.toLocaleString("vi-VN")} dòng dữ liệu.` },
          { status: 400 },
        );
      }
    }

    console.log("[planning-import] rows parsed", { importedRows: rows.length });

    if (rows.length === 0) {
      return NextResponse.json({ error: "Sheet data không có dữ liệu sau dòng header." }, { status: 400 });
    }

    stage = "rpc";
    console.log("[planning-import] calling replace_planning_inject", {
      rows: rows.length,
      sourceFile: file.name,
    });

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("replace_planning_inject", {
      p_rows: rows,
      p_source_file: file.name,
    });
    if (error) {
      console.error("[planning-import] replace_planning_inject failed", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return NextResponse.json({ error: "Không thể cập nhật database. Vui lòng thử lại." }, { status: 500 });
    }

    console.log("[planning-import] completed", {
      imported: Number(data ?? rows.length),
      fileName: file.name,
    });

    return NextResponse.json({ success: true, imported: Number(data ?? rows.length), fileName: file.name });
  } catch (error) {
    console.error("[planning-import] failed", {
      stage,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const message = error instanceof Error ? error.message : "Không thể đọc file Excel.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
