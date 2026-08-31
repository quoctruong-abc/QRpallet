import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FifoFilterForm } from "./fifo-filter-form";
import { FifoProgressButton } from "./fifo-progress-button";

type SearchParams = Record<string, string | string[] | undefined>;

type FifoRow = {
  id: number;
  pallet_id: string;
  wo: string | null;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  status: string;
  working_day: string;
  scanned_at: string | null;
};

type PeriodMode = "day" | "range" | "all";

const FIFO_PAGE_SIZE = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readParams(value: string | string[] | undefined) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readPage(value: string | string[] | undefined) {
  const parsed = Number.parseInt(readParam(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isValidDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getDateInVietnam(shiftHours = 0) {
  const source = new Date(Date.now() + shiftHours * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(source);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getCurrentWorkingDay() {
  return getDateInVietnam(-6);
}

function getVietnamToday() {
  return getDateInVietnam();
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = value.includes("T") ? new Date(value) : new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
}

function dateToUtcMilliseconds(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Date.UTC(year, month - 1, day);
}

function calculateDelayDays(workingDay: string, today: string) {
  const start = dateToUtcMilliseconds(workingDay);
  const end = dateToUtcMilliseconds(today);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

function stageLabel(status: string) {
  return status.toLowerCase() === "production" ? "Chờ Scan" : "Chờ nhập kho";
}

export default async function CheckFifoPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requirePermission("dashboard.view");
  const params = await searchParams;
  const currentWorkingDay = getCurrentWorkingDay();
  const vietnamToday = getVietnamToday();
  const submitted = readParam(params.filter_applied) === "1";

  const requestedPeriod = readParam(params.period);
  const period: PeriodMode = requestedPeriod === "all" || requestedPeriod === "range" ? requestedPeriod : "day";

  const requestedDay = readParam(params.day);
  const requestedFrom = readParam(params.from);
  const requestedTo = readParam(params.to);
  const day = isValidDate(requestedDay) ? requestedDay : currentWorkingDay;
  let from = isValidDate(requestedFrom) ? requestedFrom : currentWorkingDay;
  let to = isValidDate(requestedTo) ? requestedTo : currentWorkingDay;
  if (from > to) [from, to] = [to, from];

  const selectedStages = submitted ? readParams(params.stage) : ["production", "scan"];
  const includeProduction = selectedStages.includes("production");
  const includeScan = selectedStages.includes("scan");

  const statuses: string[] = [];
  if (includeProduction) statuses.push("production");
  if (includeScan) statuses.push("pendingWH", "processingWH");

  const page = readPage(params.page);
  const offset = (page - 1) * FIFO_PAGE_SIZE;
  const rows: FifoRow[] = [];
  let hasNextPage = false;
  let queryError = "";

  if (statuses.length > 0) {
    const supabase = await createClient();
    let query = supabase
      .from("pallet_data")
      .select("id,pallet_id,wo,itemcode,product_name,customer,status,working_day,scanned_at")
      .is("effect_to", null)
      .in("status", statuses)
      .order("working_day", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + FIFO_PAGE_SIZE);

    if (period === "day") {
      query = query.eq("working_day", day);
    } else if (period === "range") {
      query = query.gte("working_day", from).lte("working_day", to);
    }

    const { data, error } = await query;
    if (error) {
      queryError = error.message;
    } else {
      const pageRows = (data ?? []) as FifoRow[];
      hasNextPage = pageRows.length > FIFO_PAGE_SIZE;
      rows.push(...pageRows.slice(0, FIFO_PAGE_SIZE));
    }
  }

  const productionCount = rows.filter((row) => row.status.toLowerCase() === "production").length;
  const scanCount = rows.length - productionCount;

  const fifoPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    query.set("filter_applied", "1");
    query.set("period", period);
    if (period === "day") query.set("day", day);
    if (period === "range") {
      query.set("from", from);
      query.set("to", to);
    }
    if (includeProduction) query.append("stage", "production");
    if (includeScan) query.append("stage", "scan");
    if (targetPage > 1) query.set("page", String(targetPage));
    return `/production-dashboard/check-fifo?${query.toString()}`;
  };

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .fifo-page { display: grid; gap: 22px; }
        .dashboard-view-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-view-tab { min-width: 140px; padding: 10px 16px; border-radius: 9px; color: #475467; font-weight: 850; text-align: center; }
        .dashboard-view-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .fifo-filter-panel { display: grid; gap: 16px; }
        .fifo-period-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .fifo-period-option { display: grid; gap: 9px; padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
        .fifo-period-option > span { display: flex; align-items: center; gap: 8px; font-weight: 850; }
        .fifo-period-option input[type="radio"], .fifo-stage-option input[type="checkbox"] { width: 18px; height: 18px; margin: 0; }
        .fifo-range-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .fifo-stage-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding-top: 2px; }
        .fifo-stage-option { display: inline-flex; align-items: center; gap: 8px; padding: 9px 13px; border: 1px solid var(--border); border-radius: 999px; background: #fff; font-weight: 800; }
        .fifo-process-guard { margin: 10px 0 0; }
        .fifo-filter-actions { display: flex; justify-content: flex-end; }
        .fifo-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .fifo-table-panel { overflow: hidden; }
        .fifo-table-panel .table-wrap { overflow-x: auto; }
        .fifo-table { width: 100%; min-width: 1200px; }
        .fifo-table th, .fifo-table td { padding: 11px 10px; vertical-align: top; }
        .fifo-pallet-cell { display: grid; gap: 6px; }
        .fifo-stage-badge { display: inline-flex; width: fit-content; padding: 4px 8px; border-radius: 999px; font-size: .7rem; font-weight: 900; }
        .fifo-stage-production { color: #175cd3; background: #eff8ff; }
        .fifo-stage-scan { color: #854a0e; background: #fffaeb; }
        .fifo-date-cell { white-space: nowrap; }
        .fifo-delay { white-space: nowrap; font-weight: 900; }
        .fifo-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 16px; }
        .fifo-pagination-actions { display: flex; gap: 8px; }
        .fifo-empty { padding: 38px 18px; color: var(--muted); text-align: center; }
        @media (max-width: 820px) {
          .fifo-period-options { grid-template-columns: 1fr; }
          .fifo-summary { grid-template-columns: 1fr; }
        }
        @media (max-width: 640px) {
          .dashboard-view-tabs { width: 100%; }
          .dashboard-view-tab { min-width: 0; flex: 1; }
          .fifo-range-inputs { grid-template-columns: 1fr; }
          .fifo-filter-actions .button { width: 100%; }
          .fifo-pagination { align-items: stretch; flex-direction: column; }
          .fifo-pagination-actions { width: 100%; }
          .fifo-pagination-actions .button { flex: 1; }
        }
      `}</style>

      <div className="fifo-page">
        <div className="hero-row">
          <div>
            <h1>Dashboard sản xuất</h1>
            <p className="muted">Theo dõi tiến độ và kiểm tra pallet tồn lâu giữa các process.</p>
          </div>
        </div>

        <div className="dashboard-view-tabs" aria-label="Dashboard tabs">
          <Link className="dashboard-view-tab" href="/production-dashboard" prefetch={false}>Dashboard</Link>
          <Link className="dashboard-view-tab dashboard-view-tab-active" href="/production-dashboard/check-fifo" prefetch={false}>Check FIFO</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-item" prefetch={false}>Check item</Link>
        </div>

        <FifoFilterForm
          day={day}
          from={from}
          includeProduction={includeProduction}
          includeScan={includeScan}
          pageSize={FIFO_PAGE_SIZE}
          period={period}
          to={to}
        />

        {queryError ? <section className="alert alert-error">Không thể tải FIFO: {queryError}</section> : null}
        {!includeProduction && !includeScan ? <section className="alert alert-error">Không có process được chọn. Query FIFO đã bị chặn.</section> : null}

        <div className="fifo-summary">
          <div className="stat-card"><span className="muted small">Pallet đang hiển thị</span><span className="stat-number">{rows.length.toLocaleString("vi-VN")}</span></div>
          <div className="stat-card"><span className="muted small">Chờ Scan trên trang</span><span className="stat-number">{productionCount.toLocaleString("vi-VN")}</span></div>
          <div className="stat-card"><span className="muted small">Chờ nhập kho trên trang</span><span className="stat-number">{scanCount.toLocaleString("vi-VN")}</span></div>
        </div>

        <section className="panel fifo-table-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">FIFO · CŨ NHẤT TRƯỚC</p>
              <h2>Pallet chưa đi tới process tiếp theo</h2>
              <p className="muted small">Sắp xếp theo ngày sản xuất tăng dần; mỗi lần chỉ tải tối đa {FIFO_PAGE_SIZE} pallet để tránh query lớn.</p>
            </div>
          </div>

          <div className="table-wrap">
            <table className="fifo-table">
              <thead>
                <tr>
                  <th>Pallet ID</th>
                  <th>Ngày sản xuất</th>
                  <th>Số ngày delay</th>
                  <th>Ngày scan</th>
                  <th>Item</th>
                  <th>Khách hàng</th>
                  <th>Tên sản phẩm</th>
                  <th>Tiến độ</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((row) => {
                  const isProduction = row.status.toLowerCase() === "production";
                  const delayDays = calculateDelayDays(row.working_day, vietnamToday);
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="fifo-pallet-cell">
                          <strong>{row.pallet_id}</strong>
                          <span className={`fifo-stage-badge ${isProduction ? "fifo-stage-production" : "fifo-stage-scan"}`}>
                            {stageLabel(row.status)}
                          </span>
                        </div>
                      </td>
                      <td className="fifo-date-cell">{formatDate(row.working_day)}</td>
                      <td className="fifo-delay">{delayDays.toLocaleString("vi-VN")} ngày</td>
                      <td className="fifo-date-cell">{formatDateTime(row.scanned_at)}</td>
                      <td>{row.itemcode ?? "—"}</td>
                      <td>{row.customer ?? "—"}</td>
                      <td>{row.product_name ?? "—"}</td>
                      <td>
                        <FifoProgressButton
                          day={day}
                          from={from}
                          itemcode={row.itemcode}
                          palletId={row.pallet_id}
                          period={period}
                          to={to}
                          wo={row.wo}
                        />
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td className="fifo-empty" colSpan={8}>Không có pallet phù hợp với điều kiện FIFO đã chọn.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {(page > 1 || hasNextPage) ? (
            <div className="fifo-pagination">
              <span className="muted small">Trang {page} · tối đa {FIFO_PAGE_SIZE} pallet/trang</span>
              <div className="fifo-pagination-actions">
                {page > 1 ? <Link className="button button-secondary" href={fifoPageHref(page - 1)} prefetch={false}>Trang trước</Link> : null}
                {hasNextPage ? <Link className="button button-primary" href={fifoPageHref(page + 1)} prefetch={false}>Trang sau</Link> : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </PageShell>
  );
}
