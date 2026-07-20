import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type SearchParams = Record<string, string | string[] | undefined>;

type PalletDashboardRow = {
  id: number;
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
};

type DashboardSummary = {
  key: string;
  label: string;
  itemcode: string;
  productName: string;
  customer: string;
  orderQuantity: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
  warning: boolean;
};

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
  return new Date(`${value}T00:00:00+07:00`).toLocaleDateString("vi-VN");
}

function summarizeValues(values: Set<string>) {
  const cleaned = Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b, "vi"));
  if (!cleaned.length) return "—";
  if (cleaned.length === 1) return cleaned[0];
  return `${cleaned[0]} (+${cleaned.length - 1})`;
}

function QuantityProgress({ value, total }: { value: number; total: number }) {
  const validTotal = total > 0;
  const percent = validTotal ? (value / total) * 100 : 0;

  return (
    <div className="quantity-progress">
      <div className="quantity-progress-label">
        <strong>{formatNumber(value)}</strong>
        <span>/ {validTotal ? formatNumber(total) : "—"}</span>
      </div>
      <div className="quantity-progress-track">
        <span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} />
      </div>
      <small>{validTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small>
    </div>
  );
}

function WarningMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      aria-label="Có pallet đã chỉnh sửa hoặc đã trả lại"
      className="dashboard-warning-mark"
      title="Có pallet đã chỉnh sửa hoặc đã trả lại"
    >
      !
    </span>
  );
}

function aggregateByWo(rows: PalletDashboardRow[]): DashboardSummary[] {
  const groups = new Map<
    string,
    {
      itemcodes: Set<string>;
      productNames: Set<string>;
      customers: Set<string>;
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
      orderQuantity: 0,
      producedQuantity: 0,
      scannedQuantity: 0,
      warehouseQuantity: 0,
      warning: false,
    };

    if (row.itemcode?.trim()) current.itemcodes.add(row.itemcode.trim());
    if (row.product_name?.trim()) current.productNames.add(row.product_name.trim());
    if (row.customer?.trim()) current.customers.add(row.customer.trim());

    const quantity = Number(row.quantity) || 0;
    const orderQuantity = Number(row.quanorder) || 0;
    const status = (row.status ?? "").toLowerCase();

    current.orderQuantity = Math.max(current.orderQuantity, orderQuantity);
    current.producedQuantity += quantity;
    if (status !== "production") current.scannedQuantity += quantity;
    if (status === "whdone") current.warehouseQuantity += quantity;
    current.warning ||= Boolean(row.has_been_edited || row.has_been_return);

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
      producedQuantity: group.producedQuantity,
      scannedQuantity: group.scannedQuantity,
      warehouseQuantity: group.warehouseQuantity,
      warning: group.warning,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi", { numeric: true }));
}

function aggregateByItem(rows: PalletDashboardRow[]): DashboardSummary[] {
  const groups = new Map<
    string,
    {
      productNames: Set<string>;
      customers: Set<string>;
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
      orderByWo: new Map<string, number>(),
      producedQuantity: 0,
      scannedQuantity: 0,
      warehouseQuantity: 0,
      warning: false,
    };

    if (row.product_name?.trim()) current.productNames.add(row.product_name.trim());
    if (row.customer?.trim()) current.customers.add(row.customer.trim());

    const wo = row.wo?.trim();
    const orderQuantity = Number(row.quanorder) || 0;
    if (wo) {
      current.orderByWo.set(wo, Math.max(current.orderByWo.get(wo) ?? 0, orderQuantity));
    }

    const quantity = Number(row.quantity) || 0;
    const status = (row.status ?? "").toLowerCase();

    current.producedQuantity += quantity;
    if (status !== "production") current.scannedQuantity += quantity;
    if (status === "whdone") current.warehouseQuantity += quantity;
    current.warning ||= Boolean(row.has_been_edited || row.has_been_return);

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
      producedQuantity: group.producedQuantity,
      scannedQuantity: group.scannedQuantity,
      warehouseQuantity: group.warehouseQuantity,
      warning: group.warning,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "vi", { numeric: true }));
}

function getTotals(rows: DashboardSummary[]) {
  return rows.reduce(
    (total, row) => ({
      orderQuantity: total.orderQuantity + row.orderQuantity,
      producedQuantity: total.producedQuantity + row.producedQuantity,
      scannedQuantity: total.scannedQuantity + row.scannedQuantity,
      warehouseQuantity: total.warehouseQuantity + row.warehouseQuantity,
    }),
    { orderQuantity: 0, producedQuantity: 0, scannedQuantity: 0, warehouseQuantity: 0 },
  );
}

export default async function ProductionDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requireAdmin();
  const params = await searchParams;
  const currentWorkingDay = getCurrentWorkingDay();

  const selectedDay = readParam(params.day);
  const requestedFrom = readParam(params.from);
  const requestedTo = readParam(params.to);
  const mode = readParam(params.mode) === "item" ? "item" : "wo";

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

  const supabase = await createClient();
  const palletRows: PalletDashboardRow[] = [];
  const pageSize = 1000;
  let queryError = "";

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("pallet_data")
      .select(
        "id,itemcode,product_name,customer,wo,quanorder,quantity,status,has_been_edited,has_been_return,working_day",
      )
      .is("effect_to", null)
      .gte("working_day", startDate)
      .lte("working_day", endDate)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      queryError = error.message;
      break;
    }

    const pageRows = (data ?? []) as PalletDashboardRow[];
    palletRows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  const woRows = aggregateByWo(palletRows);
  const itemRows = aggregateByItem(palletRows);
  const visibleRows = mode === "item" ? itemRows : woRows;
  const totals = getTotals(visibleRows);

  const modeParams = new URLSearchParams();
  if (filterType === "day") modeParams.set("day", startDate);
  else {
    modeParams.set("from", startDate);
    modeParams.set("to", endDate);
  }

  const woParams = new URLSearchParams(modeParams);
  woParams.set("mode", "wo");
  const itemParams = new URLSearchParams(modeParams);
  itemParams.set("mode", "item");

  const periodLabel =
    startDate === endDate
      ? `Ngày làm việc ${formatDateLabel(startDate)}`
      : `Từ ${formatDateLabel(startDate)} đến ${formatDateLabel(endDate)}`;

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .dashboard-page { display: grid; gap: 22px; }
        .dashboard-filter-grid { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(420px, 1.4fr); gap: 14px; }
        .dashboard-filter-card { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; padding: 16px; border: 1px solid var(--border); border-radius: 16px; background: white; }
        .dashboard-filter-card label { min-width: 180px; flex: 1 1 180px; }
        .dashboard-filter-card .button { flex: 0 0 auto; }
        .dashboard-tabs { display: inline-flex; gap: 6px; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-tab { min-width: 120px; padding: 9px 14px; border-radius: 9px; color: #475467; font-weight: 800; text-align: center; }
        .dashboard-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .dashboard-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
        .dashboard-summary-grid .stat-card { min-width: 0; }
        .dashboard-table-header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 16px; }
        .dashboard-table-header p { margin-bottom: 0; }
        .dashboard-warning-mark { width: 20px; height: 20px; display: inline-grid; place-items: center; margin-left: 7px; border-radius: 50%; color: white; background: #d92d20; font-size: .76rem; font-weight: 900; vertical-align: middle; }
        .dashboard-total-row td { border-top: 2px solid #98a2b3; background: #f8fafc; font-weight: 800; }
        .dashboard-total-label { font-size: 1rem; }
        .dashboard-empty { padding: 42px 20px; color: var(--muted); text-align: center; }
        .dashboard-table { min-width: 1120px; }
        @media (max-width: 900px) {
          .dashboard-filter-grid { grid-template-columns: 1fr; }
          .dashboard-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 640px) {
          .dashboard-filter-card { display: grid; }
          .dashboard-filter-card label, .dashboard-filter-card .button { width: 100%; }
          .dashboard-summary-grid { grid-template-columns: 1fr; }
          .dashboard-table-header { align-items: stretch; flex-direction: column; }
          .dashboard-tabs { width: 100%; }
          .dashboard-tab { flex: 1; min-width: 0; }
        }
      `}</style>

      <div className="dashboard-page">
        <div className="hero-row">
          <div>
            <h1>Dashboard sản xuất</h1>
            <p className="muted">Theo dõi tiến độ tạo pallet, scan và nhập kho theo ngày làm việc.</p>
          </div>
        </div>

        <div className="dashboard-filter-grid">
          <form action="/production-dashboard" className="dashboard-filter-card" method="get">
            <input name="mode" type="hidden" value={mode} />
            <label>
              Tìm theo ngày
              <input defaultValue={filterType === "day" ? startDate : ""} name="day" type="date" />
            </label>
            <button className="button button-primary" type="submit">
              Xem ngày
            </button>
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
            <button className="button button-primary" type="submit">
              Xem khoảng ngày
            </button>
          </form>
        </div>

        {queryError ? (
          <section className="alert alert-error">
            Không thể tải dữ liệu dashboard: {queryError}
          </section>
        ) : null}

        <div className="dashboard-summary-grid">
          <div className="stat-card">
            <span className="muted small">Quan order</span>
            <span className="stat-number">{formatNumber(totals.orderQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã sản xuất</span>
            <span className="stat-number">{formatNumber(totals.producedQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã scan</span>
            <span className="stat-number">{formatNumber(totals.scannedQuantity)}</span>
          </div>
          <div className="stat-card">
            <span className="muted small">Đã nhập kho</span>
            <span className="stat-number">{formatNumber(totals.warehouseQuantity)}</span>
          </div>
        </div>

        <section className="panel">
          <div className="dashboard-table-header">
            <div>
              <p className="eyebrow">{periodLabel}</p>
              <h2>{mode === "wo" ? "Tổng hợp theo WO" : "Tổng hợp theo Item"}</h2>
              <p className="muted small">{visibleRows.length} dòng dữ liệu tổng hợp</p>
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

          <div className="table-wrap">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>{mode === "wo" ? "WO" : "Itemcode"}</th>
                  {mode === "wo" ? <th>Itemcode</th> : null}
                  <th>Product name</th>
                  <th>Customer</th>
                  <th>Quan order</th>
                  <th>Đã sản xuất</th>
                  <th>Đã scan</th>
                  <th>Đã nhập kho</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length ? (
                  visibleRows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <strong>{row.label}</strong>
                        <WarningMark show={row.warning} />
                      </td>
                      {mode === "wo" ? <td>{row.itemcode}</td> : null}
                      <td>{row.productName}</td>
                      <td>{row.customer}</td>
                      <td>{formatNumber(row.orderQuantity)}</td>
                      <td>
                        <QuantityProgress total={row.orderQuantity} value={row.producedQuantity} />
                      </td>
                      <td>
                        <QuantityProgress total={row.orderQuantity} value={row.scannedQuantity} />
                      </td>
                      <td>
                        <QuantityProgress total={row.orderQuantity} value={row.warehouseQuantity} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="dashboard-empty" colSpan={mode === "wo" ? 8 : 7}>
                      Không có dữ liệu pallet trong khoảng ngày đã chọn.
                    </td>
                  </tr>
                )}

                {visibleRows.length ? (
                  <tr className="dashboard-total-row">
                    <td className="dashboard-total-label">TOTAL</td>
                    {mode === "wo" ? <td>—</td> : null}
                    <td>—</td>
                    <td>—</td>
                    <td>{formatNumber(totals.orderQuantity)}</td>
                    <td>
                      <QuantityProgress total={totals.orderQuantity} value={totals.producedQuantity} />
                    </td>
                    <td>
                      <QuantityProgress total={totals.orderQuantity} value={totals.scannedQuantity} />
                    </td>
                    <td>
                      <QuantityProgress total={totals.orderQuantity} value={totals.warehouseQuantity} />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
