"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { isInventoryDate, todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import { renderReviewImage } from "@/lib/warehouse-receipt/review-image";
import { analyzeDeliveryGroups, componentPickKey, suggestDeliveryGroups, type DeliveryGroup, type GroupPicks, type PickAmounts } from "@/lib/warehouse-receipt/delivery-groups";
import type { BulkDeliveryInput, BulkDeliveryLot, BulkDeliveryPreview, DeliveryFifoReview, DeliveryRequest, DeliveryReviewComponent } from "@/lib/warehouse-receipt/outgoing";
import { WarehouseActionConfirmation } from "./warehouse-action-confirmation";

const num = (qty: number) => qty.toLocaleString("vi-VN");
const formatDate = (date: string) => date.split("-").reverse().join("/");
const productionDate = (date: string | null) => date ? formatDate(date) : "Không có ngày sản xuất";
const lotsFor = (data: BulkDeliveryPreview, item: string) => Object.hasOwn(data.lots, item) ? data.lots[item] : [];

function suggest(lots: BulkDeliveryLot[], quantity: number): PickAmounts {
  const result: PickAmounts = {};
  for (const lot of lots) {
    if (quantity <= 0) break;
    const amount = Math.min(lot.balance_qty, quantity);
    if (amount > 0) result[lot.incoming_id] = amount;
    quantity -= amount;
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
  canEdit: boolean;
  requests: DeliveryRequest[]; disabled: boolean; locked: boolean; busy: boolean; notice: string;
  onBulkShip: (payload: BulkDeliveryInput) => Promise<boolean>; onBulkRetry?: () => Promise<boolean>;
};
type Editing = { group: DeliveryGroup; component: DeliveryReviewComponent };

export function WarehouseDeliveryReview({ requests, disabled, locked, busy, notice, onBulkShip, onBulkRetry, canEdit }: Props) {
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
  const [picked, setPicked] = useState<GroupPicks>(new Map());
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState<PickAmounts>({});
  const [requestedCount, setRequestedCount] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [copying, setCopying] = useState(false);
  const [savedLots, setSavedLots] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [confirmation, setConfirmation] = useState<"post" | "retry" | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const hasParents = review?.rows.some((row) => row.request_type === "parent") ?? false;

  async function openReview(forBulk: boolean) {
    if (forBulk && !canEdit) return;
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
    setConfirmation(null);
    dialog.current?.showModal();
    try {
      const response = await fetch("/api/warehouse-receipt/outgoing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: forBulk ? "bulk_preview" : "review", request_ids: ids }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không tải được gợi ý FIFO.");
      if (data.group_model_version !== 1) throw new Error("Cần cập nhật database để xuất theo mã mẹ.");
      if (controller.signal.aborted) return;
      setReview(data);
      if (forBulk) {
        const result = data as BulkDeliveryPreview;
        const selected = new Set(result.rows.map((row) => row.group_key));
        setBulkData(result);
        setPicked(suggestDeliveryGroups(result, selected));
        setIncluded(selected);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Không tải được gợi ý FIFO.");
    }
  }

  async function copyReview() {
    if (!review?.rows.length || copying) return;
    setCopying(true);
    setCopied("");
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Trình duyệt chưa hỗ trợ sao chép ảnh vào clipboard.");
      const columns = ["Ngày giao", "Itemcode", "Tên sản phẩm", "Khách hàng", "Số lượng cần xuất", "Ngày sản xuất / Số lượng FIFO", "Còn thiếu"];
      const rows = review.rows.flatMap((group) => {
        const parent = group.request_type === "parent";
        const row = { shortage: group.sync_error || group.shortage_qty > 0, cells: [
          group.delivery_dates?.map(formatDate).join("\n") || "—",
          parent ? `${group.itemcode} (mã mẹ)` : group.itemcode, group.product_name || "—", group.customer || "—", num(group.quantity),
          parent ? "Chi tiết mã con bên dưới" : group.days.map((day) => `${productionDate(day.production_date)}: ${num(day.quantity)}`).join("\n") || "Không có tồn",
          group.sync_error ? "Lệch số lượng mã con" : num(group.shortage_qty),
        ] };
        return parent ? [row, ...group.components.map((component) => ({
          shortage: group.sync_error || component.shortage_qty > 0,
          cells: ["", `↳ ${component.itemcode}`, component.product_name || "—", component.customer || "—", num(component.quantity),
            component.days.map((day) => `${productionDate(day.production_date)}: ${num(day.quantity)}`).join("\n") || "Không có tồn",
            num(component.shortage_qty)],
        }))] : [row];
      });
      const png = renderReviewImage(columns, rows, "Review xuất kho theo FIFO", `${num(review.rows.length)} item · ${num(review.request_count)} yêu cầu chờ xuất`);
      await Promise.all([png, navigator.clipboard.write([new ClipboardItem({ "image/png": png })])]);
      setCopied("Đã sao chép ảnh bảng.");
    } catch (cause) {
      setCopied(cause instanceof Error && !(cause instanceof DOMException) ? cause.message : "Không sao chép được ảnh. Kiểm tra quyền clipboard của trình duyệt.");
    } finally { setCopying(false); }
  }

  function editLots(group: DeliveryGroup, component: DeliveryReviewComponent) {
    setEditing({ group, component });
    setDraft({ ...picked.get(componentPickKey(group, component.itemcode)) });
    editor.current?.showModal();
  }
  const editorKey = editing ? componentPickKey(editing.group, editing.component.itemcode) : "";
  const editorLots = editing && bulkData ? lotsFor(bulkData, editing.component.itemcode).map((lot) => {
    let used = 0;
    for (const group of bulkData.rows) {
      if (!included.has(group.group_key)) continue;
      for (const component of group.components) {
        const key = componentPickKey(group, component.itemcode);
        if (key !== editorKey) used += picked.get(key)?.[lot.incoming_id] ?? 0;
      }
    }
    return { ...lot, balance_qty: Math.max(0, lot.balance_qty - used) };
  }) : [];
  const draftTotal = Object.values(draft).reduce((total, qty) => total + qty, 0);
  const draftExcess = Math.max(0, draftTotal - (editing?.component.quantity ?? 0));
  const invalidDraft = !editing || editorLots.some((lot) => {
    const amount = draft[lot.incoming_id] ?? 0;
    return !Number.isInteger(amount) || amount < 0 || amount > lot.balance_qty;
  });
  const analysis = bulkData ? analyzeDeliveryGroups(bulkData, picked, included) : null;
  const selectedRows = bulkData?.rows.filter((row) => included.has(row.group_key)) ?? [];
  const executableRows = selectedRows.filter((group) => (analysis?.groups.get(group.group_key)?.quantity ?? 0) > 0);
  const chosenTotal = selectedRows.reduce((total, row) => {
    const state = analysis?.groups.get(row.group_key);
    return total + (state && !state.mismatch ? state.quantity : 0);
  }, 0);
  const shortSelectedCount = selectedRows.filter((row) => analysis?.groups.get(row.group_key)?.short).length;
  const mismatchCount = selectedRows.filter((row) => row.request_type === "parent" && analysis?.groups.get(row.group_key)?.mismatch).length;
  const excessCount = selectedRows.filter((row) => {
    const state = analysis?.groups.get(row.group_key);
    return state && !state.mismatch && state.quantity > row.quantity;
  }).length;
  const allSelected = Boolean(bulkData?.rows.length && included.size === bulkData.rows.length);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = included.size > 0 && !allSelected;
  }, [included.size, allSelected]);

  function saveLotSelection() {
    if (!editing || invalidDraft) return;
    const saved = Object.fromEntries(Object.entries(draft).filter(([, amount]) => amount > 0));
    setPicked((old) => new Map(old).set(editorKey, saved));
    setSavedLots(editing.group.request_type === "parent"
      ? `Đã lưu ${editing.component.itemcode} của ${editing.group.itemcode}: chọn xuất ${num(draftTotal)}. Các mã con phải cùng số lượng quy đổi về mã mẹ.`
      : `Đã lưu lô cho ${editing.component.itemcode}: chọn xuất ${num(draftTotal)}, ${draftExcess ? `vượt yêu cầu ${num(draftExcess)}` : `còn lại ${num(editing.component.quantity - draftTotal)}`}.`);
    editor.current?.close();
  }
  async function confirmBulk() {
    if (!canEdit || !bulkData || locked || !isInventoryDate(shipDate) || !analysis?.canProceed) return;
    const lots: BulkDeliveryInput["lots"] = [];
    const executable = selectedRows.filter((group) => (analysis.groups.get(group.group_key)?.quantity ?? 0) > 0);
    const executableKeys = new Set(executable.map((group) => group.group_key));
    for (const group of executable) for (const component of group.components) {
      for (const [incoming_id, quantity] of Object.entries(picked.get(componentPickKey(group, component.itemcode)) ?? {})) {
        if (quantity > 0) lots.push({ incoming_id, quantity, group_key: group.group_key });
      }
    }
    const selected = bulkData.requests.filter((row) => executableKeys.has(row.group_key)).map(({ id, version, components }) => ({ id, version, components }));
    setSubmitted(true);
    if (await onBulkShip({ group_model_version: 1, shipped_date: shipDate, requests: selected, lots })) dialog.current?.close();
  }

  return <>
    <button className="button button-secondary" type="button" disabled={disabled || !requests.length} onClick={() => { void openReview(false); }}>Review</button>
    {canEdit ? <button className="button button-primary" type="button" disabled={disabled || locked || !requests.length} onClick={() => { void openReview(true); }}>Xuất hàng loạt</button> : null}
    <dialog aria-labelledby={titleId} className={`modal-card warehouse-opening-dialog warehouse-outgoing-review-dialog${bulk ? " warehouse-bulk-dialog" : ""}`}
      ref={dialog} onClose={() => request.current?.abort()} onCancel={(event) => { if (bulk && busy) event.preventDefault(); }}>
      <header className={bulk ? "warehouse-bulk-header" : undefined}>
        <div className="modal-heading">
          <h2 id={titleId}>{bulk ? "Xuất hàng loạt" : "Review xuất kho theo FIFO"}</h2>
          <button aria-label="Đóng" className="modal-close" disabled={bulk && busy} onClick={() => dialog.current?.close()} type="button">×</button>
        </div>
        {bulk ? <div className="warehouse-bulk-meta">
          <label>Ngày xuất<input type="date" value={shipDate} disabled={locked} onChange={(event) => setShipDate(event.target.value)} /></label>
          {review ? <p className="muted">{num(review.request_count)} yêu cầu chờ xuất · Đã chọn {num(included.size)}/{num(review.rows.length)} item · <strong>Chọn xuất {num(chosenTotal)}</strong></p> : null}
          {hasParents ? <button className="button button-secondary button-small" type="button" disabled={locked || !bulkData || !included.size}
            onClick={() => { if (bulkData) { setPicked(suggestDeliveryGroups(bulkData, included)); setSavedLots("Đã khôi phục FIFO cho các nhóm đang chọn."); } }}>Khôi phục FIFO đã chọn</button> : null}
        </div> : null}
      </header>
      <div className={bulk ? "warehouse-bulk-body" : undefined}>
        {!bulk ? <p className="muted small">Gộp số còn phải giao của các yêu cầu đã lọc. Gợi ý dựa trên tồn hiện tại, chưa giữ lô hoặc trừ tồn.</p> : null}
        {hasParents ? <p className="muted small">Riêng mã mẹ: chọn cả tổ hợp, các mã con phải xuất đồng bộ theo tỷ lệ ghép cặp.</p> : null}
        {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
        {!review && !error ? <p role="status" className="muted">Đang tính FIFO…</p> : null}
        {bulk && submitted && notice ? <p className="alert" role="status">{notice}</p> : null}
        {bulk && savedLots ? <p className="muted small" role="status">{savedLots}</p> : null}
        {review && review.request_count < requestedCount ? <p className="alert" role="status">Một số yêu cầu không còn chờ xuất. Tải lại danh sách để cập nhật.</p> : null}
        {!bulk && review ? <p><strong>{num(review.rows.length)} item · {num(review.request_count)} yêu cầu chờ xuất</strong></p> : null}
        {review?.rows.length ? <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr>{bulk ? <th><input type="checkbox" ref={selectAll} aria-label="Chọn tất cả item xuất" checked={allSelected} disabled={locked}
            onChange={(event) => setIncluded(new Set(event.target.checked ? bulkData?.rows.map((row) => row.group_key) : []))} /></th> : null}
            <th>{bulk ? "Ngày xuất" : "Ngày giao"}</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Số lượng cần xuất</th>
            {bulk ? <th>Chọn xuất</th> : null}<th>Ngày sản xuất / Số lượng {bulk ? "chọn xuất" : "FIFO"}</th>
            <th>{bulk ? "Còn lại sau xuất" : "Còn thiếu"}</th>{bulk ? <th>Sửa lô</th> : null}</tr></thead>
          <tbody>{review.rows.map((group) => {
            const parent = group.request_type === "parent";
            const state = analysis?.groups.get(group.group_key);
            const checked = included.has(group.group_key);
            const directComponent = !parent ? group.components[0] : null;
            const selection = bulkData && directComponent
              ? summarize(lotsFor(bulkData, directComponent.itemcode), picked.get(componentPickKey(group, directComponent.itemcode)) ?? {}) : null;
            const days = selection?.days ?? group.days;
            const excess = state && !state.mismatch ? Math.max(0, state.quantity - group.quantity) : 0;
            const rowClass = bulk && !checked ? "warehouse-bulk-unselected"
              : group.sync_error || (bulk && (state?.short || state?.mismatch)) ? "warehouse-bulk-short"
                : group.shortage_qty > 0 || excess > 0 ? "warehouse-outgoing-shortage" : undefined;
            return <Fragment key={group.group_key}>
              <tr className={rowClass}>
                {bulk ? <td><input type="checkbox" aria-label={parent ? `Chọn xuất ${group.itemcode} ${group.group_key}` : `Chọn xuất ${group.itemcode}`} checked={checked} disabled={locked}
                  onChange={(event) => { const value = event.target.checked; setIncluded((old) => {
                    const next = new Set(old); if (value) next.add(group.group_key); else next.delete(group.group_key); return next;
                  }); }} /></td> : null}
                <td>{bulk ? (shipDate ? formatDate(shipDate) : "—") : group.delivery_dates?.map((value) => <div key={value}>{formatDate(value)}</div>)}</td>
                <td>{parent ? <><strong>{group.itemcode}</strong><small className="warehouse-review-lot-ids">Mã mẹ</small>
                  {group.sync_error || (bulk && checked && state?.mismatch) ? <small className="warehouse-bulk-stock-shortage">Mã con không đồng bộ</small> : null}</> : group.itemcode}</td>
                <td>{group.product_name || "—"}</td><td>{group.customer || "—"}</td><td className="warehouse-review-number">{num(group.quantity)}</td>
                {bulk ? <td className="warehouse-review-number"><strong>{state?.mismatch ? "Chưa đồng bộ" : num(state?.quantity ?? 0)}</strong>
                  {checked && excess > 0 ? <small className="warehouse-bulk-overage">Vượt {num(excess)}</small> : null}</td> : null}
                <td>{parent ? "Chi tiết mã con bên dưới" : days.length ? <ul className="warehouse-outgoing-review-days">
                  {days.map((day) => <li key={day.production_date ?? "undated"}><span>{productionDate(day.production_date)}
                    {selection ? <small className="warehouse-review-lot-ids">{selection.byDate.get(day.production_date)?.lots
                      .map((lot) => `#${lot.id}: ${num(lot.quantity)}`).join(" · ")}</small> : null}
                  </span><strong>{num(day.quantity)}</strong></li>)}
                </ul> : bulk && bulkData && lotsFor(bulkData, group.itemcode).length ? "Chưa chọn lô" : "Không có tồn"}</td>
                <td className="warehouse-review-number">{bulk ? state?.mismatch ? "—" : num(Math.max(0, group.quantity - (state?.quantity ?? 0))) : num(group.shortage_qty)}
                  {bulk && state?.short ? <small className="warehouse-bulk-stock-shortage">{parent ? "Mã con thiếu tồn"
                    : group.shortage_qty > 0 ? `Tồn thiếu ${num(group.shortage_qty)}` : "Tồn thiếu khi tính chung các item đang chọn"}</small> : null}
                </td>
                {bulk ? <td>{parent ? "Sửa từng mã con bên dưới" : directComponent ? <button type="button"
                  className="button button-secondary button-small warehouse-stock-eye" title="Sửa lô xuất"
                  aria-label={`Sửa lô xuất ${group.itemcode}`} disabled={locked || !checked || !bulkData || !lotsFor(bulkData, group.itemcode).length}
                  onClick={() => editLots(group, directComponent)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20Z" /></svg>
                </button> : null}</td> : null}
              </tr>
              {parent ? <tr className={rowClass}><td colSpan={bulk ? 10 : 7} className="warehouse-parent-components-cell">
                <table className="warehouse-table warehouse-parent-components" aria-label={`Mã thực xuất của ${group.itemcode}`}>
                  <thead><tr><th>Mã thực xuất</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Tỷ lệ / mã mẹ</th><th>Cần xuất</th>
                    {bulk ? <th>Chọn xuất</th> : null}<th>Ngày sản xuất / Số lượng {bulk ? "chọn" : "FIFO"}</th><th>{bulk ? "Còn lại" : "Thiếu"}</th>{bulk ? <th>Sửa lô</th> : null}</tr></thead>
                  <tbody>{group.components.map((component) => {
                    const selection = bulkData ? summarize(lotsFor(bulkData, component.itemcode), picked.get(componentPickKey(group, component.itemcode)) ?? {}) : null;
                    const days = selection?.days ?? component.days;
                    return <tr key={component.itemcode}>
                      <td>{component.itemcode}</td><td>{component.product_name || "—"}</td><td>{component.customer || "Chưa có tên khách hàng"}</td>
                      <td className="warehouse-review-number">{component.factor}</td><td className="warehouse-review-number">{num(component.quantity)}</td>
                      {bulk ? <td className="warehouse-review-number"><strong>{num(selection?.quantity ?? 0)}</strong></td> : null}
                      <td>{days.length ? <ul className="warehouse-outgoing-review-days">{days.map((day) => <li key={day.production_date ?? "undated"}>
                        <span>{productionDate(day.production_date)}{selection ? <small className="warehouse-review-lot-ids">
                          {selection.byDate.get(day.production_date)?.lots.map((lot) => `#${lot.id}: ${num(lot.quantity)}`).join(" · ")}</small> : null}</span><strong>{num(day.quantity)}</strong>
                      </li>)}</ul> : "Chưa có lô xuất"}</td>
                      <td className="warehouse-review-number">{num(selection ? Math.max(0, component.quantity - selection.quantity) : component.shortage_qty)}</td>
                      {bulk ? <td><button type="button" className="button button-secondary button-small"
                        aria-label={`Sửa lô ${component.itemcode} của ${group.itemcode}`} disabled={locked || !checked || !bulkData || !lotsFor(bulkData, component.itemcode).length}
                        onClick={() => editLots(group, component)}>✎ Sửa lô</button></td> : null}
                    </tr>;
                  })}</tbody>
                </table>
              </td></tr> : null}
            </Fragment>;
          })}</tbody>
        </table></div> : review ? <p className="scan-empty">Không còn yêu cầu chờ xuất trong kết quả đã lọc.</p> : null}
        {copied ? <p className="muted small" role="status">{copied}</p> : null}
      </div>
      <footer className={bulk ? "warehouse-bulk-footer" : undefined}>
        {bulk && shortSelectedCount > 0 ? <p className="alert alert-error" role="alert">{num(shortSelectedCount)} item đang chọn không đủ tồn kho. Bỏ tick các dòng có nhãn “Tồn thiếu” hoặc “Mã con thiếu tồn” để tiếp tục.</p> : null}
        {bulk && mismatchCount > 0 ? <p className="alert alert-error" role="alert">{num(mismatchCount)} nhóm có số lượng mã con không đồng bộ. Số lượng mỗi mã con chia tỷ lệ phải bằng nhau và là số nguyên dương.</p> : null}
        {bulk && analysis?.overdrawn ? <p className="alert alert-error" role="alert">Các nhóm đang lấy trùng số lượng vượt tồn một lô. Chỉnh lô hoặc khôi phục FIFO đã chọn.</p> : null}
        {bulk && excessCount > 0 ? <p className="alert warehouse-bulk-warning" role="alert">{num(excessCount)} item đã chọn vượt số còn phải giao. Phần vượt sẽ ghi vào yêu cầu cuối của item theo thứ tự giao.{hasParents ? " Riêng mã mẹ, các mã con phải xuất vượt đồng bộ." : ""}</p> : null}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" disabled={bulk && busy} onClick={() => dialog.current?.close()}>Đóng</button>
          {!bulk ? <button className="button button-primary" type="button" disabled={copying || !review?.rows.length} onClick={() => { void copyReview(); }}>{copying ? "Đang tạo ảnh…" : "Copy ảnh"}</button>
            : onBulkRetry && submitted ? <button className="button button-primary" type="button" disabled={busy} onClick={() => setConfirmation("retry")}>Thử lại thao tác</button>
              : <button className="button button-primary" type="button" disabled={locked || !bulkData || !analysis?.canProceed || !isInventoryDate(shipDate)}
                onClick={() => { if (!locked && bulkData && analysis?.canProceed && isInventoryDate(shipDate)) setConfirmation("post"); }}>Xác nhận xuất hàng loạt</button>}
        </div>
      </footer>
    </dialog>
    <WarehouseActionConfirmation open={confirmation !== null}
      title={confirmation === "retry" ? "Xác nhận thử lại xuất hàng?" : "Xác nhận xuất hàng loạt?"}
      confirmLabel={confirmation === "retry" ? "Đồng ý thử lại" : "Đồng ý xuất hàng"} busy={busy}
      disabled={confirmation === "retry" ? !onBulkRetry : locked || !bulkData || !analysis?.canProceed || !isInventoryDate(shipDate)}
      onCancel={() => setConfirmation(null)} onConfirm={async () => {
        if (confirmation === "retry") { if (onBulkRetry && await onBulkRetry()) dialog.current?.close(); }
        else if (confirmation === "post") await confirmBulk();
        setConfirmation(null);
      }}>
      {confirmation === "retry" ? <p>Kiểm tra và tiếp tục thao tác xuất hàng đã lưu bằng cùng mã thao tác?</p> : <>
        <p>Ghi nhận xuất hàng và trừ tồn kho theo các mã, số lượng và lô đã chọn?</p>
        <p>Ngày xuất: <strong>{shipDate ? formatDate(shipDate) : "—"}</strong></p>
        <p><strong>{num(executableRows.length)}</strong> mã chọn xuất · Tổng số lượng <strong>{num(chosenTotal)}</strong></p>
        {executableRows.some((row) => row.request_type === "parent") ? <p className="muted small">Số lượng mã mẹ tính theo bộ; mã con sẽ xuất đồng bộ theo tỷ lệ đã chọn.</p> : null}
        {excessCount > 0 ? <p className="alert warehouse-bulk-warning" role="alert">Có {num(excessCount)} mã xuất vượt số lượng yêu cầu.</p> : null}
      </>}
    </WarehouseActionConfirmation>
    <dialog aria-labelledby={editorTitle} className="modal-card warehouse-opening-dialog warehouse-lot-editor" ref={editor} onClose={() => setEditing(null)}>
      <div className="modal-heading"><h2 id={editorTitle}>Chọn lô xuất {editing?.component.itemcode}{editing?.group.request_type === "parent" ? ` · ${editing.group.itemcode}` : ""}</h2>
        <button aria-label="Đóng chọn lô" className="modal-close" type="button" onClick={() => editor.current?.close()}>×</button></div>
      {editing ? <>
        <p className="muted small">{editing.group.request_type === "parent"
          ? `Tỷ lệ ${editing.component.factor} / mã mẹ. Tất cả mã con phải xuất đồng bộ. Tồn lô đã trừ phần chọn ở các nhóm khác.`
          : "Bỏ tick để không lấy lô. Nhập số lượng nhỏ hơn tồn lô để chỉ lấy một phần."}</p>
        <p>Cần xuất <strong>{num(editing.component.quantity)}</strong> · Đã chọn <strong>{num(draftTotal)}</strong>
          {editing.group.request_type === "parent" ? <> · Quy đổi mã mẹ <strong>{num(draftTotal / editing.component.factor)}</strong></> : null}</p>
        {invalidDraft ? <p role="alert" className="alert alert-error">Số lấy phải là số nguyên và không vượt tồn lô khả dụng.</p> : null}
        {draftExcess > 0 && !invalidDraft ? <p role="alert" className="alert warehouse-bulk-warning">Đã vượt số lượng cần xuất: {num(draftExcess)}.</p> : null}
        <div className="scan-table-wrap warehouse-outgoing-review-table"><table className="warehouse-table">
          <thead><tr><th>Chọn</th><th>Lô nhập</th><th>Ngày sản xuất</th><th>Ngày nhập</th><th>Tồn lô</th><th>Số lượng lấy</th></tr></thead>
          <tbody>{editorLots.map((lot) => {
            const amount = draft[lot.incoming_id] ?? 0;
            return <tr key={lot.incoming_id}>
              <td><input aria-label={`Chọn lô ${lot.incoming_id}`} type="checkbox" checked={amount > 0}
                onChange={(event) => { const checked = event.target.checked; setDraft((old) => {
                  const remaining = editing.component.quantity - Object.values(old).reduce((sum, value) => sum + value, 0);
                  return { ...old, [lot.incoming_id]: checked ? (remaining > 0 ? Math.min(lot.balance_qty, remaining) : lot.balance_qty) : 0 };
                }); }} /></td>
              <td>#{lot.incoming_id}</td><td>{productionDate(lot.production_date)}</td><td>{formatDate(lot.received_date)}</td><td>{num(lot.balance_qty)}</td>
              <td><input aria-label={`Số lượng lấy lô ${lot.incoming_id}`} type="number" min={0} max={lot.balance_qty} step={1} value={amount}
                onChange={(event) => { const value = Number(event.target.value); setDraft((old) => ({ ...old, [lot.incoming_id]: value })); }} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={() => setDraft(suggest(editorLots, editing.component.quantity))}>Khôi phục FIFO</button>
          <button className="button button-primary" type="button" disabled={invalidDraft} onClick={saveLotSelection}>Lưu lựa chọn</button>
        </div>
      </> : null}
    </dialog>
  </>;
}
