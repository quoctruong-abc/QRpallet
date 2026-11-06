"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isInventoryDate, todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import type { BulkDeliveryInput, BulkDeliveryLot, BulkDeliveryPreview, DeliveryFifoReview, DeliveryRequest } from "@/lib/warehouse-receipt/outgoing";

const num = (qty: number) => qty.toLocaleString("vi-VN");
const formatDate = (date: string) => date.split("-").reverse().join("/");
const productionDate = (date: string | null) => date ? formatDate(date) : "Không có ngày sản xuất";
const lotsFor = (data: BulkDeliveryPreview, item: string) => Object.hasOwn(data.lots, item) ? data.lots[item] : [];
type PickAmounts = Record<string, number>;
type ReviewRow = DeliveryFifoReview["rows"][number];

function suggest(lots: BulkDeliveryLot[], quantity: number): PickAmounts {
  const result: PickAmounts = {};
  for (const lot of lots) {
    if (!quantity) break;
    result[lot.incoming_id] = Math.min(lot.balance_qty, quantity);
    quantity -= result[lot.incoming_id];
  }
  return result;
}

function summarize(lots: BulkDeliveryLot[], picks: PickAmounts) {
  const byDate = new Map<string | null, number>();
  let quantity = 0;
  for (const lot of lots) {
    const amount = picks[lot.incoming_id] ?? 0;
    if (amount <= 0) continue;
    byDate.set(lot.production_date, (byDate.get(lot.production_date) ?? 0) + amount);
    quantity += amount;
  }
  return { quantity, days: Array.from(byDate, ([production_date, quantity]) => ({ production_date, quantity })) };
}

type Props = {
  requests: DeliveryRequest[]; disabled: boolean; locked: boolean; busy: boolean; notice: string;
  onBulkShip: (payload: BulkDeliveryInput) => Promise<boolean>; onBulkRetry?: () => Promise<boolean>;
};

export function WarehouseDeliveryReview({ requests, disabled, locked, busy, notice, onBulkShip, onBulkRetry }: Props) {
  const titleId = useId();
  const editorTitle = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [shipDate, setShipDate] = useState(todayInVietnam);
  const [review, setReview] = useState<DeliveryFifoReview | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkData, setBulkData] = useState<BulkDeliveryPreview | null>(null);
  const [picked, setPicked] = useState<Map<string, PickAmounts>>(new Map());
  const [editing, setEditing] = useState<ReviewRow | null>(null);
  const [draft, setDraft] = useState<PickAmounts>({});
  const [requestedCount, setRequestedCount] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => () => request.current?.abort(), []);

  async function openReview(forBulk: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const ids = requests.map((row) => row.id);
    setRequestedCount(ids.length);
    setShipDate(todayInVietnam());
    setBulk(forBulk);
    setReview(null);
    setBulkData(null);
    setPicked(new Map());
    setError("");
    setCopied("");
    setSubmitted(false);
    dialog.current?.showModal();
    try {
      const response = await fetch("/api/warehouse-receipt/outgoing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: forBulk ? "bulk_preview" : "review", request_ids: ids }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không tải được gợi ý FIFO.");
      if (controller.signal.aborted) return;
      setReview(data);
      if (forBulk) {
        const result = data as BulkDeliveryPreview;
        setBulkData(result);
        setPicked(new Map(result.rows.map((row) => [row.itemcode, suggest(lotsFor(result, row.itemcode), row.quantity)])));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Không tải được gợi ý FIFO.");
    }
  }

  async function copyReview() {
    if (!review?.rows.length) return;
    const columns = ["Ngày xuất", "Itemcode", "Tên sản phẩm", "Khách hàng", "Số lượng cần xuất", "Ngày sản xuất / Số lượng FIFO", "Còn thiếu"];
    const clean = (value: string | number) => String(value).replace(/[\t\r\n]+/g, " ");
    const tsv = [columns.join("\t"), ...review.rows.map((row) => [
      formatDate(shipDate), row.itemcode, row.product_name, row.customer ?? "", row.quantity,
      row.days.map((day) => `${productionDate(day.production_date)}: ${day.quantity}`).join("; "), row.shortage_qty,
    ].map(clean).join("\t"))].join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied("Đã sao chép bảng.");
    } catch {
      setCopied("Không sao chép được. Kiểm tra quyền clipboard của trình duyệt.");
    }
  }

  function editLots(row: ReviewRow) {
    setEditing(row);
    setDraft({ ...picked.get(row.itemcode) });
    editor.current?.showModal();
  }

  const editorLots = editing && bulkData ? lotsFor(bulkData, editing.itemcode) : [];
  const draftTotal = Object.values(draft).reduce((total, qty) => total + qty, 0);
  const invalidDraft = !editing || draftTotal > editing.quantity || editorLots.some((lot) => {
    const amount = draft[lot.incoming_id] ?? 0;
    return !Number.isInteger(amount) || amount < 0 || amount > lot.balance_qty;
  });
  const chosenTotal = Array.from(picked.values()).reduce((total, amounts) => total + Object.values(amounts).reduce((sum, qty) => sum + qty, 0), 0);

  async function confirmBulk() {
    if (!bulkData || locked || !isInventoryDate(shipDate) || !chosenTotal) return;
    const itemcodes = new Set<string>();
    const lots: BulkDeliveryInput["lots"] = [];
    for (const [itemcode, amounts] of picked) {
      for (const [incoming_id, quantity] of Object.entries(amounts)) {
        if (quantity <= 0) continue;
        itemcodes.add(itemcode);
        lots.push({ incoming_id, quantity });
      }
    }
    setSubmitted(true);
    const selected = bulkData.requests.filter((row) => itemcodes.has(row.itemcode)).map(({ id, version }) => ({ id, version }));
    if (await onBulkShip({ shipped_date: shipDate, requests: selected, lots })) dialog.current?.close();
  }

  return <>
    <button className="button button-secondary" type="button" disabled={disabled || !requests.length}
      onClick={() => { void openReview(false); }}>Review</button>
    <button className="button button-primary" type="button" disabled={disabled || locked || !requests.length}
      onClick={() => { void openReview(true); }}>Xuất hàng loạt</button>
    <dialog aria-labelledby={titleId} className="modal-card warehouse-opening-dialog warehouse-outgoing-review-dialog"
      ref={dialog} onClose={() => request.current?.abort()} onCancel={(event) => { if (bulk && busy) event.preventDefault(); }}>
      <div className="modal-heading">
        <h2 id={titleId}>{bulk ? "Xuất hàng loạt" : "Review xuất kho theo FIFO"}</h2>
        <button aria-label={bulk ? "Đóng xuất hàng loạt" : "Đóng Review"} className="modal-close" disabled={bulk && busy} onClick={() => dialog.current?.close()} type="button">×</button>
      </div>
      {bulk ? <label className="warehouse-outgoing-review-date">Ngày xuất<input type="date" value={shipDate} disabled={locked} onChange={(event) => setShipDate(event.target.value)} /></label> : null}
      <p className="muted small">{bulk
        ? "Bấm biểu tượng bút để sửa các lô lấy cho từng item. Khi xác nhận, số thực xuất được phân cho các đơn đã lọc theo ngày giao sớm trước."
        : "Gộp số còn phải giao của các yêu cầu đã lọc. Gợi ý dựa trên tồn hiện tại, chưa giữ lô hoặc trừ tồn."}</p>
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      {!review && !error ? <p role="status" className="muted">Đang tính FIFO…</p> : null}
      {bulk && submitted && notice ? <p className="alert" role="status">{notice}</p> : null}
      {review ? <>
        <p><strong>{num(review.rows.length)} item · {num(review.request_count)} yêu cầu chờ xuất</strong>{bulk ? ` · Chọn xuất ${num(chosenTotal)}` : ""}</p>
        {review.request_count < requestedCount ? <p className="alert" role="status">Một số yêu cầu không còn chờ xuất. Tải lại danh sách để cập nhật.</p> : null}
        {review.rows.length ? <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>Ngày xuất</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Số lượng cần xuất</th><th>Ngày sản xuất / Số lượng {bulk ? "chọn xuất" : "FIFO"}</th><th>{bulk ? "Còn lại sau xuất" : "Còn thiếu"}</th>{bulk ? <th>Sửa lô</th> : null}</tr></thead>
          <tbody>{review.rows.map((row) => {
            const selection = bulkData ? summarize(lotsFor(bulkData, row.itemcode), picked.get(row.itemcode) ?? {}) : null;
            const days = selection?.days ?? row.days;
            const missing = selection ? row.quantity - selection.quantity : row.shortage_qty;
            return <tr key={row.itemcode} className={missing > 0 ? "warehouse-outgoing-shortage" : undefined}>
              <td>{shipDate ? formatDate(shipDate) : "—"}</td><td>{row.itemcode}</td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td className="warehouse-review-number">{num(row.quantity)}</td>
              <td>{days.length ? <ul className="warehouse-outgoing-review-days">{days.map((day) =>
                <li key={day.production_date ?? "undated"}><span>{productionDate(day.production_date)}</span><strong>{num(day.quantity)}</strong></li>)
              }</ul> : bulk && bulkData && lotsFor(bulkData, row.itemcode).length ? "Chưa chọn lô" : "Không có tồn"}</td>
              <td className="warehouse-review-number">{num(missing)}</td>
              {bulk ? <td><button type="button" className="button button-secondary button-small warehouse-stock-eye" title="Sửa lô xuất"
                aria-label={`Sửa lô xuất ${row.itemcode}`} disabled={locked || !bulkData || !lotsFor(bulkData, row.itemcode).length} onClick={() => editLots(row)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="m15 5 4 4M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20Z" />
                </svg>
              </button></td> : null}
            </tr>;
          })}</tbody>
        </table></div> : <p className="scan-empty">Không còn yêu cầu chờ xuất trong kết quả đã lọc.</p>}
      </> : null}
      {copied ? <p className="muted small" role="status">{copied}</p> : null}
      <div className="modal-actions">
        <button className="button button-secondary" type="button" disabled={bulk && busy} onClick={() => dialog.current?.close()}>Đóng</button>
        {!bulk ? <button className="button button-primary" type="button" disabled={!review?.rows.length} onClick={() => { void copyReview(); }}>Copy</button>
          : onBulkRetry && submitted ? <button className="button button-primary" type="button" disabled={busy} onClick={async () => { if (await onBulkRetry()) dialog.current?.close(); }}>Thử lại thao tác</button>
            : <button className="button button-primary" type="button" disabled={locked || !bulkData || !chosenTotal || !isInventoryDate(shipDate)}
              onClick={() => { void confirmBulk(); }}>Xác nhận xuất hàng loạt</button>}
      </div>
    </dialog>
    <dialog aria-labelledby={editorTitle} className="modal-card warehouse-opening-dialog warehouse-lot-editor" ref={editor} onClose={() => setEditing(null)}>
      <div className="modal-heading">
        <h2 id={editorTitle}>Chọn lô xuất {editing?.itemcode}</h2>
        <button aria-label="Đóng chọn lô" className="modal-close" type="button" onClick={() => editor.current?.close()}>×</button>
      </div>
      {editing ? <>
        <p className="muted small">Bỏ tick để không lấy lô. Nhập số lượng nhỏ hơn tồn lô để chỉ lấy một phần.</p>
        <p>Cần xuất <strong>{num(editing.quantity)}</strong> · Đã chọn <strong>{num(draftTotal)}</strong></p>
        {invalidDraft ? <p role="alert" className="alert alert-error">Số lấy phải là số nguyên, trong giới hạn tồn từng lô và tổng cần xuất.</p> : null}
        <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>Chọn</th><th>Lô nhập</th><th>Ngày sản xuất</th><th>Ngày nhập</th><th>Tồn lô</th><th>Số lượng lấy</th></tr></thead>
          <tbody>{editorLots.map((lot) => {
            const amount = draft[lot.incoming_id] ?? 0;
            return <tr key={lot.incoming_id}>
              <td><input aria-label={`Chọn lô ${lot.incoming_id}`} type="checkbox" checked={amount > 0}
                disabled={amount === 0 && draftTotal >= editing.quantity}
                onChange={(event) => setDraft({ ...draft, [lot.incoming_id]: event.target.checked ? Math.min(lot.balance_qty, editing.quantity - draftTotal) : 0 })} /></td>
              <td>#{lot.incoming_id}</td><td>{productionDate(lot.production_date)}</td><td>{formatDate(lot.received_date)}</td><td>{num(lot.balance_qty)}</td>
              <td><input aria-label={`Số lượng lấy lô ${lot.incoming_id}`} type="number" min={0} max={lot.balance_qty} step={1} value={amount}
                onChange={(event) => setDraft({ ...draft, [lot.incoming_id]: Number(event.target.value) })} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={() => setDraft(suggest(editorLots, editing.quantity))}>Khôi phục FIFO</button>
          <button className="button button-primary" type="button" disabled={invalidDraft}
            onClick={() => { setPicked((old) => new Map(old).set(editing.itemcode, draft)); editor.current?.close(); }}>Lưu lựa chọn</button>
        </div>
      </> : null}
    </dialog>
  </>;
}
