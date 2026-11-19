import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { CellValue } from "read-excel-file/node";
type CellAddress = { row: number; column: number };
const normalizeSheetName = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

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

export function readMergeRanges(buffer: Buffer, sheetName: string): string[] {
  const sheetXmlPath = findSheetXmlPath(buffer, sheetName);
  const sheetXml = readZipText(buffer, sheetXmlPath);
  const mergeTags = sheetXml.match(/<mergeCell\b[^>]*\/?\s*>/gi) ?? [];
  return mergeTags
    .map((tag) => getXmlAttribute(tag, "ref"))
    .filter((value): value is string => Boolean(value));
}

export function expandMergedCells(
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
    if (lastRow > 25000 || lastColumn > 200) throw new Error("Vùng merge vượt giới hạn 25.000 dòng / 200 cột.");
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

