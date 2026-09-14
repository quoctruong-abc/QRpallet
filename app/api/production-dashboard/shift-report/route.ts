import readExcelFile, { type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const SHEET_NAME = "upsever";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const DATABASE_BATCH_SIZE = 1000;
const WRITE_BATCH_SIZE = 500;

type CellPrimitive = CellValue | null | undefined;

type ShiftReportRow = {
  id_report: string;
  report_date: string;
  machine: string;
  itemcode: string;
  wo: string;
  ok_goods: number;
};

type ExistingShiftReportRow = ShiftReportRow;

type AuditConflict = {
  key: string;
  reportDate: string;
  machine: string;
  itemcode: string;
  wo: string;
  oldOkGoods: number;
  newOkGoods: number;
  oldReportId: string;
  newReportId: string;
};

function normalizeSheetName(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function toText(value: CellPrimitive) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function expandExponentialString(value: string) {
  const match = value.toLowerCase().match(/^([+-]?)(\d+)(?:\.(\d*))?e([+-]?\d+)$/);
  if (!match) return value;

  const [, sign, integerPart, fractionPart = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) return value;

  const digits = `${integerPart}${fractionPart}`;
  const decimalIndex = integerPart.length + exponent;
  let expanded: string;
  if (decimalIndex <= 0) expanded = `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  else if (decimalIndex >= digits.length) expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  else expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return `${sign}${expanded}`;
}

function toCode(value: CellPrimitive) {
  const text = toText(value);
  return /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(text)
    ? expandExponentialString(text)
    : text;
}

function toIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseReportDate(value: CellPrimitive) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const serial = Math.floor(value);
    if (serial <= 0) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }

  const text = toText(value).replace(/^'+/, "");
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (isoMatch) return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  // Báo ca dùng M/D/YYYY: 9/3/2026 nghĩa là ngày 03/09/2026.
  const reportMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(text);
  if (reportMatch) {
    return toIsoDate(Number(reportMatch[3]), Number(reportMatch[1]), Number(reportMatch[2]));
  }

  return null;
}

function parseOkGoods(value: CellPrimitive) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date || typeof value === "boolean") return null;
  const text = toText(value).replace(/^'+/, "").replace(/\s/g, "");
  if (!text) return null;

  let normalized = text;
  if (text.includes(",") && text.includes(".")) {
    normalized = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    const pieces = text.split(",");
    normalized = pieces.length > 1 && pieces.slice(1).every((part) => part.length === 3)
      ? pieces.join("")
      : text.replace(",", ".");
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function stableKey(row: Pick<ShiftReportRow, "report_date" | "machine" | "wo">) {
  return JSON.stringify([row.report_date, row.machine, row.wo]);
}

async function parseWorkbook(file: File) {
  if (file.size === 0) throw new Error("File báo ca đang trống.");
  if (file.size > MAX_FILE_SIZE) throw new Error("File báo ca vượt quá 10 MB.");
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Hệ thống chỉ nhận file .xlsx có sheet upsever.");
  }

  const workbook = await readExcelFile(Buffer.from(await file.arrayBuffer()), { trim: false });
  const selected = workbook.find(
    (entry) => normalizeSheetName(entry?.sheet) === SHEET_NAME,
  );

  if (!selected || !Array.isArray(selected.data)) {
    const names = workbook
      .map((entry) => (typeof entry?.sheet === "string" ? entry.sheet : null))
      .filter((name): name is string => Boolean(name));
    throw new Error(
      `Không tìm thấy sheet ${SHEET_NAME}. Sheet hiện có: ${names.join(", ") || "không xác định"}.`,
    );
  }

  const worksheet = selected.data as (CellValue | null)[][];
  const rows: ShiftReportRow[] = [];
  const keys = new Set<string>();
  let currentDate: string | null = null;

  // Bỏ dòng tiêu đề. Mapping: A, B, C, D, F, I.
  for (let rowIndex = 1; rowIndex < worksheet.length; rowIndex += 1) {
    const excelRow = rowIndex + 1;
    const source = worksheet[rowIndex] ?? [];
    const dateCell = source[1] ?? null;

    if (dateCell !== null && dateCell !== undefined && dateCell !== "") {
      currentDate = parseReportDate(dateCell);
      if (!currentDate) {
        throw new Error(`Dòng ${excelRow}, cột B không phải ngày M/D/YYYY hợp lệ.`);
      }
    }

    const idReport = toCode(source[0] ?? null);
    const machine = toText(source[2] ?? null);
    const itemcode = toCode(source[3] ?? null);
    const wo = toCode(source[5] ?? null);
    const okGoodsCell = source[8] ?? null;
    const rowHasData = Boolean(idReport || machine || itemcode || wo || toText(okGoodsCell));
    if (!rowHasData) continue;

    if (!currentDate) throw new Error(`Dòng ${excelRow} chưa có ngày báo ca ở cột B.`);
    if (!idReport) throw new Error(`Dòng ${excelRow} thiếu ID report ở cột A.`);
    if (!machine) throw new Error(`Dòng ${excelRow} thiếu Machine ở cột C.`);
    if (!itemcode) throw new Error(`Dòng ${excelRow} thiếu Itemcode ở cột D.`);
    if (!wo) throw new Error(`Dòng ${excelRow} thiếu WO ở cột F.`);

    const okGoods = parseOkGoods(okGoodsCell);
    if (okGoods === null || okGoods < 0) {
      throw new Error(`Dòng ${excelRow}, OK goods ở cột I phải là số không âm.`);
    }

    const parsed: ShiftReportRow = {
      id_report: idReport,
      report_date: currentDate,
      machine,
      itemcode,
      wo,
      ok_goods: okGoods,
    };
    const key = stableKey(parsed);
    if (keys.has(key)) {
      throw new Error(`Dòng ${excelRow} bị trùng cụm Date + Machine + WO trong cùng file.`);
    }
    keys.add(key);
    rows.push(parsed);

    if (rows.length > MAX_ROWS) {
      throw new Error(`File vượt quá giới hạn ${MAX_ROWS.toLocaleString("vi-VN")} dòng dữ liệu.`);
    }
  }

  if (!rows.length) throw new Error(`Sheet ${SHEET_NAME} không có dòng dữ liệu hợp lệ sau tiêu đề.`);
  const dates = rows.map((row) => row.report_date).sort();
  return {
    rows,
    fileName: file.name,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
  };
}

async function writeRows(rows: ShiftReportRow[], ignoreDuplicates: boolean) {
  const adminClient = createAdminClient();
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const { error } = await adminClient
      .from("shift_report_data")
      .upsert(rows.slice(offset, offset + WRITE_BATCH_SIZE), {
        onConflict: "report_date,machine,wo",
        ignoreDuplicates,
      });
    if (error) throw new Error(`Không thể ghi dữ liệu báo ca: ${error.message}`);
  }
}

async function loadExistingRows(firstDate: string, lastDate: string) {
  const adminClient = createAdminClient();
  const rows: ExistingShiftReportRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("shift_report_data")
      .select("id_report,report_date,machine,itemcode,wo,ok_goods")
      .gte("report_date", firstDate)
      .lte("report_date", lastDate)
      .order("report_date", { ascending: true })
      .order("machine", { ascending: true })
      .order("wo", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc dữ liệu báo ca: ${error.message}`);
    const pageRows = (data ?? []).map((row) => ({
      ...row,
      ok_goods: Number(row.ok_goods) || 0,
    })) as ExistingShiftReportRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("dashboard.view");
  if (!authorization.ok) {
    return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const mode = formData.get("mode") === "audit" ? "audit" : "standard";
    const phase = formData.get("phase") === "apply" ? "apply" : "preview";
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Vui lòng chọn file báo ca." }, { status: 400 });
    }

    const parsed = await parseWorkbook(file);

    if (mode === "standard") {
      const adminClient = createAdminClient();
      const { data, error } = await adminClient
        .from("shift_report_data")
        .select("report_date")
        .order("report_date", { ascending: false })
        .limit(1);
      if (error) throw new Error(`Không thể kiểm tra ngày cuối database: ${error.message}`);

      const databaseLastDate = data?.[0]?.report_date ?? null;
      const missingDateRows = databaseLastDate
        ? parsed.rows.filter((row) => row.report_date > databaseLastDate)
        : parsed.rows;
      await writeRows(missingDateRows, true);

      return NextResponse.json({
        success: true,
        mode,
        fileName: parsed.fileName,
        parsed: parsed.rows.length,
        imported: missingDateRows.length,
        updated: 0,
        skipped: parsed.rows.length - missingDateRows.length,
        firstDate: parsed.firstDate,
        lastDate: parsed.lastDate,
        databaseLastDate,
      });
    }

    const existingRows = await loadExistingRows(parsed.firstDate, parsed.lastDate);
    const existingByKey = new Map(existingRows.map((row) => [stableKey(row), row]));
    const missingRows: ShiftReportRow[] = [];
    const conflictRows = new Map<string, ShiftReportRow>();
    const conflicts: AuditConflict[] = [];
    let unchanged = 0;

    for (const row of parsed.rows) {
      const key = stableKey(row);
      const existing = existingByKey.get(key);
      if (!existing) {
        missingRows.push(row);
      } else if (Number(existing.ok_goods) !== row.ok_goods) {
        conflictRows.set(key, row);
        conflicts.push({
          key,
          reportDate: row.report_date,
          machine: row.machine,
          itemcode: row.itemcode,
          wo: row.wo,
          oldOkGoods: Number(existing.ok_goods) || 0,
          newOkGoods: row.ok_goods,
          oldReportId: existing.id_report,
          newReportId: row.id_report,
        });
      } else {
        unchanged += 1;
      }
    }

    if (phase === "preview") {
      return NextResponse.json({
        success: true,
        mode,
        phase,
        fileName: parsed.fileName,
        parsed: parsed.rows.length,
        missing: missingRows.length,
        unchanged,
        conflicts,
        firstDate: parsed.firstDate,
        lastDate: parsed.lastDate,
      });
    }

    let confirmedKeys: string[] = [];
    try {
      const decoded = JSON.parse(String(formData.get("confirmedKeys") ?? "[]"));
      if (Array.isArray(decoded)) confirmedKeys = decoded.filter((value): value is string => typeof value === "string");
    } catch {
      return NextResponse.json({ success: false, error: "Danh sách xác nhận audit không hợp lệ." }, { status: 400 });
    }

    const confirmed = new Set(confirmedKeys);
    const updatedRows = Array.from(conflictRows.entries())
      .filter(([key]) => confirmed.has(key))
      .map(([, row]) => row);
    await writeRows([...missingRows, ...updatedRows], false);

    return NextResponse.json({
      success: true,
      mode,
      phase,
      fileName: parsed.fileName,
      parsed: parsed.rows.length,
      imported: missingRows.length,
      updated: updatedRows.length,
      skipped: unchanged + conflicts.length - updatedRows.length,
      conflicts: conflicts.length,
      firstDate: parsed.firstDate,
      lastDate: parsed.lastDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể xử lý file báo ca.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
