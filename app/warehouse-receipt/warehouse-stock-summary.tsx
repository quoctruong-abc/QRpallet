"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { StockSummary } from "@/lib/warehouse-receipt/outgoing";
import { loadWarehouseRows, matchesWarehouseSearch, warehouseSearchTokens, WAREHOUSE_PAGE_SIZE } from "@/lib/warehouse-receipt/outgoing-list";

export function WarehouseStockSummary({ revision }: { revision: number }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<StockSummary[]>([]);
  const [search, setSearch] = useState("");
  const [shortageOnly, setShortageOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const data = await loadWarehouseRows<StockSummary>({ view: "summary" }, (row) => row.itemcode, controller.signal);
        if (controller.signal.aborted) return;
        setRows(data);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Không đọc được tổng tồn kho.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    });
    return () => controller.abort();
  }, [revision]);

  const filtered = useMemo(() => {
    const tokens = warehouseSearchTokens(search);
    return rows.filter((row) => (!shortageOnly || row.shortage_qty > 0)
      && matchesWarehouseSearch(tokens, [row.itemcode, row.product_name, row.customer]));
  }, [rows, search, shortageOnly]);
  const total = filtered.length;
  const pageStart = Math.min(offset, Math.max(0, Math.floor((total - 1) / WAREHOUSE_PAGE_SIZE) * WAREHOUSE_PAGE_SIZE));
  const visible = filtered.slice(pageStart, pageStart + WAREHOUSE_PAGE_SIZE);
  const num = (value: number) => Number(value).toLocaleString("vi-VN");
  return <section aria-label="Tổng hợp tồn kho" className="scan-table-card">
    <div className="warehouse-incoming-draft-heading">
      <div className="warehouse-outgoing-summary-heading">
        <h2>Tổng hợp tồn kho theo item ({num(rows.length)})</h2>
        <button aria-expanded={expanded} aria-controls={panelId} className="button button-secondary button-small"
          onClick={() => setExpanded((open) => !open)} type="button">
          {expanded ? "▾ Thu gọn" : "▸ Mở rộng"}
        </button>
      </div>
    </div>
    <div id={panelId} hidden={!expanded}>
      <div className="warehouse-incoming-draft-heading">
        <p className="muted small">On order = toàn bộ số còn phải giao. Tồn sau lịch giao có thể âm khi nhu cầu vượt tồn.</p>
        <div className="warehouse-outgoing-toolbar">
          <input type="search" aria-label="Tìm tổng tồn kho" placeholder="Item, tên sản phẩm, khách hàng" value={search}
            onChange={(event) => { setSearch(event.target.value); setOffset(0); }} />
          <label className="warehouse-outgoing-checkbox"><input type="checkbox" checked={shortageOnly}
            onChange={(event) => { setShortageOnly(event.target.checked); setOffset(0); }} />Chỉ item thiếu hàng</label>
        </div>
      </div>
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      <div className="scan-table-wrap"><table className="warehouse-table">
        <thead><tr><th>Item</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Tổng nhận</th><th>Đã xuất</th><th>Tồn thực tế</th><th>On order</th><th>Tồn sau lịch giao</th><th>Thiếu</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.itemcode} className={row.shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
          <td>{row.itemcode}</td><td className="warehouse-outgoing-name">{row.product_name}</td><td>{row.customer || "—"}</td>
          <td>{num(row.received_qty)}</td><td>{num(row.issued_qty)}</td><td>{num(row.balance_qty)}</td><td>{num(row.on_order_qty)}</td><td>{num(row.available_qty)}</td><td>{num(row.shortage_qty)}</td>
        </tr>)}</tbody>
      </table></div>
      {!visible.length && !error ? <p className="scan-empty">{loading ? "Đang tải…" : "Không có item phù hợp."}</p> : null}
      <div className="warehouse-incoming-next">
        <button className="button button-secondary" disabled={pageStart === 0} onClick={() => setOffset(pageStart - WAREHOUSE_PAGE_SIZE)} type="button">Trước</button>
        <span>{total ? `${pageStart + 1}–${Math.min(pageStart + WAREHOUSE_PAGE_SIZE, total)} / ${total}` : "0"}</span>
        <button className="button button-secondary" disabled={pageStart + WAREHOUSE_PAGE_SIZE >= total} onClick={() => setOffset(pageStart + WAREHOUSE_PAGE_SIZE)} type="button">Sau</button>
      </div>
    </div>
  </section>;
}
