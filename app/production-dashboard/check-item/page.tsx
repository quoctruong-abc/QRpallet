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

type CheckWoDbRow = {
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

type Totals = {
  orderQuantity: number;
  palletCount: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
};

const QUERY_BATCH_SIZE = 1000;

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function summarizeValues(values: Set<string>) {
  const cleaned = Array.from(values).filter(Boolean).sort((a, b) => a.localeCompare(b, "vi"));
  if (!cleaned.length) return "—";
  if (cleaned.length === 1) return cleaned[0];
  return `${cleaned[0]} (+${cleaned.length - 1})`;
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
  const searchMode = readParam(params.mode) === "wo" ? "wo" : "item";
  const itemcode = readParam(params.item).trim();
  const wo = readParam(params.wo).trim();
  const itemIsValid = itemcode.length > 0 && itemcode.length <= 128;
  const woIsValid = wo.length > 0 && wo.length <= 128;
  const searchValue = searchMode === "wo" ? wo : itemcode;
  const searchIsValid = searchMode === "wo" ? woIsValid : itemIsValid;

  let queryError = false;
  let rpcRows: CheckItemRpcRow[] = [];
  let rows: DashboardSummaryRow[] = [];
  let productName = "—";
  let customer = "—";
  let resultItemcode = "—";
  let firstWorkingDay = "2000-01-01";
  let lastWorkingDay = "2100-12-31";

  if (searchMode === "item" && itemIsValid) {
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

    const firstRow = rpcRows[0];
    rows = rpcRows.map((row) => ({
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
    productName = firstRow?.product_name?.trim() || "—";
    customer = firstRow?.customer?.trim() || "—";
    resultItemcode = itemcode;
    firstWorkingDay = firstRow?.first_working_day || firstWorkingDay;
    lastWorkingDay = firstRow?.last_working_day || lastWorkingDay;
  } else if (searchMode === "wo" && woIsValid) {
    const supabase = await createClient();
    const palletRows: CheckWoDbRow[] = [];
    const fields = "id,pallet_id,itemcode,product_name,customer,wo,quanorder,quantity,status,has_been_edited,has_been_return,working_day";

    async function appendRows(isDeleted: boolean) {
      for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
        let query = supabase
          .from("pallet_data")
          .select(fields)
          .eq("wo", wo)
          .order("id", { ascending: true })
          .range(offset, offset + QUERY_BATCH_SIZE - 1);

        query = isDeleted
          ? query.not("effect_to", "is", null).ilike("note", "delete:%")
          : query.is("effect_to", null);

        const { data, error } = await query;
        if (error) {
          console.error("Check WO database error", {
            wo,
            isDeleted,
            message: error.message,
          });
          return false;
        }

        const pageRows = (data ?? []) as Omit<CheckWoDbRow, "is_deleted">[];
        palletRows.push(...pageRows.map((row) => ({ ...row, is_deleted: isDeleted })));
        if (pageRows.length < QUERY_BATCH_SIZE) return true;
      }
    }

    const activeLoaded = await appendRows(false);
    const deletedLoaded = activeLoaded ? await appendRows(true) : false;
    queryError = !activeLoaded || !deletedLoaded;

    if (!queryError && palletRows.length) {
      const itemcodes = new Set<string>();
      const productNames = new Set<string>();
      const customers = new Set<string>();
      const activePalletIds = new Set<string>();
      const workingDays: string[] = [];
      let orderQuantity = 0;
      let producedQuantity = 0;
      let scannedQuantity = 0;
      let warehouseQuantity = 0;
      let warning = false;

      for (const row of palletRows) {
        if (row.itemcode?.trim()) itemcodes.add(row.itemcode.trim());
        if (row.product_name?.trim()) productNames.add(row.product_name.trim());
        if (row.customer?.trim()) customers.add(row.customer.trim());
        if (row.working_day) workingDays.push(row.working_day);
        orderQuantity = Math.max(orderQuantity, Number(row.quanorder) || 0);

        const quantity = Number(row.quantity) || 0;
        const status = (row.status ?? "").toLowerCase();
        if (!row.is_deleted) {
          activePalletIds.add(row.pallet_id);
          producedQuantity += quantity;
          if (status !== "production") scannedQuantity += quantity;
          if (status === "whdone") warehouseQuantity += quantity;
        }
        warning ||= Boolean(row.has_been_edited || row.has_been_return || row.is_deleted);
      }

      productName = summarizeValues(productNames);
      customer = summarizeValues(customers);
      resultItemcode = summarizeValues(itemcodes);
      workingDays.sort();
      firstWorkingDay = workingDays[0] ?? firstWorkingDay;
      lastWorkingDay = workingDays[workingDays.length - 1] ?? lastWorkingDay;
      rows = [{
        key: wo,
        label: wo,
        itemcode: resultItemcode,
        productName,
        customer,
        orderQuantity,
        palletCount: activePalletIds.size,
        producedQuantity,
        scannedQuantity,
        warehouseQuantity,
        warning,
      }];
    }
  }

  const totals = getTotals(rows);

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .check-item-page { display: grid; gap: 22px; }
        .dashboard-view-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-view-tab { min-width: 140px; padding: 10px 16px; border-radius: 9px; color: #475467; font-weight: 850; text-align: center; }
        .dashboard-view-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .check-search-mode-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: white; }
        .check-search-mode-tab { min-width: 128px; padding: 9px 14px; border-radius: 9px; color: #475467; font-size: .88rem; font-weight: 800; text-align: center; }
        .check-search-mode-tab-active { color: #175cd3; background: #eff8ff; box-shadow: inset 0 0 0 1px #b2ccff; }
        .check-item-search { display: flex; align-items: end; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 16px; background: white; }
        .check-item-search label { flex: 1 1 320px; max-width: 560px; }
        .check-item-context { display: grid; grid-template-columns: minmax(180px,.7fr) minmax(280px,1.4fr) minmax(220px,1fr); gap: 12px; }
        .check-item-context-four { grid-template-columns: minmax(160px,.7fr) minmax(180px,.8fr) minmax(280px,1.4fr) minmax(220px,1fr); }
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
          .check-search-mode-tabs { width: 100%; }
          .check-search-mode-tab { min-width: 0; flex: 1; }
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
            <p className="muted">Tra cứu toàn bộ lịch sử sản xuất theo Itemcode hoặc WO.</p>
          </div>
        </div>

        <div className="dashboard-view-tabs" aria-label="Dashboard tabs">
          <Link className="dashboard-view-tab" href="/production-dashboard" prefetch={false}>Dashboard</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-fifo" prefetch={false}>Check FIFO</Link>
          <Link className="dashboard-view-tab dashboard-view-tab-active" href="/production-dashboard/check-item" prefetch={false}>Check item</Link>
        </div>

        <div className="check-search-mode-tabs" aria-label="Chế độ tìm kiếm">
          <Link className={`check-search-mode-tab ${searchMode === "item" ? "check-search-mode-tab-active" : ""}`} href="/production-dashboard/check-item?mode=item" prefetch={false}>Theo Item</Link>
          <Link className={`check-search-mode-tab ${searchMode === "wo" ? "check-search-mode-tab-active" : ""}`} href="/production-dashboard/check-item?mode=wo" prefetch={false}>Theo WO</Link>
        </div>

        <form action="/production-dashboard/check-item" className="check-item-search" method="get">
          <input name="mode" type="hidden" value={searchMode} />
          <label>
            {searchMode === "wo" ? "Tìm theo WO" : "Tìm theo Itemcode"}
            <input
              autoComplete="off"
              defaultValue={searchValue}
              maxLength={128}
              name={searchMode === "wo" ? "wo" : "item"}
              placeholder={searchMode === "wo" ? "Nhập WO..." : "Nhập itemcode..."}
              required
              type="search"
            />
          </label>
          <button className="button button-primary" type="submit">{searchMode === "wo" ? "Tìm WO" : "Tìm item"}</button>
        </form>

        {searchValue && !searchIsValid ? (
          <section className="alert alert-error">{searchMode === "wo" ? "WO" : "Itemcode"} không hợp lệ.</section>
        ) : null}
        {queryError ? (
          <section className="alert alert-error">Không thể tải dữ liệu. Vui lòng thử lại.</section>
        ) : null}
        {searchIsValid && !queryError && !rows.length ? (
          <section className="alert">Không tìm thấy dữ liệu pallet cho {searchMode === "wo" ? "WO" : "item"} <strong>{searchValue}</strong>.</section>
        ) : null}

        {rows.length ? (
          <>
            <div className={`check-item-context ${searchMode === "wo" ? "check-item-context-four" : ""}`}>
              <div className="check-item-context-card">
                <span>{searchMode === "wo" ? "WO" : "Itemcode"}</span>
                <strong>{searchValue}</strong>
              </div>
              {searchMode === "wo" ? <div className="check-item-context-card"><span>Itemcode</span><strong>{resultItemcode}</strong></div> : null}
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
                <h2>{searchMode === "wo" ? `Tiến độ WO ${wo}` : "Tiến độ theo WO"}</h2>
                <p className="muted small">{searchMode === "wo" ? "TOTAL tính trên toàn bộ dữ liệu của WO." : `${rows.length.toLocaleString("vi-VN")} WO · TOTAL tính trên toàn bộ dữ liệu của item.`}</p>
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
