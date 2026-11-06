"use client";

import { useEffect, useId, useRef, useState } from "react";
import { todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import type { DeliveryFifoReview, DeliveryRequest } from "@/lib/warehouse-receipt/outgoing";

const num = (qty: number) => qty.toLocaleString("vi-VN");
const productionDate = (date: string | null) => date ? date.split("-").reverse().join("/") : "Không có ngày sản xuất";

export function WarehouseDeliveryReview({ requests, disabled }: { requests: DeliveryRequest[]; disabled: boolean }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [shipDate, setShipDate] = useState(todayInVietnam);
  const [review, setReview] = useState<DeliveryFifoReview | null>(null);
  const [requestedCount, setRequestedCount] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function openReview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const ids = requests.map((row) => row.id);
    setRequestedCount(ids.length);
    setShipDate(todayInVietnam());
    setReview(null);
    setError("");
    dialog.current?.showModal();
    try {
      const response = await fetch("/api/warehouse-receipt/outgoing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review", request_ids: ids }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không tải được gợi ý FIFO.");
      if (!controller.signal.aborted) setReview(data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Không tải được gợi ý FIFO.");
    }
  }

  return <>
    <button className="button button-secondary" type="button" disabled={disabled || !requests.length}
      onClick={() => { void openReview(); }}>Review</button>
    <dialog aria-labelledby={titleId} className="modal-card warehouse-opening-dialog warehouse-outgoing-review-dialog"
      ref={dialog} onClose={() => request.current?.abort()}>
      <div className="modal-heading">
        <h2 id={titleId}>Review xuất kho theo FIFO</h2>
        <button aria-label="Đóng Review" className="modal-close" onClick={() => dialog.current?.close()} type="button">×</button>
      </div>
      <label className="warehouse-outgoing-review-date">Ngày xuất<input type="date" value={shipDate} onChange={(event) => setShipDate(event.target.value)} /></label>
      <p className="muted small">Gộp số còn phải giao của các yêu cầu đã lọc. Gợi ý dựa trên tồn hiện tại, chưa giữ lô hoặc trừ tồn.</p>
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      {!review && !error ? <p role="status" className="muted">Đang tính FIFO…</p> : null}
      {review ? <>
        <p><strong>{num(review.rows.length)} item · {num(review.request_count)} yêu cầu chờ xuất</strong></p>
        {review.request_count < requestedCount ? <p className="alert" role="status">Một số yêu cầu không còn chờ xuất. Tải lại danh sách để cập nhật.</p> : null}
        {review.rows.length ? <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>Itemcode</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Số lượng cần xuất</th><th>Ngày sản xuất / Số lượng FIFO</th><th>Còn thiếu</th></tr></thead>
          <tbody>{review.rows.map((row) => <tr key={row.itemcode} className={row.shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
            <td>{row.itemcode}</td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td>{num(row.quantity)}</td>
            <td>{row.days.length ? <ul className="warehouse-outgoing-review-days">{row.days.map((day) =>
              <li key={day.production_date ?? "undated"}><span>{productionDate(day.production_date)}</span><strong>{num(day.quantity)}</strong></li>)}
            </ul> : "Không có tồn"}</td>
            <td>{num(row.shortage_qty)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="scan-empty">Không còn yêu cầu chờ xuất trong kết quả đã lọc.</p>}
      </> : null}
      <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => dialog.current?.close()}>Đóng</button></div>
    </dialog>
  </>;
}
