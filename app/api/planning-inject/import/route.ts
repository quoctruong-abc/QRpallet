import { readSheet, type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_ROWS = 20000;
const HEADER_SCAN_ROWS = 30;
const MAX_WARNING_LOGS = 20;
const PLANNING_SHEET_NAME = "data";

type CellPrimitive = CellValue | null | undefined;
type PlanningField = Exclude<keyof PlanningRow, "id" | "source_file" | "imported_at">;
type ColumnMap = Partial<Record<PlanningField, number>>;

const FIXED_COLUMN_MAP: ColumnMap = {
  machine: 0,
  itemcode: 1,
  product_name: 2,
  customer: 3,
  wo: 4,
  netweight: 5,
  quanperh: 6,
  quanperday: 7,
  color: 8,
  material: 9,
  package: 10,
  quanorder: 11,
};

const HEADER_ALIASES: Record<PlanningField, string[]> = {
  machine: ["machine", "machineno", "machinecode", "may", "somay"],
  itemcode: ["itemcode", "item", "itemno", "itemnumber", "maitem", "mavattu"],
  product_name: ["productname", "product", "description", "productdescription", "tenhang", "tensanpham"],
  customer: ["customer", "customername", "khachhang"],
  wo: ["wo", "workorder", "workorderno", "workordernumber"],
  netweight: ["netweight", "netweightg", "netweigth", "netweigthg", "netwt", "netwtg"],
  quanperh: ["quanperh", "qtyperh", "quantityperh", "quantityperhour", "qtyperhour"],
  quanperday: ["quanperday", "qtyperday", "quantityperday", "quantityday"],
  color: ["color", "colour", "mau"],
  material: ["material", "nguyenlieu"],
  package: ["package", "packaging", "packing", "donggoi"],
  quanorder: ["quanorder", "orderqty", "orderquantity", "qtyorder", "quantityorder", "orderedqty"],
};

function normalizeHeader(value: CellPrimitive): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
        `Dòng ${excelRow}, Itemcode là số vượt giới hạn integer an toàn của JavaScript; hãy format cột Itemcode thành Text trong Excel nếu cần giữ tuyệt đối mọi chữ số.`,
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

function requiredReportNumber(value: CellPrimitive, excelRow: number, columnName: string): number | null {
  const parsed = parseFlexibleNumber(value);
  if (parsed !== null) return parsed;

  const raw = toText(value);
  if (!raw) return null;
  throw new Error(`Dòng ${excelRow}, cột ${columnName}: “${raw}” không thể chuyển thành số.`);
}

function matchHeaderField(value: CellPrimitive): PlanningField | null {
  const normalized = normalizeHeader(value);
  if (!normalized) return null;

  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [PlanningField, string[]][]) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

function buildColumnMap(row: CellValue[]): ColumnMap {
  const map: ColumnMap = {};
  row.forEach((value, index) => {
    const field = matchHeaderField(value);
    if (field && map[field] === undefined) map[field] = index;
  });
  return map;
}

function headerScore(map: ColumnMap): number {
  return Object.keys(map).length;
}

function findHeader(worksheet: CellValue[][]): { headerIndex: number; columnMap: ColumnMap; detected: boolean } {
  let bestIndex = -1;
  let bestMap: ColumnMap = {};
  let bestScore = 0;

  for (let index = 0; index < Math.min(worksheet.length, HEADER_SCAN_ROWS); index += 1) {
    const map = buildColumnMap(worksheet[index] ?? []);
    const score = headerScore(map);
    if (score > bestScore) {
      bestIndex = index;
      bestMap = map;
      bestScore = score;
    }
  }

  if (
    bestIndex >= 0 &&
    bestScore >= 4 &&
    bestMap.itemcode !== undefined &&
    bestMap.quanorder !== undefined
  ) {
    return { headerIndex: bestIndex, columnMap: bestMap, detected: true };
  }

  return { headerIndex: 0, columnMap: FIXED_COLUMN_MAP, detected: false };
}

function getCell(row: CellValue[], columnMap: ColumnMap, field: PlanningField): CellPrimitive {
  const index = columnMap[field];
  return index === undefined ? null : row[index] ?? null;
}

function looksLikeRepeatedHeader(row: CellValue[]): boolean {
  return headerScore(buildColumnMap(row)) >= 4;
}

function isEmptyRow(row: PlanningRow) {
  return Object.values(row).every((value) => value === null || value === "");
}

export async function POST(request: Request) {
  const authorization = await authorizePermission("planning.upload");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  let stage = "request";

  try {
    stage = "form-data";
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Vui lòng chọn file Excel." }, { status: 400 });
    }

    console.info("[planning-import] file received", {
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
    console.info("[planning-import] buffer ready", { bytes: buffer.length });

    stage = "read-sheet";
    let worksheet: CellValue[][];
    console.info("[planning-import] reading sheet", { requestedSheet: PLANNING_SHEET_NAME });
    try {
      worksheet = await readSheet(buffer, PLANNING_SHEET_NAME);
      console.info("[planning-import] sheet selected", { selectedSheet: PLANNING_SHEET_NAME });
    } catch (error) {
      console.error("[planning-import] readSheet failed", {
        stage,
        requestedSheet: PLANNING_SHEET_NAME,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (error instanceof Error && error.name === "SheetNotFoundError") {
        return NextResponse.json(
          { error: `Không tìm thấy sheet tên ${PLANNING_SHEET_NAME} trong file Excel.` },
          { status: 400 },
        );
      }
      throw error;
    }

    const widestRow = worksheet.reduce((max, row) => Math.max(max, row.length), 0);
    console.info("[planning-import] sheet loaded", {
      selectedSheet: PLANNING_SHEET_NAME,
      rows: worksheet.length,
      widestRow,
      preview: worksheet.slice(0, 6).map((row) => row.slice(0, 12)),
    });

    if (worksheet.length === 0) {
      return NextResponse.json({ error: "Sheet data đang trống." }, { status: 400 });
    }

    stage = "detect-header";
    const { headerIndex, columnMap, detected } = findHeader(worksheet);
    console.info("[planning-import] header mapping", {
      selectedSheet: PLANNING_SHEET_NAME,
      detected,
      excelHeaderRow: headerIndex + 1,
      columnMap,
      headerValues: worksheet[headerIndex]?.slice(0, Math.max(widestRow, 12)),
    });

    if (columnMap.itemcode === undefined || columnMap.quanorder === undefined) {
      return NextResponse.json(
        { error: "Không nhận diện được cột Itemcode và Quanorder trong sheet data." },
        { status: 400 },
      );
    }

    stage = "parse-rows";
    const rows: PlanningRow[] = [];
    const warnings: string[] = [];
    let skippedRepeatedHeaders = 0;
    let skippedNoItem = 0;

    for (let dataIndex = headerIndex + 1; dataIndex < worksheet.length; dataIndex += 1) {
      const excelRow = dataIndex + 1;
      const row = worksheet[dataIndex] ?? [];

      if (looksLikeRepeatedHeader(row)) {
        skippedRepeatedHeaders += 1;
        continue;
      }

      try {
        const itemcode = toItemCode(getCell(row, columnMap, "itemcode"), excelRow, warnings);
        const wo = toText(getCell(row, columnMap, "wo"));

        if (!itemcode) {
          const hasAnyCell = row.some((value) => toText(value) !== null);
          if (hasAnyCell) skippedNoItem += 1;
          continue;
        }

        const parsedRow: PlanningRow = {
          machine: toText(getCell(row, columnMap, "machine")),
          itemcode,
          product_name: toText(getCell(row, columnMap, "product_name")),
          customer: toText(getCell(row, columnMap, "customer")),
          wo,
          netweight: optionalNumber(getCell(row, columnMap, "netweight"), excelRow, "Netweight", warnings),
          quanperh: optionalNumber(getCell(row, columnMap, "quanperh"), excelRow, "quanperh", warnings),
          quanperday: optionalNumber(getCell(row, columnMap, "quanperday"), excelRow, "quanperday", warnings),
          color: toText(getCell(row, columnMap, "color")),
          material: toText(getCell(row, columnMap, "material")),
          package: toText(getCell(row, columnMap, "package")),
          quanorder: requiredReportNumber(getCell(row, columnMap, "quanorder"), excelRow, "Quanorder"),
        };

        if (!isEmptyRow(parsedRow)) rows.push(parsedRow);
      } catch (error) {
        console.error("[planning-import] row parse failed", {
          stage,
          selectedSheet: PLANNING_SHEET_NAME,
          excelRow,
          rawRow: row.slice(0, Math.max(widestRow, 12)),
          message: error instanceof Error ? error.message : String(error),
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

    console.info("[planning-import] rows parsed", {
      selectedSheet: PLANNING_SHEET_NAME,
      importedCandidates: rows.length,
      skippedRepeatedHeaders,
      skippedNoItem,
      warningCount: warnings.length,
      warnings,
      sample: rows.slice(0, 3),
    });

    if (rows.length === 0) {
      return NextResponse.json({ error: "Sheet data không có dòng kế hoạch hợp lệ có Itemcode." }, { status: 400 });
    }

    stage = "rpc";
    console.info("[planning-import] calling replace_planning_inject", {
      selectedSheet: PLANNING_SHEET_NAME,
      rows: rows.length,
      sourceFile: file.name,
    });

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("replace_planning_inject", {
      p_rows: rows,
      p_source_file: file.name,
    });
    if (error) {
      console.error("replace_planning_inject failed", error);
      return NextResponse.json({ error: `Không thể cập nhật database: ${error.message}` }, { status: 500 });
    }

    console.info("[planning-import] completed", {
      selectedSheet: PLANNING_SHEET_NAME,
      imported: Number(data ?? rows.length),
      sourceFile: file.name,
      warningCount: warnings.length,
    });

    return NextResponse.json({
      success: true,
      imported: Number(data ?? rows.length),
      fileName: file.name,
      warnings: warnings.length,
    });
  } catch (error) {
    console.error("[planning-import] failed", {
      stage,
      requestedSheet: PLANNING_SHEET_NAME,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const message = error instanceof Error ? error.message : "Không thể đọc file Excel.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
