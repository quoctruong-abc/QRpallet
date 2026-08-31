import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  DashboardTableClient,
  type DashboardSummaryRow,
} from "../dashboard-table-client";

type SearchParams = Record<string, string | string[] | undefined>;

type CheckItemRpcRow = {
  itemcode: string;
  product_name: string | null;
  customer: string | null;
  first_working_day: string | null;
  last_working_day: string | null;
  wo: string;
  order_quantity: number | string | null;
  pallet_count: number | string | null;
  produced_quantity: number | string | null;
  scanned_quantity: number | string | null;
  warehouse_quantity: number | string | null;
  warning: boolean | null;
};

type Totals = {
  orderQuantity: number;
  palletCount: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
};

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function getTotals(rows: DashboardSummaryRow[]): Totals {
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

export default async function CheckItemPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requirePermission("dashboard.view");
  const params = await searchParams;
  const itemcode = readParam(params.item).trim();
  const itemIsValid = itemcode.length > 0 && itemcode.length <= 128;

  let queryError = false;
  let rpcRows: CheckItemRpcRow[] = [];

  if (itemIsValid) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("dashboard_check_item", {
      p_itemcode: itemcode,
    });

    if (error) {
      queryError = true;
      console.error("Check item database error", {
        itemcode,
        message: error.message,
      });
    } else {
      rpcRows = (data ?? []) as CheckItemRpcRow[];
    }
  }

  const firstRow = rpcRows[0];
  const rows: DashboardSummaryRow[] = rpcRows.map((row) => ({
    key: row.wo,
    label: row.wo,
    itemcode: row.itemcode,
    productName: row.product_name?.trim() || "—",
    customer: row.customer?.trim() || "—",
    orderQuantity: Number(row.order_quantity) || 0,
    palletCount: Number(row.pallet_count) || 0,
    producedQuantity: Number(row.produced_quantity) || 0,
    scannedQuantity: Number(row.scanned_quantity) || 0,
    warehouseQuantity: Number(row.warehouse_quantity) || 0,
    warning: Boolean(row.warning),
  }));
  const totals = getTotals(rows);

  const productName = firstRow?.product_name?.trim() || "—";
  const customer = firstRow?.customer?.trim() || "—";
  const firstWorkingDay = firstRow?.first_working_day || "2000-01-01";
  const lastWorkingDay = firstRow?.last_working_day || "2100-12-31";

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .check-item-page { display: grid; gap: 22px; }
        .dashboard-view-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-view-tab { min-width: 140px; padding: 10px 16px; border-radius: 9px; color: #475467; font-weight: 850; text-align: center; }
        .dashboard-view-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .check-item-search { display: flex; align-items: end; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 16px; background: white; }
        .check-item-search label { flex: 1 1 320px; max-width: 560px; }
        .check-item-context { display: grid; grid-template-columns: minmax(180px,.7fr) minmax(280px,1.4fr) minmax(220px,1fr); gap: 12px; }
        .check-item-context-card { min-width: 0; padding: 16px 18px; border: 1px solid var(--border); border-radius: 16px; background: white; }
        .check-item-context-card span { display: block; margin-bottom: 6px; color: var(--muted); font-size: .78rem; font-weight: 750; }
        .check-item-context-card strong { display: block; overflow-wrap: anywhere; font-size: 1rem; }
        .check-item-summary { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 12px; }
        .check-item-table-panel { width: 100%; max-width: 100%; overflow: hidden; }
        .check-item-table-header { margin-bottom: 16px; }
        .check-item-table-header p { margin-bottom: 0; }
        .check-item-table-shell > .table-wrap > .dashboard-table { min-width: 900px !important; }
        .check-item-table-shell > .table-wrap > .dashboard-table > thead > tr > th:nth-child(2),
        .check-item-table-shell > .table-wrap > .dashboard-table > thead > tr > th:nth-child(3),
        .check-item-table-shell > .table-wrap > .dashboard-table > thead > tr > th:nth-child(4),
        .check-item-table-shell > .table-wrap > .dashboard-table > tbody > tr > td:nth-child(2),
        .check-item-table-shell > .table-wrap > .dashboard-table > tbody > tr > td:nth-child(3),
        .check-item-table-shell > .table-wrap > .dashboard-table > tbody > tr > td:nth-child(4) { display: none; }
        @media (max-width: 1050px) {
          .check-item-summary { grid-template-columns: repeat(3, minmax(0,1fr)); }
          .check-item-context { grid-template-columns: 1fr 1fr; }
          .check-item-context-card:first-child { grid-column: 1 / -1; }
        }
        @media (max-width: 700px) {
          .dashboard-view-tabs { width: 100%; }
          .dashboard-view-tab { min-width: 0; flex: 1; padding-left: 8px; padding-right: 8px; }
          .check-item-search { display: grid; }
          .check-item-search label, .check-item-search .button { width: 100%; max-width: none; }
          .check-item-context, .check-item-summary { grid-template-columns: 1fr; }
          .check-item-context-card:first-child { grid-column: auto; }
        }
      `}</style>

      <div className="check-item-page">
        <div className="hero-row">
          <div>
            <h1>Dashboard sản xuất</h1>
            <p className="muted">Tra cứu toàn bộ lịch sử sản xuất của một item và tổng hợp theo WO.</p>
          </div>
        </div>

        <div className="dashboard-view-tabs" aria-label="Dashboard tabs">
          <Link className="dashboard-view-tab" href="/production-dashboard" prefetch={false}>Dashboard</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-fifo" prefetch={false}>Check FIFO</Link>
          <Link className="dashboard-view-tab dashboard-view-tab-active" href="/production-dashboard/check-item" prefetch={false}>Check item</Link>
        </div>

        <form action="/production-dashboard/check-item" className="check-item-search" method="get">
          <label>
            Tìm theo Itemcode
            <input
              autoComplete="off"
              defaultValue={itemcode}
              maxLength={128}
              name="item"
              placeholder="Nhập itemcode..."
              required
              type="search"
            />
          </label>
          <button className="button button-primary" type="submit">Tìm item</button>
        </form>

        {itemcode && !itemIsValid ? (
          <section className="alert alert-error">Itemcode không hợp lệ.</section>
        ) : null}
        {queryError ? (
          <section className="alert alert-error">Không thể tải dữ liệu. Vui lòng thử lại.</section>
        ) : null}
        {itemIsValid && !queryError && !rows.length ? (
          <section className="alert">Không tìm thấy dữ liệu pallet cho item <strong>{itemcode}</strong>.</section>
        ) : null}

        {rows.length ? (
          <>
            <div className="check-item-context">
              <div className="check-item-context-card">
                <span>Itemcode</span>
                <strong>{itemcode}</strong>
              </div>
              <div className="check-item-context-card">
                <span>Tên sản phẩm</span>
                <strong>{productName}</strong>
              </div>
              <div className="check-item-context-card">
                <span>Khách hàng</span>
                <strong>{customer}</strong>
              </div>
            </div>

            <div className="check-item-summary">
              <div className="stat-card"><span className="muted small">Quan order</span><span className="stat-number">{formatNumber(totals.orderQuantity)}</span></div>
              <div className="stat-card"><span className="muted small">Pallet active</span><span className="stat-number">{formatNumber(totals.palletCount)}</span></div>
              <div className="stat-card"><span className="muted small">Đã sản xuất</span><span className="stat-number">{formatNumber(totals.producedQuantity)}</span></div>
              <div className="stat-card"><span className="muted small">Đã scan</span><span className="stat-number">{formatNumber(totals.scannedQuantity)}</span></div>
              <div className="stat-card"><span className="muted small">Đã nhập kho</span><span className="stat-number">{formatNumber(totals.warehouseQuantity)}</span></div>
            </div>

            <section className="panel check-item-table-panel">
              <div className="check-item-table-header">
                <p className="eyebrow">TOÀN BỘ DỮ LIỆU · NHÓM TẠI DATABASE</p>
                <h2>Tiến độ theo WO</h2>
                <p className="muted small">{rows.length.toLocaleString("vi-VN")} WO · TOTAL tính trên toàn bộ dữ liệu của item.</p>
              </div>

              <div className="check-item-table-shell">
                <DashboardTableClient
                  endDate={lastWorkingDay}
                  mode="wo"
                  rows={rows}
                  startDate={firstWorkingDay}
                  totals={totals}
                />
              </div>
            </section>
          </>
        ) : null}
      </div>
    </PageShell>
  );
}
