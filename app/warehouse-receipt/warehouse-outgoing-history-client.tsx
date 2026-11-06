"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isInventoryDate } from "@/lib/warehouse-receipt/incoming";

const pageSize = 50;
const date = (value: string | null) => value ? value.split("-").reverse().join("/") : "—";
const num = (value: number) => value.toLocaleString("vi-VN");

type HistoryRow = {
  shipped_date: string; customer: string | null; itemcode: string; product_name: string | null;
  quantity: number; creator_name: string;
};
type Issue = {
  id: string; request_id: string; delivery_date: string; purorder: string; sales_id: string;
  delivery_source: "erp" | "manual"; ordered_qty: number; quantity: number; creator_name: string;
  lots: { incoming_id: string; production_date: string | null; quantity: number }[];
};
type Page<T> = { rows: T[]; total: number };

function useHistoryPage<T>(query: string | null, refresh = 0) {
  const key = query === null ? null : `${refresh}:${query}`;
  const [result, setResult] = useState<{ key: string; data?: Page<T>; error?: string } | null>(null);
  useEffect(() => {
    if (query === null || key === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/warehouse-receipt/outgoing-history?${query}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || "Không tải được lịch sử xuất kho.");
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (cause) {
        if (!controller.signal.aborted) setResult({ key, error: cause instanceof Error ? cause.message : "Không tải được lịch sử xuất kho." });
      }
    })();
    return () => controller.abort();
  }, [query, key]);

  const current = result && result.key === key ? result : null;
  return { data: current?.data, error: current?.error, loading: key !== null && !current };
}

function HistoryPager({ page, offset, onChange }: { page: Page<unknown>; offset: number; onChange: (offset: number) => void }) {
  if (page.total <= pageSize && offset === 0) return null;
  return <div className="warehouse-incoming-next">
    <button className="button button-secondary" disabled={offset === 0} onClick={() => onChange(offset - pageSize)} type="button">Trước</button>
    <span>{page.rows.length ? `${num(offset + 1)}–${num(offset + page.rows.length)} / ${num(page.total)}` : num(page.total)}</span>
    <button className="button button-secondary" disabled={offset + pageSize >= page.total} onClick={() => onChange(offset + pageSize)} type="button">Sau</button>
  </div>;
}

export function WarehouseOutgoingHistoryClient({ active }: { active: boolean }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [detailOffset, setDetailOffset] = useState(0);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const listQuery = new URLSearchParams({ ...range, offset: String(offset) }).toString();
  const detailQuery = selected ? new URLSearchParams({ itemcode: selected.itemcode, shipped: selected.shipped_date, offset: String(detailOffset) }).toString() : null;
  const history = useHistoryPage<HistoryRow>(active ? listQuery : null, refresh);
  const details = useHistoryPage<Issue>(active ? detailQuery : null);
  const rangeReady = isInventoryDate(from) && isInventoryDate(to);

  return <section className="warehouse-page">
    <div className="hero-row">
      <div><h2>Lịch sử xuất kho</h2><p className="muted">Gộp số thực xuất theo ngày xuất và mã sản phẩm. Mặc định hiển thị 10 dòng gần nhất.</p></div>
      <div className="stat-card"><span className="stat-number">{num(history.data?.total ?? 0)}</span><span className="muted">Dòng xuất kho</span></div>
    </div>

    <form className="warehouse-filter-card" onSubmit={(event) => {
      event.preventDefault();
      if (!rangeReady) return;
      setRange(from <= to ? { from, to } : { from: to, to: from });
      setOffset(0);
      setRefresh((old) => old + 1);
    }}>
      <label><span>Từ ngày</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label><span>Đến ngày</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button className="button button-primary" disabled={!rangeReady || history.loading} type="submit">Tìm khoảng ngày</button>
      {range || from || to ? <button className="button button-secondary" type="button" onClick={() => {
        setFrom(""); setTo(""); setRange(null); setOffset(0); setRefresh((old) => old + 1);
      }}>Xem gần nhất</button> : null}
    </form>

    {history.error ? <p className="alert alert-error" role="alert">{history.error}</p> : null}
    <section className="scan-table-card">
      {history.loading ? <p className="scan-empty" role="status">Đang tải lịch sử xuất kho…</p> : null}
      {history.data ? <>
        {history.data.rows.length ? <div className="scan-table-wrap"><table className="warehouse-table warehouse-receipt-outgoing-table">
          <thead><tr><th>Ngày xuất</th><th>Khách hàng</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Số lượng</th><th>Người tạo</th><th>Chi tiết</th></tr></thead>
          <tbody>{history.data.rows.map((row) => <tr key={JSON.stringify([row.shipped_date, row.itemcode])}>
            <td className="warehouse-receipt-date">{date(row.shipped_date)}</td><td>{row.customer || "—"}</td><td>{row.itemcode}</td>
            <td>{row.product_name || "—"}</td><td>{num(row.quantity)}</td><td>{row.creator_name || "—"}</td>
            <td><button className="button button-secondary button-small warehouse-stock-eye" type="button" title="Xem chi tiết"
              aria-label={`Xem chi tiết xuất ${row.itemcode} ngày ${date(row.shipped_date)}`}
              onClick={() => { setSelected(row); setDetailOffset(0); dialog.current?.showModal(); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" />
              </svg>
            </button></td>
          </tr>)}</tbody>
        </table></div> : <p className="scan-empty">Không có lần xuất kho trong khoảng ngày đã chọn.</p>}
        <HistoryPager page={history.data} offset={offset} onChange={setOffset} />
      </> : null}
    </section>

    <dialog className="modal-card warehouse-opening-dialog" aria-labelledby={titleId} ref={dialog} onClose={() => setSelected(null)}>
      <div className="modal-heading">
        <h2 id={titleId}>Chi tiết xuất kho</h2>
        <button className="modal-close" aria-label="Đóng chi tiết xuất kho" type="button" onClick={() => dialog.current?.close()}>×</button>
      </div>
      {selected ? <p><strong>{selected.itemcode}</strong> · {selected.product_name || "—"} · Ngày xuất {date(selected.shipped_date)} · Tổng xuất {num(selected.quantity)}</p> : null}
      {details.error ? <p className="alert alert-error" role="alert">{details.error}</p> : null}
      {details.loading ? <p className="muted" role="status">Đang tải chi tiết…</p> : null}
      {details.data ? <>
        {details.data.rows.length ? <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>PO / Sales ID</th><th>Ngày giao</th><th>Số yêu cầu</th><th>Thực xuất lần này</th><th>Người tạo</th><th>Lô đã xuất</th></tr></thead>
          <tbody>{details.data.rows.map((issue) => <tr key={issue.id}>
            <td>{issue.delivery_source === "manual" ? `Nhập tay · NT-${issue.request_id.slice(0, 8).toUpperCase()}` : <>{issue.purorder}<br />{issue.sales_id}</>}</td>
            <td className="warehouse-receipt-date">{date(issue.delivery_date)}</td><td>{num(issue.ordered_qty)}</td><td>{num(issue.quantity)}</td><td>{issue.creator_name}</td>
            <td>{issue.lots.length ? <ul className="warehouse-outgoing-review-days">{issue.lots.map((lot) =>
              <li key={lot.incoming_id}><span>#{lot.incoming_id} · {lot.production_date ? date(lot.production_date) : "Không có ngày sản xuất"}</span><strong>{num(lot.quantity)}</strong></li>)}</ul> : "—"}</td>
          </tr>)}</tbody>
        </table></div> : <p className="scan-empty">Không có chi tiết xuất kho.</p>}
        <HistoryPager page={details.data} offset={detailOffset} onChange={setDetailOffset} />
      </> : null}
      <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => dialog.current?.close()}>Đóng</button></div>
    </dialog>
  </section>;
}
