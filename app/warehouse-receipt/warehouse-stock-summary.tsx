"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StockSummary } from "@/lib/warehouse-receipt/outgoing";

export function WarehouseStockSummary({ revision }: { revision: number }) {
  const [rows, setRows] = useState<StockSummary[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [shortageOnly, setShortageOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const load = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ view: "summary", search, offset: String(offset), shortage: String(shortageOnly) });
      const response = await fetch(`/api/warehouse-receipt/outgoing?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không đọc được tổng tồn kho.");
      if (current !== version.current) return;
      setRows(data.rows);
      setTotal(data.total);
      setError("");
      if (offset > 0 && offset >= data.total) setOffset(data.total > 0 ? Math.floor((data.total - 1) / 100) * 100 : 0);
    } catch (error) {
      if (current === version.current) setError(error instanceof Error ? error.message : "Không đọc được tổng tồn kho.");
    } finally { if (current === version.current) setLoading(false); }
  }, [search, offset, shortageOnly]);
  const cancelLoad = useCallback(() => { version.current++; }, []);
  useEffect(() => { void Promise.resolve().then(load); return cancelLoad; }, [load, revision, cancelLoad]);
  const num = (value: number) => Number(value).toLocaleString("vi-VN");
  return <section aria-label="Tổng hợp tồn kho" className="scan-table-card">
    <div className="warehouse-incoming-draft-heading">
      <h2>Tổng hợp tồn kho theo item ({total})</h2>
      <p className="muted small">On order = toàn bộ số còn phải giao. Tồn sau lịch giao có thể âm khi nhu cầu vượt tồn.</p>
      <form className="warehouse-outgoing-toolbar" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(input); }}>
        <input aria-label="Tìm tổng tồn kho" placeholder="Item, tên sản phẩm, khách hàng" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="button button-secondary" type="submit">Tìm tồn kho</button>
        <label className="warehouse-outgoing-checkbox"><input type="checkbox" checked={shortageOnly} onChange={(event) => { setShortageOnly(event.target.checked); setOffset(0); }} />Chỉ item thiếu hàng</label>
      </form>
    </div>
    {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
    <div className="scan-table-wrap"><table className="warehouse-table">
      <thead><tr><th>Item</th><th>Tên sản phẩm / Khách hàng</th><th>Tổng nhận</th><th>Đã xuất</th><th>Tồn thực tế</th><th>On order</th><th>Tồn sau lịch giao</th><th>Thiếu</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.itemcode} className={row.shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
        <td>{row.itemcode}</td><td className="warehouse-outgoing-name">{row.product_name}<small>{row.customer}</small></td>
        <td>{num(row.received_qty)}</td><td>{num(row.issued_qty)}</td><td>{num(row.balance_qty)}</td><td>{num(row.on_order_qty)}</td><td>{num(row.available_qty)}</td><td>{num(row.shortage_qty)}</td>
      </tr>)}</tbody>
    </table></div>
    {!rows.length && !error ? <p className="scan-empty">{loading ? "Đang tải…" : "Không có item phù hợp."}</p> : null}
    <div className="warehouse-incoming-next">
      <button className="button button-secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))} type="button">Trước</button>
      <span>{total ? `${offset + 1}–${Math.min(offset + 100, total)} / ${total}` : "0"}</span>
      <button className="button button-secondary" disabled={offset + 100 >= total || loading} onClick={() => setOffset(offset + 100)} type="button">Sau</button>
    </div>
  </section>;
}
