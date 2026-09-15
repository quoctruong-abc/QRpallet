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
const WO_BATCH_SIZE = 100;

type CellPrimitive = CellValue | null | undefined;

type ShiftReportRow = {
  id_report: string;
  report_date: string;
  machine: string;
  itemcode: string;
  product_name: string;
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

type PalletComparisonSourceRow = {
  id: number;
  wo: string | null;
  quantity: number | string | null;
};

type ReportComparisonSourceRow = {
  id_report: string;
  wo: string;
  ok_goods: number | string;
};

type PalletTotalSourceRow = {
  id: number;
  wo: string | null;
  itemcode: string | null;
  quanorder: number | string | null;
  quantity: number | string | null;
};

type PalletWoTotal = {
  quantity: number;
  orderQuantity: number;
  itemcodes: Set<string>;
};

type ReportTotalSourceRow = {
  id_report: string;
  wo: string;
  machine: string;
  itemcode: string;
  product_name: string | null;
  ok_goods: number | string;
};

type ReportWoTotal = {
  quantity: number;
  machines: Set<string>;
  itemcodes: Set<string>;
  productNames: Set<string>;
};

type PalletDailyHistorySourceRow = {
  id: number;
  pallet_id: string;
  working_day: string;
  quantity: number | string | null;
  has_been_edited: boolean | null;
  has_been_return: boolean | null;
};

type DeletedDailyHistorySourceRow = {
  id: number;
  working_day: string;
};

type ReportDailyHistorySourceRow = {
  id_report: string;
  report_date: string;
  ok_goods: number | string;
};

type DailyHistoryGroup = {
  date: string;
  appQuantity: number;
  palletIds: Set<string>;
  erpQuantity: number;
  warning: boolean;
};

type ComparisonGroup = {
  wo: string;
  appQuantity: number;
  erpQuantity: number;
  hasAppData: boolean;
  hasErpData: boolean;
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

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return toIsoDate(year, month, day) === value;
}

function comparisonKey(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

function addCleanValue(target: Set<string>, value: string | null | undefined) {
  const cleaned = value?.trim();
  if (cleaned) target.add(cleaned);
}

function sortedValues(values: Set<string>) {
  return Array.from(values).sort((a, b) => a.localeCompare(b, "vi", { numeric: true }));
}

function sameCodeSets(left: Set<string>, right: Set<string>) {
  const normalizedRight = new Set(Array.from(right, comparisonKey));
  return left.size === right.size
    && Array.from(left).every((value) => normalizedRight.has(comparisonKey(value)));
}

function createComparisonGroup(wo: string): ComparisonGroup {
  return {
    wo,
    appQuantity: 0,
    erpQuantity: 0,
    hasAppData: false,
    hasErpData: false,
  };
}

async function loadPalletComparisonRows(reportDate: string) {
  const adminClient = createAdminClient();
  const rows: PalletComparisonSourceRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("pallet_data")
      .select("id,wo,quantity")
      .is("effect_to", null)
      .eq("working_day", reportDate)
      .order("id", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc dữ liệu pallet: ${error.message}`);
    const pageRows = (data ?? []) as PalletComparisonSourceRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

async function loadReportComparisonRows(reportDate: string) {
  const adminClient = createAdminClient();
  const rows: ReportComparisonSourceRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("shift_report_data")
      .select("id_report,wo,ok_goods")
      .eq("report_date", reportDate)
      .order("wo", { ascending: true })
      .order("id_report", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc dữ liệu báo ca: ${error.message}`);
    const pageRows = (data ?? []) as ReportComparisonSourceRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

async function loadPalletTotalsByWo(workOrders: string[]) {
  const adminClient = createAdminClient();
  const totals = new Map<string, PalletWoTotal>();

  for (let keyOffset = 0; keyOffset < workOrders.length; keyOffset += WO_BATCH_SIZE) {
    const keyBatch = workOrders.slice(keyOffset, keyOffset + WO_BATCH_SIZE);
    for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
      const { data, error } = await adminClient
        .from("pallet_data")
        .select("id,wo,itemcode,quanorder,quantity")
        .is("effect_to", null)
        .in("wo", keyBatch)
        .order("id", { ascending: true })
        .range(offset, offset + DATABASE_BATCH_SIZE - 1);

      if (error) throw new Error(`Không thể đọc tổng số lượng pallet: ${error.message}`);
      const pageRows = (data ?? []) as PalletTotalSourceRow[];
      for (const row of pageRows) {
        const key = comparisonKey(row.wo);
        if (!key) continue;
        const current = totals.get(key) ?? {
          quantity: 0,
          orderQuantity: 0,
          itemcodes: new Set<string>(),
        };
        current.quantity += Number(row.quantity) || 0;
        current.orderQuantity = Math.max(current.orderQuantity, Number(row.quanorder) || 0);
        addCleanValue(current.itemcodes, row.itemcode);
        totals.set(key, current);
      }
      if (pageRows.length < DATABASE_BATCH_SIZE) break;
    }
  }

  return totals;
}

async function loadReportTotalsByWo(workOrders: string[]) {
  const adminClient = createAdminClient();
  const totals = new Map<string, ReportWoTotal>();

  for (let keyOffset = 0; keyOffset < workOrders.length; keyOffset += WO_BATCH_SIZE) {
    const keyBatch = workOrders.slice(keyOffset, keyOffset + WO_BATCH_SIZE);
    for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
      const { data, error } = await adminClient
        .from("shift_report_data")
        .select("id_report,wo,machine,itemcode,product_name,ok_goods")
        .in("wo", keyBatch)
        .order("id_report", { ascending: true })
        .range(offset, offset + DATABASE_BATCH_SIZE - 1);

      if (error) throw new Error(`Không thể đọc tổng số lượng báo ca: ${error.message}`);
      const pageRows = (data ?? []) as ReportTotalSourceRow[];
      for (const row of pageRows) {
        const key = comparisonKey(row.wo);
        if (!key) continue;
        const current = totals.get(key) ?? {
          quantity: 0,
          machines: new Set<string>(),
          itemcodes: new Set<string>(),
          productNames: new Set<string>(),
        };
        current.quantity += Number(row.ok_goods) || 0;
        addCleanValue(current.machines, row.machine);
        addCleanValue(current.itemcodes, row.itemcode);
        addCleanValue(current.productNames, row.product_name);
        totals.set(key, current);
      }
      if (pageRows.length < DATABASE_BATCH_SIZE) break;
    }
  }

  return totals;
}

function createDailyHistoryGroup(date: string): DailyHistoryGroup {
  return {
    date,
    appQuantity: 0,
    palletIds: new Set<string>(),
    erpQuantity: 0,
    warning: false,
  };
}

async function loadActivePalletHistoryByWo(wo: string) {
  const adminClient = createAdminClient();
  const rows: PalletDailyHistorySourceRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("pallet_data")
      .select("id,pallet_id,working_day,quantity,has_been_edited,has_been_return")
      .eq("wo", wo)
      .is("effect_to", null)
      .order("id", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc lịch sử pallet theo WO: ${error.message}`);
    const pageRows = (data ?? []) as PalletDailyHistorySourceRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

async function loadDeletedPalletHistoryByWo(wo: string) {
  const adminClient = createAdminClient();
  const rows: DeletedDailyHistorySourceRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("pallet_data")
      .select("id,working_day")
      .eq("wo", wo)
      .not("effect_to", "is", null)
      .ilike("note", "delete:%")
      .order("id", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc pallet đã xóa theo WO: ${error.message}`);
    const pageRows = (data ?? []) as DeletedDailyHistorySourceRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

async function loadReportHistoryByWo(wo: string) {
  const adminClient = createAdminClient();
  const rows: ReportDailyHistorySourceRow[] = [];

  for (let offset = 0; ; offset += DATABASE_BATCH_SIZE) {
    const { data, error } = await adminClient
      .from("shift_report_data")
      .select("id_report,report_date,ok_goods")
      .eq("wo", wo)
      .order("report_date", { ascending: false })
      .order("id_report", { ascending: true })
      .range(offset, offset + DATABASE_BATCH_SIZE - 1);

    if (error) throw new Error(`Không thể đọc lịch sử báo ca theo WO: ${error.message}`);
    const pageRows = (data ?? []) as ReportDailyHistorySourceRow[];
    rows.push(...pageRows);
    if (pageRows.length < DATABASE_BATCH_SIZE) return rows;
  }
}

async function loadDailyHistoryByWo(wo: string) {
  const [activePallets, deletedPallets, reportRows] = await Promise.all([
    loadActivePalletHistoryByWo(wo),
    loadDeletedPalletHistoryByWo(wo),
    loadReportHistoryByWo(wo),
  ]);
  const groups = new Map<string, DailyHistoryGroup>();

  for (const pallet of activePallets) {
    const date = pallet.working_day;
    const group = groups.get(date) ?? createDailyHistoryGroup(date);
    group.appQuantity += Number(pallet.quantity) || 0;
    if (pallet.pallet_id?.trim()) group.palletIds.add(pallet.pallet_id.trim());
    group.warning ||= Boolean(pallet.has_been_edited || pallet.has_been_return);
    groups.set(date, group);
  }

  for (const pallet of deletedPallets) {
    const date = pallet.working_day;
    const group = groups.get(date) ?? createDailyHistoryGroup(date);
    group.warning = true;
    groups.set(date, group);
  }

  for (const report of reportRows) {
    const date = report.report_date;
    const group = groups.get(date) ?? createDailyHistoryGroup(date);
    group.erpQuantity += Number(report.ok_goods) || 0;
    groups.set(date, group);
  }

  const rows = Array.from(groups.values())
    .map((group) => ({
      date: group.date,
      appQuantity: group.appQuantity,
      palletCount: group.palletIds.size,
      erpQuantity: group.erpQuantity,
      difference: group.appQuantity - group.erpQuantity,
      warning: group.warning,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return NextResponse.json({
    success: true,
    wo,
    rows,
    total: {
      appQuantity: rows.reduce((sum, row) => sum + row.appQuantity, 0),
      palletCount: rows.reduce((sum, row) => sum + row.palletCount, 0),
      erpQuantity: rows.reduce((sum, row) => sum + row.erpQuantity, 0),
      difference: rows.reduce((sum, row) => sum + row.difference, 0),
    },
  });
}

export async function GET(request: Request) {
  const authorization = await authorizePermission("dashboard.view");
  if (!authorization.ok) {
    return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  }

  try {
    const url = new URL(request.url);
    const wo = url.searchParams.get("wo")?.trim() ?? "";
    if (wo) {
      if (wo.length > 120) {
        return NextResponse.json({ success: false, error: "WO không hợp lệ." }, { status: 400 });
      }
      return loadDailyHistoryByWo(wo);
    }

    const reportDate = url.searchParams.get("date")?.trim() ?? "";
    if (!isValidIsoDate(reportDate)) {
      return NextResponse.json({ success: false, error: "Ngày rà soát không hợp lệ." }, { status: 400 });
    }

    const [palletRows, reportRows] = await Promise.all([
      loadPalletComparisonRows(reportDate),
      loadReportComparisonRows(reportDate),
    ]);
    const groups = new Map<string, ComparisonGroup>();

    for (const row of palletRows) {
      const wo = row.wo?.trim() ?? "";
      const key = comparisonKey(wo);
      if (!key) continue;
      const group = groups.get(key) ?? createComparisonGroup(wo);
      group.hasAppData = true;
      group.appQuantity += Number(row.quantity) || 0;
      groups.set(key, group);
    }

    for (const row of reportRows) {
      const wo = row.wo?.trim() ?? "";
      const key = comparisonKey(wo);
      if (!key) continue;
      const group = groups.get(key) ?? createComparisonGroup(wo);
      group.hasErpData = true;
      group.erpQuantity += Number(row.ok_goods) || 0;
      groups.set(key, group);
    }

    const sourceWorkOrders = Array.from(new Set([
      ...palletRows.map((row) => row.wo?.trim() ?? ""),
      ...reportRows.map((row) => row.wo?.trim() ?? ""),
    ].filter(Boolean)));
    const [appTotalsByWo, reportTotalsByWo] = await Promise.all([
      loadPalletTotalsByWo(sourceWorkOrders),
      loadReportTotalsByWo(sourceWorkOrders),
    ]);

    const rows = Array.from(groups.values())
      .map((group) => {
        const key = comparisonKey(group.wo);
        const appTotal = appTotalsByWo.get(key);
        const reportTotal = reportTotalsByWo.get(key);
        const itemcodeMatches = Boolean(
          appTotal
          && reportTotal
          && sameCodeSets(appTotal.itemcodes, reportTotal.itemcodes),
        );
        const quantityMatches = group.hasAppData
          && group.hasErpData
          && group.appQuantity === group.erpQuantity;
        const issues: string[] = [];

        if (!group.hasAppData) issues.push("Thiếu dữ liệu App");
        if (!group.hasErpData) issues.push("Thiếu dữ liệu ERP");
        if (appTotal && reportTotal && !itemcodeMatches) {
          issues.push(
            `Lệch Itemcode (App: ${sortedValues(appTotal.itemcodes).join(" / ") || "—"}; ERP: ${sortedValues(reportTotal.itemcodes).join(" / ") || "—"})`,
          );
        }
        if (group.hasAppData && group.hasErpData && !quantityMatches) issues.push("Lệch số lượng");

        return {
          wo: group.wo,
          machine: reportTotal ? sortedValues(reportTotal.machines).join(" / ") : "",
          itemcode: reportTotal ? sortedValues(reportTotal.itemcodes).join(" / ") : "",
          productName: reportTotal ? sortedValues(reportTotal.productNames).join(" / ") : "",
          orderQuantity: appTotal?.orderQuantity ?? 0,
          appQuantity: group.appQuantity,
          erpQuantity: group.erpQuantity,
          totalAppQuantity: appTotal?.quantity ?? 0,
          totalErpQuantity: reportTotal?.quantity ?? 0,
          difference: group.appQuantity - group.erpQuantity,
          itemcodeMatches,
          quantityMatches,
          result: issues.length ? issues.join("; ") : "Khớp",
          status: issues.length ? "mismatch" : "matched",
        };
      })
      .sort((a, b) => a.wo.localeCompare(b.wo, "vi", { numeric: true }));

    return NextResponse.json({
      success: true,
      reportDate,
      rows,
      summary: {
        total: rows.length,
        matched: rows.filter((row) => row.status === "matched").length,
        mismatched: rows.filter((row) => row.status === "mismatch").length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể rà soát dữ liệu App và ERP.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
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

  // Bỏ dòng tiêu đề. Mapping: A, B, C, D, E, F, I.
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
    const productName = toText(source[4] ?? null);
    const wo = toCode(source[5] ?? null);
    const okGoodsCell = source[8] ?? null;
    const rowHasData = Boolean(idReport || machine || itemcode || productName || wo || toText(okGoodsCell));
    if (!rowHasData) continue;

    if (!currentDate) throw new Error(`Dòng ${excelRow} chưa có ngày báo ca ở cột B.`);
    if (!idReport) throw new Error(`Dòng ${excelRow} thiếu ID report ở cột A.`);
    if (!machine) throw new Error(`Dòng ${excelRow} thiếu Machine ở cột C.`);
    if (!itemcode) throw new Error(`Dòng ${excelRow} thiếu Itemcode ở cột D.`);
    if (!productName) throw new Error(`Dòng ${excelRow} thiếu Product Name ở cột E.`);
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
      product_name: productName,
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
      .select("id_report,report_date,machine,itemcode,product_name,wo,ok_goods")
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
    const unchangedRows: ShiftReportRow[] = [];
    const conflictRows = new Map<string, ShiftReportRow>();
    const conflicts: AuditConflict[] = [];

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
        unchangedRows.push(row);
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
        unchanged: unchangedRows.length,
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
    // Các dòng không đổi OK goods vẫn được upsert để bổ sung/cập nhật dữ liệu phụ ERP,
    // đặc biệt là Product Name được thêm sau khi bảng báo ca đã có dữ liệu.
    await writeRows([...missingRows, ...unchangedRows, ...updatedRows], false);

    return NextResponse.json({
      success: true,
      mode,
      phase,
      fileName: parsed.fileName,
      parsed: parsed.rows.length,
      imported: missingRows.length,
      updated: updatedRows.length,
      skipped: unchangedRows.length + conflicts.length - updatedRows.length,
      conflicts: conflicts.length,
      firstDate: parsed.firstDate,
      lastDate: parsed.lastDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không thể xử lý file báo ca.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
