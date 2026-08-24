import path from "node:path";
import { inflateRawSync } from "node:zlib";

import readExcelFile, { type CellValue } from "read-excel-file/node";
import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_WARNING_LOGS = 20;
const PLANNING_SHEET_NAME = "Daily plan";
const PLANNING_SHEET_KEY = "daily plan";
const FIRST_DATA_ROW = 5;
const EXPECTED_COLUMN_COUNT = 12;

type CellPrimitive = CellValue | null | undefined;
type CellAddress = { row: number; column: number };

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

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function getXmlAttribute(tag: string, attributeName: string): string | null {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}=(?:"([^"]*)"|'([^']*)')`, "i"));
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? null : decodeXmlAttribute(value);
}

function readZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  let endOfCentralDirectoryOffset = -1;

  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }

  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("File .xlsx không có ZIP central directory hợp lệ.");
  }

  const totalEntries = buffer.readUInt16LE(endOfCentralDirectoryOffset + 10);
  let offset = buffer.readUInt32LE(endOfCentralDirectoryOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralDirectorySignature) {
      throw new Error("Cấu trúc ZIP trong file .xlsx không hợp lệ.");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8");

    if (fileName === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== localFileHeaderSignature) {
        throw new Error(`ZIP local header không hợp lệ cho ${entryName}.`);
      }

      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) return Buffer.from(compressedData);
      if (compressionMethod === 8) return Buffer.from(inflateRawSync(compressedData));
      throw new Error(`File .xlsx dùng kiểu nén ZIP chưa được hỗ trợ (${compressionMethod}).`);
    }

    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return null;
}

function readZipText(buffer: Buffer, entryName: string): string {
  const entry = readZipEntry(buffer, entryName);
  if (!entry) throw new Error(`Không tìm thấy ${entryName} trong file .xlsx.`);
  return entry.toString("utf8");
}

function findSheetXmlPath(buffer: Buffer, sheetName: string): string {
  const workbookXml = readZipText(buffer, "xl/workbook.xml");
  const workbookRelationshipsXml = readZipText(buffer, "xl/_rels/workbook.xml.rels");
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?\s*>/gi) ?? [];
  let relationshipId: string | null = null;

  for (const tag of sheetTags) {
    const name = getXmlAttribute(tag, "name");
    if (normalizeSheetName(name) === normalizeSheetName(sheetName)) {
      relationshipId = getXmlAttribute(tag, "r:id");
      break;
    }
  }

  if (!relationshipId) {
    throw new Error(`Không tìm thấy metadata của sheet ${sheetName} trong workbook.`);
  }

  const relationshipTags = workbookRelationshipsXml.match(/<Relationship\b[^>]*\/?\s*>/gi) ?? [];
  let target: string | null = null;
  for (const tag of relationshipTags) {
    if (getXmlAttribute(tag, "Id") === relationshipId) {
      target = getXmlAttribute(tag, "Target");
      break;
    }
  }

  if (!target) {
    throw new Error(`Không tìm thấy file XML tương ứng sheet ${sheetName}.`);
  }

  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) return normalizedTarget.replace(/^\/+/, "");
  return path.posix.normalize(path.posix.join("xl", normalizedTarget));
}

function parseCellAddress(value: string): CellAddress | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(value.trim());
  if (!match) return null;

  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }

  const row = Number.parseInt(match[2], 10);
  if (!Number.isInteger(row) || row < 1 || column < 1) return null;
  return { row: row - 1, column: column - 1 };
}

function readMergeRanges(buffer: Buffer, sheetName: string): string[] {
  const sheetXmlPath = findSheetXmlPath(buffer, sheetName);
  const sheetXml = readZipText(buffer, sheetXmlPath);
  const mergeTags = sheetXml.match(/<mergeCell\b[^>]*\/?\s*>/gi) ?? [];
  return mergeTags
    .map((tag) => getXmlAttribute(tag, "ref"))
    .filter((value): value is string => Boolean(value));
}

function expandMergedCells(
  worksheet: (CellValue | null)[][],
  mergeRanges: string[],
): (CellValue | null)[][] {
  const expanded = worksheet.map((row) => [...row]);

  for (const range of mergeRanges) {
    const [startText, endText = startText] = range.split(":");
    const start = parseCellAddress(startText);
    const end = parseCellAddress(endText);
    if (!start || !end) continue;

    const firstRow = Math.min(start.row, end.row);
    const lastRow = Math.max(start.row, end.row);
    const firstColumn = Math.min(start.column, end.column);
    const lastColumn = Math.max(start.column, end.column);
    const sourceValue = expanded[firstRow]?.[firstColumn] ?? null;
    if (sourceValue === null || sourceValue === undefined || sourceValue === "") continue;

    while (expanded.length <= lastRow) expanded.push([]);

    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
      const row = expanded[rowIndex] ?? [];
      expanded[rowIndex] = row;
      while (row.length <= lastColumn) row.push(null);

      for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex += 1) {
        if (row[columnIndex] === null || row[columnIndex] === undefined || row[columnIndex] === "") {
          row[columnIndex] = sourceValue;
        }
      }
    }
  }

  return expanded;
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
      (entry) => normalizeSheetName(entry?.sheet) === PLANNING_SHEET_KEY,
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

    const mergeRanges = readMergeRanges(buffer, PLANNING_SHEET_NAME);
    const worksheet = expandMergedCells(
      selected.data as (CellValue | null)[][],
      mergeRanges,
    );

    if (worksheet.length < FIRST_DATA_ROW) {
      return NextResponse.json(
        { error: `Sheet ${PLANNING_SHEET_NAME} không có dữ liệu từ dòng ${FIRST_DATA_ROW}.` },
        { status: 400 },
      );
    }

    const widestRow = worksheet.reduce((max, row) => Math.max(max, row.length), 0);
    if (widestRow < EXPECTED_COLUMN_COUNT) {
      return NextResponse.json(
        { error: `Sheet ${PLANNING_SHEET_NAME} phải có đủ ${EXPECTED_COLUMN_COUNT} cột từ A đến L.` },
        { status: 400 },
      );
    }

    const rows: PlanningRow[] = [];
    const warnings: string[] = [];

    // Sheet Daily plan là sheet thô. Dữ liệu bắt đầu từ dòng 5.
    // Merge được bung đúng theo vùng merge trước khi kiểm tra điều kiện A/B.
    for (let dataIndex = FIRST_DATA_ROW - 1; dataIndex < worksheet.length; dataIndex += 1) {
      const excelRow = dataIndex + 1;
      const row = worksheet[dataIndex] ?? [];

      const machine = toText(row[0] ?? null);
      const itemcode = toItemCode(row[1] ?? null, excelRow, warnings);

      // Chỉ lấy dòng có cả cột A (Machine) và B (Itemcode).
      if (!machine || !itemcode) continue;

      const parsedRow: PlanningRow = {
        machine,
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
        {
          error: `Sheet ${PLANNING_SHEET_NAME} không có dòng kế hoạch hợp lệ từ dòng ${FIRST_DATA_ROW} với cả cột A và B có dữ liệu.`,
        },
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
      mergeRanges: mergeRanges.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể đọc file Excel.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
