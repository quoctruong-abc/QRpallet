import readExcelFile, { type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_WARNING_LOGS = 20;
const PLANNING_SHEET_NAME = "data";
const EXPECTED_COLUMN_COUNT = 12;

type CellPrimitive = CellValue | null | undefined;

function normalizeSheetName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function toText(value: CellPrimitive): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return text === "" ? null : text;
}

function expandExponentialString(value: string): string {
  const match = value.toLowerCase().match(/^([+-]?)(\d+)(?:\.(\d*))?e([+-]?\d+)$/);
  if (!match) return value;

  const [, sign, integerPart, fractionPart = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) return value;

  const digits = `${integerPart}${fractionPart}`;
  const decimalIndex = integerPart.length + exponent;
  let expanded: string;

  if (decimalIndex <= 0) {
    expanded = `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return `${sign}${expanded}`;
}

function toItemCode(value: CellPrimitive, excelRow: number, warnings: string[]): string | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value) && !Number.isSafeInteger(value) && warnings.length < MAX_WARNING_LOGS) {
      warnings.push(
        `Dòng ${excelRow}, Itemcode là số vượt giới hạn integer an toàn của JavaScript; nếu mã dài hơn 15 chữ số hãy để cột Itemcode dạng Text trong Excel.`,
      );
    }
    return expandExponentialString(String(value));
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(text)) {
    return expandExponentialString(text);
  }

  return text;
}

function parseFlexibleNumber(value: CellPrimitive): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date || typeof value === "boolean") return null;

  let raw = String(value)
    .trim()
    .replace(/^'+/, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, "");

  if (!raw) return null;

  let negative = false;
  if (raw.startsWith("(") && raw.endsWith(")")) {
    negative = true;
    raw = raw.slice(1, -1);
  }

  const numericToken = raw.match(/[+-]?\d[\d.,]*(?:[eE][+-]?\d+)?/i)?.[0];
  if (!numericToken) return null;

  let normalized = numericToken;
  const commaCount = (normalized.match(/,/g) ?? []).length;
  const dotCount = (normalized.match(/\./g) ?? []).length;

  if (!/[eE]/.test(normalized)) {
    if (commaCount > 0 && dotCount > 0) {
      const lastComma = normalized.lastIndexOf(",");
      const lastDot = normalized.lastIndexOf(".");
      if (lastComma > lastDot) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        normalized = normalized.replace(/,/g, "");
      }
    } else if (commaCount > 0) {
      const pieces = normalized.split(",");
      const looksLikeThousands = pieces.length > 1 && pieces.slice(1).every((part) => part.length === 3);
      normalized = looksLikeThousands ? pieces.join("") : normalized.replace(",", ".");
    } else if (dotCount > 1) {
      const pieces = normalized.split(".");
      const looksLikeThousands = pieces.length > 1 && pieces.slice(1).every((part) => part.length === 3);
      if (looksLikeThousands) normalized = pieces.join("");
    }
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function optionalNumber(
  value: CellPrimitive,
  excelRow: number,
  columnName: string,
  warnings: string[],
): number | null {
  const parsed = parseFlexibleNumber(value);
  if (parsed !== null) return parsed;

  const raw = toText(value);
  if (raw && warnings.length < MAX_WARNING_LOGS) {
    warnings.push(`Dòng ${excelRow}, ${columnName}: “${raw}” không chuyển được sang số nên đã để null.`);
  }
  return null;
}

function requiredReportNumber(value: CellPrimitive, excelRow: number): number | null {
  const parsed = parseFlexibleNumber(value);
  if (parsed !== null) return parsed;

  const raw = toText(value);
  if (!raw) return null;
  throw new Error(`Dòng ${excelRow}, cột Quanorder: “${raw}” không thể chuyển thành số.`);
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
    const workbook = await readExcelFile(buffer, { trim: false });
    const selected = workbook.find(
      (entry) => normalizeSheetName(entry?.sheet) === PLANNING_SHEET_NAME,
    );

    if (!selected || !Array.isArray(selected.data)) {
      const names = workbook
        .map((entry) => (typeof entry?.sheet === "string" ? entry.sheet : null))
        .filter((name): name is string => Boolean(name));
      return NextResponse.json(
        {
          error: `Không tìm thấy sheet tên ${PLANNING_SHEET_NAME} trong file Excel. Sheet hiện có: ${names.join(", ") || "không xác định"}.`,
        },
        { status: 400 },
      );
    }

    const worksheet: CellValue[][] = selected.data;
    if (worksheet.length === 0) {
      return NextResponse.json({ error: "Sheet data đang trống." }, { status: 400 });
    }

    const widestRow = worksheet.reduce((max, row) => Math.max(max, row.length), 0);
    if (widestRow < EXPECTED_COLUMN_COUNT) {
      return NextResponse.json(
        { error: `Sheet data phải có đủ ${EXPECTED_COLUMN_COUNT} cột từ A đến L.` },
        { status: 400 },
      );
    }

    const rows: PlanningRow[] = [];
    const warnings: string[] = [];

    // Dòng 1 luôn là header. Dữ liệu bắt đầu từ dòng 2.
    for (let dataIndex = 1; dataIndex < worksheet.length; dataIndex += 1) {
      const excelRow = dataIndex + 1;
      const row = worksheet[dataIndex] ?? [];

      const itemcode = toItemCode(row[1] ?? null, excelRow, warnings);
      if (!itemcode) continue;

      const parsedRow: PlanningRow = {
        machine: toText(row[0] ?? null),
        itemcode,
        product_name: toText(row[2] ?? null),
        customer: toText(row[3] ?? null),
        wo: toText(row[4] ?? null),
        netweight: optionalNumber(row[5] ?? null, excelRow, "Netweight", warnings),
        quanperh: optionalNumber(row[6] ?? null, excelRow, "quanperh", warnings),
        quanperday: optionalNumber(row[7] ?? null, excelRow, "quanperday", warnings),
        color: toText(row[8] ?? null),
        material: toText(row[9] ?? null),
        package: toText(row[10] ?? null),
        quanorder: requiredReportNumber(row[11] ?? null, excelRow),
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
      return NextResponse.json(
        { error: "Sheet data không có dòng kế hoạch hợp lệ có Itemcode." },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("replace_planning_inject", {
      p_rows: rows,
      p_source_file: file.name,
    });
    if (error) {
      return NextResponse.json({ error: `Không thể cập nhật database: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      imported: Number(data ?? rows.length),
      fileName: file.name,
      warnings: warnings.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể đọc file Excel.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
