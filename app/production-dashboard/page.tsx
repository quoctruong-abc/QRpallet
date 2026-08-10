import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  DashboardTableClient,
  type DashboardMode,
  type DashboardSummaryRow,
} from "./dashboard-table-client";

type SearchParams = Record<string, string | string[] | undefined>;

type PalletDashboardRow = {
  id: number;
  pallet_id: string;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | null;
  quantity: number | null;
  status: string | null;
  has_been_edited: boolean | null;
  has_been_return: boolean | null;
  working_day: string;
  is_deleted: boolean;
};

type DashboardTotals = {
  orderQuantity: number;
  palletCount: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
};

type DashboardSummaryRpcRow = {
  order_quantity: number | string | null;
  pallet_count: number | string | null;
  produced_quantity: number | string | null;
  scanned_quantity: number | string | null;
  warehouse_quantity: number | string | null;
};

const DASHBOARD_WINDOW_DAYS = 7;
const QUERY_BATCH_SIZE = 1000;

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isValidDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getCurrentWorkingDay() {
  const shifted = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDateLabel(value: string) {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysInclusive(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function summarizeValues(values: Set<string>) {
  const cleaned = Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b, "vi"));
  if (!cleaned.length) return "—";
  if (cleaned.length === 1) return cleaned[0];
  return `${cleaned[0]} (+${cleaned.length - 1})`;
}

function aggregateByWo(rows: PalletDashboardRow[]): DashboardSummaryRow[] {
  const groups = new Map<
    string,
    {
      itemcodes: Set<string>;
      productNames: Set<string>;
      customers: Set<string>;
      palletIds: Set<string>;
      orderQuantity: number;
      producedQuantity: number;
      scannedQuantity: number;
      warehouseQuantity: number;
      warning: boolean;
    }
  >();

  for (const row of rows) {
    const wo = row.wo?.trim();
    if (!wo) continue;

    const current = groups.get(wo) ?? {
      itemcodes: new Set<string>(),
      productNames: new Set<string>(),
      customers: new Set<string>(),
      palletIds: new Set<string>(),
      orderQuantity: 0,
      producedQuantity: 0,
      scannedQuantity: 0,
      warehouseQuantity: 0,
      warning: false,
    };

    if (row.itemcode?.trim()) current.itemcodes.add(row.itemcode.trim());
    if (row.product_name?.trim()) current.productNames.add(row.product_name.trim());
    if (row.customer?.trim()) current.customers.add(row.customer.trim());
    if (!row.is_deleted && row.pallet_id?.trim()) current.palletIds.add(row.pallet_id.trim());

    const quantity = Number(row.quantity) || 0;
    const orderQuantity = Number(row.quanorder) || 0;
    const status = (row.status ?? "").toLowerCase();

    current.orderQuantity = Math.max(current.orderQuantity, orderQuantity);
    if (!row.is_deleted) {
      current.producedQuantity += quantity;
      if (status !== "production") current.scannedQuantity += quantity;
      if (status === "whdone") current.warehouseQuantity += quantity;
    }
    current.warning ||= Boolean(row.has_been_edited || row.has_been_return || row.is_deleted);

    groups.set(wo, current);
  }

  return Array.from(groups.entries())
    .map(([wo, group]) => ({
      key: wo,
      label: wo,
      itemcode: summarizeValues(group.itemcodes),
      productName: summarizeValues(group.productNames),
      customer: summarizeValues(group.customers),
      orderQuantity: group.orderQuantity,
      palletCount: group.palletIds.size,
      producedQuantity: group.producedQuantity,
      scannedQuantity: group.scannedQuantity,
      warehouseQuantity: group.warehouseQuantity,
      warning: group.warning,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi", { numeric: true }));
}

function aggregateByItem(rows: PalletDashboardRow[]): DashboardSummaryRow[] {
  const groups = new Map<
    string,
    {
      productNames: Set<string>;
      customers: Set<string>;
      palletIds: Set<string>;
      orderByWo: Map<string, number>;
      producedQuantity: number;
      scannedQuantity: number;
      warehouseQuantity: number;
      warning: boolean;
    }
  >();

  for (const row of rows) {
    const itemcode = row.itemcode?.trim();
    if (!itemcode) continue;

    const current = groups.get(itemcode) ?? {
      productNames: new Set<string>(),
      customers: new Set<string>(),
      palletIds: new Set<string>(),
      orderByWo: new Map<string, number>(),
      producedQuantity: 0,
      scannedQuantity: 0,
      warehouseQuantity: 0,
      warning: false,
    };

    if (row.product_name?.trim()) current.productNames.add(row.product_name.trim());
    if (row.customer?.trim()) current.customers.add(row.customer.trim());
    if (!row.is_deleted && row.pallet_id?.trim()) current.palletIds.add(row.pallet_id.trim());

    const wo = row.wo?.trim();
    const orderQuantity = Number(row.quanorder) || 0;
    if (wo) {
      current.orderByWo.set(wo, Math.max(current.orderByWo.get(wo) ?? 0, orderQuantity));
    }

    const quantity = Number(row.quantity) || 0;
    const status = (row.status ?? "").toLowerCase();

    if (!row.is_deleted) {
      current.producedQuantity += quantity;
      if (status !== "production") current.scannedQuantity += quantity;
      if (status === "whdone") current.warehouseQuantity += quantity;
    }
    current.warning ||= Boolean(row.has_been_edited || row.has_been_return || row.is_deleted);

    groups.set(itemcode, current);
  }

  return Array.from(groups.entries())
    .map(([itemcode, group]) => ({
      key: itemcode,
      label: itemcode,
      itemcode,
      productName: summarizeValues(group.productNames),
      customer: summarizeValues(group.customers),
      orderQuantity: Array.from(group.orderByWo.values()).reduce((sum, value) => sum + value, 0),
      palletCount: group.palletIds.size,
      producedQuantity: group.producedQuantity,
      scannedQuantity: group.scannedQuantity,
      warehouseQuantity: group.warehouseQuantity,
      warning: group.warning,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi", { numeric: true }));
}

function getTotals(rows: DashboardSummaryRow[]): DashboardTotals {
  return rows.reduce(
    (total, row) => ({
      orderQuantity: total.orderQuantity + row.orderQuantity,
      palletCount: total.palletCount + row.palletCount,
      producedQuantity: total.producedQuantity + row.producedQuantity,
      scannedQuantity: total.scannedQuantity + row.scannedQuantity,
      warehouseQuantity: total.warehouseQuantity + row.warehouseQuantity,
    }),
    {
      orderQuantity: 0,
      palletCount: 0,
      producedQuantity: 0,
      scannedQuantity: 0,
      warehouseQuantity: 0,
    },
  );
}

function normalizeRangeSummary(row: DashboardSummaryRpcRow | undefined): DashboardTotals {
  return {
    orderQuantity: Number(row?.order_quantity) || 0,
    palletCount: Number(row?.pallet_count) || 0,
    producedQuantity: Number(row?.produced_quantity) || 0,
    scannedQuantity: Number(row?.scanned_quantity) || 0,
    warehouseQuantity: Number(row?.warehouse_quantity) || 0,
  };
}

export default async function ProductionDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requirePermission("dashboard.view");
  const params = await searchParams;
  const currentWorkingDay = getCurrentWorkingDay();

  const selectedDay = readParam(params.day);
  const requestedFrom = readParam(params.from);
  const requestedTo = readParam(params.to);
  const requestedPage = Number.parseInt(readParam(params.page), 10);
  const mode: DashboardMode = readParam(params.mode) === "item" ? "item" : "wo";

  let startDate = currentWorkingDay;
  let endDate = currentWorkingDay;
  let filterType: "day" | "range" = "day";

  if (isValidDate(selectedDay)) {
    startDate = selectedDay;
    endDate = selectedDay;
  } else if (isValidDate(requestedFrom) || isValidDate(requestedTo)) {
    filterType = "range";
    startDate = isValidDate(requestedFrom) ? requestedFrom : requestedTo;
    endDate = isValidDate(requestedTo) ? requestedTo : requestedFrom;
    if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
  }

  const totalDays = Math.max(1, daysInclusive(startDate, endDate));
  const totalPages = Math.max(1, Math.ceil(totalDays / DASHBOARD_WINDOW_DAYS));
  const currentPage = Number.isFinite(requestedPage)
    ? Math.min(Math.max(requestedPage, 1), totalPages)
    : 1;
  const pageStartDate = addDays(startDate, (currentPage - 1) * DASHBOARD_WINDOW_DAYS);
  const candidatePageEnd = addDays(pageStartDate, DASHBOARD_WINDOW_DAYS - 1);
  const pageEndDate = candidatePageEnd < endDate ? candidatePageEnd : endDate;

  const supabase = await createClient();
  const palletRows: PalletDashboardRow[] = [];
  let queryError = "";
  let summaryError = "";
  const dashboardFields =
    "id,pallet_id,itemcode,product_name,customer,wo,quanorder,quantity,status,has_been_edited,has_been_return,working_day";

  const { data: summaryData, error: summaryRpcError } = await supabase.rpc("dashboard_summary", {
    p_from: startDate,
    p_to: endDate,
  });

  if (summaryRpcError) summaryError = summaryRpcError.message;
  const rangeSummary = normalizeRangeSummary(
    ((summaryData ?? []) as DashboardSummaryRpcRow[])[0],
  );

  for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("pallet_data")
      .select(dashboardFields)
      .is("effect_to", null)
      .gte("working_day", pageStartDate)
      .lte("working_day", pageEndDate)
      .order("id", { ascending: true })
      .range(offset, offset + QUERY_BATCH_SIZE - 1);

    if (error) {
      queryError = error.message;
      break;
    }

    const pageRows = (data ?? []) as Omit<PalletDashboardRow, "is_deleted">[];
    palletRows.push(...pageRows.map((row) => ({ ...row, is_deleted: false })));
    if (pageRows.length < QUERY_BATCH_SIZE) break;
  }

  // Deleted pallets have no active version (effect_to is no longer null), so
  // load only terminal delete versions for the seven-day table window instead
  // of all historical versions. They remain visible for audit/warning but are
  // excluded from pallet/production/scan/warehouse KPIs.
  if (!queryError) {
    for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
      const { data, error } = await supabase
        .from("pallet_data")
        .select(dashboardFields)
        .not("effect_to", "is", null)
        .ilike("note", "delete:%")
        .gte("working_day", pageStartDate)
        .lte("working_day", pageEndDate)
        .order("id", { ascending: true })
        .range(offset, offset + QUERY_BATCH_SIZE - 1);

      if (error) {
        queryError = error.message;
        break;
      }

      const pageRows = (data ?? []) as Omit<PalletDashboardRow, "is_deleted">[];
      palletRows.push(...pageRows.map((row) => ({ ...row, is_deleted: true })));
      if (pageRows.length < QUERY_BATCH_SIZE) break;
    }
  }

  const woRows = aggregateByWo(palletRows);
  const itemRows = aggregateByItem(palletRows);
  const visibleRows = mode === "item" ? itemRows : woRows;
  const pageTotals = getTotals(visibleRows);

  const filterParams = new URLSearchParams();
  if (filterType === "day") filterParams.set("day", startDate);
  else {
    filterParams.set("from", startDate);
    filterParams.set("to", endDate);
  }

  const woParams = new URLSearchParams(filterParams);
  woParams.set("mode", "wo");
  if (currentPage > 1) woParams.set("page", String(currentPage));

  const itemParams = new URLSearchParams(filterParams);
  itemParams.set("mode", "item");
  if (currentPage > 1) itemParams.set("page", String(currentPage));

  const pageHref = (page: number) => {
    const paginationParams = new URLSearchParams(filterParams);
    paginationParams.set("mode", mode);
    if (page > 1) paginationParams.set("page", String(page));
    return `/production-dashboard?${paginationParams.toString()}`;
  };

  const rangePeriodLabel =
    startDate === endDate
      ? `Ngày làm việc ${formatDateLabel(startDate)}`
      : `Từ ${formatDateLabel(startDate)} đến ${formatDateLabel(endDate)}`;
  const pagePeriodLabel =
    pageStartDate === pageEndDate
      ? `Ngày làm việc ${formatDateLabel(pageStartDate)}`
      : `${formatDateLabel(pageStartDate)} → ${formatDateLabel(pageEndDate)}`;

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .dashboard-page { display: grid; gap: 22px; }
        .dashboard-view-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-view-tab { min-width: 140px; padding: 10px 16px; border-radius: 9px; color: #475467; font-weight: 850; text-align: center; }
        .dashboard-view-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .dashboard-filter-grid { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(420px, 1.4fr); gap: 14px; }
        .dashboard-filter-card { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; padding: 16px; border: 1px solid var(--border); border-radius: 16px; background: white; }
        .dashboard-filter-card label { min-width: 180px; flex: 1 1 180px; }
        .dashboard-filter-card .button { flex: 0 0 auto; }
        .dashboard-tabs { display: inline-flex; gap: 6px; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-tab { min-width: 120px; padding: 9px 14px; border-radius: 9px; color: #475467; font-weight: 800; text-align: center; }
        .dashboard-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .dashboard-summary-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .dashboard-summary-heading p { margin: 0; }
        .dashboard-summary-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
        .dashboard-summary-grid .stat-card { min-width: 0; }
        .dashboard-table-header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 16px; }
        .dashboard-table-header p { margin-bottom: 0; }
        .dashboard-pagination { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 18px; flex-wrap: wrap; }
        .dashboard-pagination-status { min-width: 220px; text-align: center; color: #475467; font-weight: 750; }
        .dashboard-pagination .button[aria-disabled="true"] { pointer-events: none; opacity: .45; }

        .dashboard-table-panel { width: 100%; max-width: 100%; overflow: hidden; }
        .dashboard-table-panel .table-wrap { width: 100%; max-width: 100%; overflow-x: auto; }
        .dashboard-table-panel .dashboard-table {
          width: 100%;
          min-width: 1080px;
          margin: 0 auto;
        }
        .dashboard-table-panel .dashboard-table th,
        .dashboard-table-panel .dashboard-table td {
          padding: 10px 8px;
        }
        .dashboard-table-panel .quantity-progress {
          width: 108px;
          min-width: 108px;
          gap: 3px;
        }
        .dashboard-table-panel .quantity-progress-label strong { font-size: .78rem; }
        .dashboard-table-panel .quantity-progress-label span,
        .dashboard-table-panel .quantity-progress small { font-size: .64rem; }
        .dashboard-table-panel .quantity-progress-track { height: 6px; }
        .dashboard-table-panel .dashboard-detail-button {
          width: 36px;
          min-width: 36px;
          height: 36px;
          min-height: 36px;
          padding: 0;
          border-radius: 50%;
          font-size: 0;
        }
        .dashboard-table-panel .dashboard-detail-button::before {
          content: "👁";
          font-size: 1rem;
          line-height: 1;
        }

        @media (max-width: 1050px) {
          .dashboard-summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }
        @media (max-width: 900px) {
          .dashboard-filter-grid { grid-template-columns: 1fr; }
          .dashboard-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 640px) {
          .dashboard-view-tabs, .dashboard-tabs { width: 100%; }
          .dashboard-view-tab, .dashboard-tab { flex: 1; min-width: 0; }
          .dashboard-filter-card { display: grid; }
          .dashboard-filter-card label, .dashboard-filter-card .button { width: 100%; }
          .dashboard-summary-grid { grid-template-columns: 1fr; }
          .dashboard-summary-heading, .dashboard-table-header { align-items: stretch; flex-direction: column; }
          .dashboard-pagination { display: grid; grid-template-columns: 1fr 1fr; }
          .dashboard-pagination-status { grid-column: 1 / -1; grid-row: 1; min-width: 0; }
        }
      `}</style>

      <div className="dashboard-page">
        <div className="hero-row">
          <div>
            <h1>Dashboard sản xuất</h1>
            <p className="muted">Theo dõi tiến độ tạo pallet, scan và nhập kho theo ngày làm việc.</p>
          </div>
        </div>

        <div className="dashboard-view-tabs" aria-label="Dashboard tabs">
          <Link className="dashboard-view-tab dashboard-view-tab-active" href="/production-dashboard">Dashboard</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-fifo">Check FIFO</Link>
        </div>

        <div className="dashboard-filter-grid">
          <form action="/production-dashboard" className="dashboard-filter-card" method="get">
            <input name="mode" type="hidden" value={mode} />
            <label>
              Tìm theo ngày
              <input defaultValue={filterType === "day" ? startDate : ""} name="day" type="date" />
            </label>
            <button className="button button-primary" type="submit">Xem ngày</button>
          </form>

          <form action="/production-dashboard" className="dashboard-filter-card" method="get">
            <input name="mode" type="hidden" value={mode} />
            <label>
              Từ ngày
              <input defaultValue={startDate} name="from" type="date" />
            </label>
            <label>
              Đến ngày
              <input defaultValue={endDate} name="to" type="date" />
            </label>
            <button className="button button-primary" type="submit">Xem khoảng ngày</button>
          </form>
        </div>

        {summaryError ? (
          <section className="alert alert-error">Không thể tải summary toàn khoảng: {summaryError}</section>
        ) : null}
        {queryError ? (
          <section className="alert alert-error">Không thể tải dữ liệu bảng dashboard: {queryError}</section>
        ) : null}

        <div className="dashboard-summary-heading">
          <div>
            <p className="eyebrow">TỔNG TOÀN KHOẢNG</p>
            <p className="muted small">{rangePeriodLabel} · Summary không đổi khi chuyển trang</p>
          </div>
        </div>

        <div className="dashboard-summary-grid">
          <div className="stat-card">
            <span className="muted small">Quan order</span>
            <span className="stat-number">{summaryError ? "—" : formatNumber(rangeSummary.orderQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Pallet đã tạo</span>
            <span className="stat-number">{summaryError ? "—" : formatNumber(rangeSummary.palletCount)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã sản xuất</span>
            <span className="stat-number">{summaryError ? "—" : formatNumber(rangeSummary.producedQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã scan</span>
            <span className="stat-number">{summaryError ? "—" : formatNumber(rangeSummary.scannedQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã nhập kho</span>
            <span className="stat-number">{summaryError ? "—" : formatNumber(rangeSummary.warehouseQuantity)}</span>
          </div>
        </div>

        <section className="panel dashboard-table-panel">
          <div className="dashboard-table-header">
            <div>
              <p className="eyebrow">7 NGÀY / TRANG · {pagePeriodLabel}</p>
              <h2>{mode === "wo" ? "Tổng hợp theo WO" : "Tổng hợp theo Item"}</h2>
              <p className="muted small">
                {visibleRows.length} dòng dữ liệu tổng hợp · TOTAL trong bảng chỉ tính khoảng đang hiển thị
              </p>
            </div>

            <div className="dashboard-tabs" aria-label="Chế độ xem">
              <Link
                className={`dashboard-tab ${mode === "wo" ? "dashboard-tab-active" : ""}`}
                href={`/production-dashboard?${woParams.toString()}`}
              >
                Theo WO
              </Link>
              <Link
                className={`dashboard-tab ${mode === "item" ? "dashboard-tab-active" : ""}`}
                href={`/production-dashboard?${itemParams.toString()}`}
              >
                Theo Item
              </Link>
            </div>
          </div>

          <DashboardTableClient
            endDate={pageEndDate}
            mode={mode}
            rows={visibleRows}
            startDate={pageStartDate}
            totals={pageTotals}
          />

          {totalPages > 1 ? (
            <nav className="dashboard-pagination" aria-label="Phân trang dashboard theo 7 ngày">
              {currentPage > 1 ? (
                <Link
                  className="button button-secondary"
                  href={pageHref(currentPage - 1)}
                  prefetch={false}
                >
                  ← 7 ngày trước
                </Link>
              ) : (
                <span aria-disabled="true" className="button button-secondary">← 7 ngày trước</span>
              )}

              <span className="dashboard-pagination-status">
                Trang {currentPage}/{totalPages} · {pagePeriodLabel}
              </span>

              {currentPage < totalPages ? (
                <Link
                  className="button button-secondary"
                  href={pageHref(currentPage + 1)}
                  prefetch={false}
                >
                  7 ngày tiếp →
                </Link>
              ) : (
                <span aria-disabled="true" className="button button-secondary">7 ngày tiếp →</span>
              )}
            </nav>
          ) : null}
        </section>
      </div>
    </PageShell>
  );
}
