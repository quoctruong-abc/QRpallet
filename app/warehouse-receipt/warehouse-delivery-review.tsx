"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isInventoryDate, todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import { renderReviewImage } from "@/lib/warehouse-receipt/review-image";
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
  const byDate = new Map<string | null, { quantity: number; lots: { id: string; quantity: number }[] }>();
  let quantity = 0;
  for (const lot of lots) {
    const amount = picks[lot.incoming_id] ?? 0;
    if (amount <= 0) continue;
    const day = byDate.get(lot.production_date) ?? { quantity: 0, lots: [] };
    day.quantity += amount;
    day.lots.push({ id: lot.incoming_id, quantity: amount });
    byDate.set(lot.production_date, day);
    quantity += amount;
  }
  return { quantity, byDate, days: Array.from(byDate, ([production_date, day]) => ({ production_date, quantity: day.quantity })) };
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
  const selectAll = useRef<HTMLInputElement>(null);
  const [shipDate, setShipDate] = useState(todayInVietnam);
  const [review, setReview] = useState<DeliveryFifoReview | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkData, setBulkData] = useState<BulkDeliveryPreview | null>(null);
  const [picked, setPicked] = useState<Map<string, PickAmounts>>(new Map());
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ReviewRow | null>(null);
  const [draft, setDraft] = useState<PickAmounts>({});
  const [requestedCount, setRequestedCount] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [copying, setCopying] = useState(false);
  const [savedLots, setSavedLots] = useState("");
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
    setIncluded(new Set());
    setError("");
    setCopied("");
    setSavedLots("");
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
        setIncluded(new Set(result.rows.map((row) => row.itemcode)));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Không tải được gợi ý FIFO.");
    }
  }

  async function copyReview() {
    if (!review?.rows.length || copying) return;
    const columns = ["Ngày giao", "Itemcode", "Tên sản phẩm", "Khách hàng", "Số lượng cần xuất", "Ngày sản xuất / Số lượng FIFO", "Còn thiếu"];
    setCopying(true);
    setCopied("");
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Trình duyệt chưa hỗ trợ sao chép ảnh vào clipboard.");
      }
      const rows = review.rows.map((row) => ({ shortage: row.shortage_qty > 0, cells: [
        row.delivery_dates?.map(formatDate).join("\n") || "—", row.itemcode, row.product_name || "—", row.customer || "—", num(row.quantity),
        row.days.map((day) => `${productionDate(day.production_date)}: ${num(day.quantity)}`).join("\n") || "Không có tồn", num(row.shortage_qty),
      ] }));
      const png = renderReviewImage(columns, rows, "Review xuất kho theo FIFO", `${num(rows.length)} item · ${num(review.request_count)} yêu cầu chờ xuất`);
      await Promise.all([png, navigator.clipboard.write([new ClipboardItem({ "image/png": png })])]);
      setCopied("Đã sao chép ảnh bảng.");
    } catch (cause) {
      setCopied(cause instanceof Error && !(cause instanceof DOMException) ? cause.message
        : "Không sao chép được ảnh. Kiểm tra quyền clipboard của trình duyệt.");
    } finally { setCopying(false); }
  }

  function editLots(row: ReviewRow) {
    setEditing(row);
    setDraft({ ...picked.get(row.itemcode) });
    editor.current?.showModal();
  }

  const editorLots = editing && bulkData ? lotsFor(bulkData, editing.itemcode) : [];
  const draftTotal = Object.values(draft).reduce((total, qty) => total + qty, 0);
  const draftExcess = Math.max(0, draftTotal - (editing?.quantity ?? 0));
  const invalidDraft = !editing || editorLots.some((lot) => {
    const amount = draft[lot.incoming_id] ?? 0;
    return !Number.isInteger(amount) || amount < 0 || amount > lot.balance_qty;
  });
  const selectionByItem = new Map(bulkData?.rows.map((row) => [
    row.itemcode, summarize(lotsFor(bulkData, row.itemcode), picked.get(row.itemcode) ?? {}),
  ]));
  const selectedRows = bulkData?.rows.filter((row) => included.has(row.itemcode)) ?? [];
  const chosenTotal = selectedRows.reduce((total, row) => total + (selectionByItem.get(row.itemcode)?.quantity ?? 0), 0);
  const excessRows = selectedRows.filter((row) => (selectionByItem.get(row.itemcode)?.quantity ?? 0) > row.quantity);
  const shortSelectedCount = selectedRows.filter((row) => row.shortage_qty > 0).length;
  const allSelected = Boolean(bulkData?.rows.length && included.size === bulkData.rows.length);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = included.size > 0 && !allSelected;
  }, [included.size, allSelected]);

  function saveLotSelection() {
    if (!editing || invalidDraft) return;
    const itemcode = editing.itemcode;
    const saved = Object.fromEntries(Object.entries(draft).filter(([, amount]) => amount > 0));
    setPicked((old) => new Map(old).set(itemcode, saved));
    const balance = draftExcess ? `vượt yêu cầu ${num(draftExcess)}` : `còn lại ${num(editing.quantity - draftTotal)}`;
    setSavedLots(`Đã lưu lô cho ${itemcode}: chọn xuất ${num(draftTotal)}, ${balance}.`);
    editor.current?.close();
  }

  async function confirmBulk() {
    if (!bulkData || locked || !isInventoryDate(shipDate) || !chosenTotal || shortSelectedCount) return;
    const itemcodes = new Set<string>();
    const lots: BulkDeliveryInput["lots"] = [];
    for (const [itemcode, amounts] of picked) {
      if (!included.has(itemcode)) continue;
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
    <dialog aria-labelledby={titleId} className={`modal-card warehouse-opening-dialog warehouse-outgoing-review-dialog${bulk ? " warehouse-bulk-dialog" : ""}`}
      ref={dialog} onClose={() => request.current?.abort()} onCancel={(event) => { if (bulk && busy) event.preventDefault(); }}>
      <header className={bulk ? "warehouse-bulk-header" : undefined}>
        <div className="modal-heading">
          <h2 id={titleId}>{bulk ? "Xuất hàng loạt" : "Review xuất kho theo FIFO"}</h2>
          <button aria-label={bulk ? "Đóng xuất hàng loạt" : "Đóng Review"} className="modal-close" disabled={bulk && busy} onClick={() => dialog.current?.close()} type="button">×</button>
        </div>
        {bulk ? <div className="warehouse-bulk-meta">
          <label>Ngày xuất<input type="date" value={shipDate} disabled={locked} onChange={(event) => setShipDate(event.target.value)} /></label>
          {review ? <p className="muted">
            {num(review.request_count)} yêu cầu chờ xuất · Đã chọn {num(included.size)}/{num(review.rows.length)} item · <strong>Chọn xuất {num(chosenTotal)}</strong>
          </p> : null}
        </div> : null}
      </header>
      <div className={bulk ? "warehouse-bulk-body" : undefined}>
        {!bulk ? <p className="muted small">Gộp số còn phải giao của các yêu cầu đã lọc. Gợi ý dựa trên tồn hiện tại, chưa giữ lô hoặc trừ tồn.</p> : null}
        {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
        {!review && !error ? <p role="status" className="muted">Đang tính FIFO…</p> : null}
        {bulk && submitted && notice ? <p className="alert" role="status">{notice}</p> : null}
        {bulk && savedLots ? <p className="muted small" role="status">{savedLots}</p> : null}
        {review ? <>
          {!bulk ? <p><strong>{num(review.rows.length)} item · {num(review.request_count)} yêu cầu chờ xuất</strong></p> : null}
          {review.request_count < requestedCount ? <p className="alert" role="status">Một số yêu cầu không còn chờ xuất. Tải lại danh sách để cập nhật.</p> : null}
          {review.rows.length ? <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
            <thead><tr>{bulk ? <th><input type="checkbox" ref={selectAll} aria-label="Chọn tất cả item xuất"
              checked={allSelected} disabled={locked || !bulkData}
              onChange={(event) => { setIncluded(new Set(event.target.checked ? bulkData?.rows.map((row) => row.itemcode) : [])); }} /></th> : null}
            <th>{bulk ? "Ngày xuất" : "Ngày giao"}</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Số lượng cần xuất</th>{bulk ? <th>Chọn xuất</th> : null}<th>Ngày sản xuất / Số lượng {bulk ? "chọn xuất" : "FIFO"}</th><th>{bulk ? "Còn lại sau xuất" : "Còn thiếu"}</th>{bulk ? <th>Sửa lô</th> : null}</tr></thead>
            <tbody>{review.rows.map((row) => {
              const selection = selectionByItem.get(row.itemcode);
              const checked = included.has(row.itemcode);
              const days = selection?.days ?? row.days;
              const missing = selection ? Math.max(0, row.quantity - selection.quantity) : row.shortage_qty;
              const excess = Math.max(0, (selection?.quantity ?? 0) - row.quantity);
              const rowClass = bulk && !checked ? "warehouse-bulk-unselected"
                : bulk && row.shortage_qty > 0 ? "warehouse-bulk-short"
                  : missing > 0 || excess > 0 ? "warehouse-outgoing-shortage" : undefined;
              return <tr key={row.itemcode} className={rowClass}>
                {bulk ? <td><input type="checkbox" aria-label={`Chọn xuất ${row.itemcode}`} checked={checked} disabled={locked}
                  onChange={(event) => {
                    const nextChecked = event.target.checked;
                    setIncluded((old) => {
                      const next = new Set(old);
                      if (nextChecked) next.add(row.itemcode);
                      else next.delete(row.itemcode);
                      return next;
                    });
                  }} /></td> : null}
                <td>{bulk ? (shipDate ? formatDate(shipDate) : "—") : row.delivery_dates?.length ? row.delivery_dates.map((value) =>
                  <div className="warehouse-receipt-date" key={value}>{formatDate(value)}</div>) : "—"}</td>
                <td>{row.itemcode}</td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td className="warehouse-review-number">{num(row.quantity)}</td>
                {bulk ? <td className="warehouse-review-number"><strong>{num(selection?.quantity ?? 0)}</strong>
                  {excess > 0 && checked ? <small className="warehouse-bulk-overage">Vượt {num(excess)}</small> : null}
                </td> : null}
                <td>{days.length ? <ul className="warehouse-outgoing-review-days">{days.map((day) =>
                  <li key={day.production_date ?? "undated"}>
                    <span>{productionDate(day.production_date)}
                      {selection ? <small className="warehouse-review-lot-ids">{selection.byDate.get(day.production_date)?.lots
                        .map((lot) => `#${lot.id}: ${num(lot.quantity)}`).join(" · ")}</small> : null}
                    </span><strong>{num(day.quantity)}</strong>
                  </li>)
                }</ul> : bulk && bulkData && lotsFor(bulkData, row.itemcode).length ? "Chưa chọn lô" : "Không có tồn"}</td>
                <td className="warehouse-review-number">{num(missing)}
                  {bulk && row.shortage_qty > 0 ? <small className="warehouse-bulk-stock-shortage">Tồn thiếu {num(row.shortage_qty)}</small> : null}
                </td>
                {bulk ? <td><button type="button" className="button button-secondary button-small warehouse-stock-eye" title="Sửa lô xuất"
                  aria-label={`Sửa lô xuất ${row.itemcode}`} disabled={locked || !checked || !bulkData || !lotsFor(bulkData, row.itemcode).length} onClick={() => editLots(row)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="m15 5 4 4M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20Z" />
                  </svg>
                </button></td> : null}
              </tr>;
            })}</tbody>
          </table></div> : <p className="scan-empty">Không còn yêu cầu chờ xuất trong kết quả đã lọc.</p>}
        </> : null}
        {copied ? <p className="muted small" role="status">{copied}</p> : null}
      </div>
      <footer className={bulk ? "warehouse-bulk-footer" : undefined}>
        {bulk && shortSelectedCount > 0 ? <p className="alert alert-error" role="alert">
          {num(shortSelectedCount)} item đang chọn không đủ tồn kho. Bỏ tick các dòng có nhãn “Tồn thiếu” để tiếp tục.
        </p> : null}
        {bulk && excessRows.length ? <p className="alert warehouse-bulk-warning" role="alert">
          {num(excessRows.length)} item đã chọn vượt số còn phải giao. Phần vượt sẽ ghi vào yêu cầu cuối của item theo thứ tự giao.
        </p> : null}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" disabled={bulk && busy} onClick={() => dialog.current?.close()}>Đóng</button>
          {!bulk ? <button className="button button-primary" type="button" disabled={copying || !review?.rows.length} onClick={() => { void copyReview(); }}>{copying ? "Đang tạo ảnh…" : "Copy ảnh"}</button>
            : onBulkRetry && submitted ? <button className="button button-primary" type="button" disabled={busy} onClick={async () => { if (await onBulkRetry()) dialog.current?.close(); }}>Thử lại thao tác</button>
              : <button className="button button-primary" type="button" disabled={locked || !bulkData || !chosenTotal || shortSelectedCount > 0 || !isInventoryDate(shipDate)}
                onClick={() => { void confirmBulk(); }}>Xác nhận xuất hàng loạt</button>}
        </div>
      </footer>
    </dialog>
    <dialog aria-labelledby={editorTitle} className="modal-card warehouse-opening-dialog warehouse-lot-editor" ref={editor} onClose={() => setEditing(null)}>
      <div className="modal-heading">
        <h2 id={editorTitle}>Chọn lô xuất {editing?.itemcode}</h2>
        <button aria-label="Đóng chọn lô" className="modal-close" type="button" onClick={() => editor.current?.close()}>×</button>
      </div>
      {editing ? <>
        <p className="muted small">Bỏ tick để không lấy lô. Nhập số lượng nhỏ hơn tồn lô để chỉ lấy một phần.</p>
        <p>Cần xuất <strong>{num(editing.quantity)}</strong> · Đã chọn <strong>{num(draftTotal)}</strong></p>
        {invalidDraft ? <p role="alert" className="alert alert-error">Số lấy phải là số nguyên và không vượt tồn từng lô.</p> : null}
        {draftExcess > 0 && !invalidDraft ? <p role="alert" className="alert warehouse-bulk-warning">Đã vượt số lượng cần xuất: {num(draftExcess)}.</p> : null}
        <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>Chọn</th><th>Lô nhập</th><th>Ngày sản xuất</th><th>Ngày nhập</th><th>Tồn lô</th><th>Số lượng lấy</th></tr></thead>
          <tbody>{editorLots.map((lot) => {
            const amount = draft[lot.incoming_id] ?? 0;
            return <tr key={lot.incoming_id}>
              <td><input aria-label={`Chọn lô ${lot.incoming_id}`} type="checkbox" checked={amount > 0}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setDraft((old) => {
                    const total = Object.values(old).reduce((sum, value) => sum + value, 0);
                    const remaining = editing.quantity - total;
                    return { ...old, [lot.incoming_id]: checked ? (remaining > 0 ? Math.min(lot.balance_qty, remaining) : lot.balance_qty) : 0 };
                  });
                }} /></td>
              <td>#{lot.incoming_id}</td><td>{productionDate(lot.production_date)}</td><td>{formatDate(lot.received_date)}</td><td>{num(lot.balance_qty)}</td>
              <td><input aria-label={`Số lượng lấy lô ${lot.incoming_id}`} type="number" min={0} max={lot.balance_qty} step={1} value={amount}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setDraft((old) => ({ ...old, [lot.incoming_id]: value }));
                }} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={() => setDraft(suggest(editorLots, editing.quantity))}>Khôi phục FIFO</button>
          <button className="button button-primary" type="button" disabled={invalidDraft}
            onClick={saveLotSelection}>Lưu lựa chọn</button>
        </div>
      </> : null}
    </dialog>
  </>;
}
