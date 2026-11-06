"use client";

import { useEffect, useId, useState } from "react";
import { isInventoryDate, todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { MAX_DELIVERY_QUANTITY, type ManualDeliveryInput, type ManualDeliveryItem } from "@/lib/warehouse-receipt/outgoing";

type FormProps = { locked: boolean; onSubmit: (payload: ManualDeliveryInput) => void };

export function WarehouseManualDelivery({ saved, ...props }: FormProps & { saved: number }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState(todayInVietnam);
  return <section aria-label="Nhập lịch giao hàng thủ công" className="scan-table-card">
    <div className="warehouse-incoming-draft-heading">
      <div className="warehouse-outgoing-summary-heading">
        <h2>Nhập lịch giao hàng thủ công</h2>
        <button aria-expanded={expanded} aria-controls={panelId} className="button button-secondary button-small"
          onClick={() => setExpanded((open) => !open)} type="button">{expanded ? "▾ Thu gọn" : "▸ Mở rộng"}</button>
      </div>
    </div>
    <div id={panelId} hidden={!expanded}>
      <ManualDeliveryForm key={saved} {...props} date={date} setDate={setDate} />
    </div>
  </section>;
}

function ManualDeliveryForm({ locked, onSubmit, date, setDate }: FormProps & { date: string; setDate: (date: string) => void }) {
  const id = useId();
  const [itemcode, setItemcode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [lookup, setLookup] = useState<{ code: string; item?: ManualDeliveryItem; error?: string; retryable?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  let code = "";
  let codeError = "";
  if (itemcode.trim()) {
    try { code = normalizeWarehouseItemcode(itemcode); }
    catch (error) { codeError = error instanceof Error ? error.message : "Mã sản phẩm không hợp lệ."; }
  }
  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ view: "manual-item", itemcode: code });
        const response = await fetch(`/api/warehouse-receipt/outgoing?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok && data.success && data.item) setLookup({ code, item: data.item });
        else setLookup({ code, error: data.error || "Không tra được thông tin sản phẩm.", retryable: response.status >= 500 });
      } catch {
        if (!controller.signal.aborted) setLookup({ code, error: "Không tra được thông tin sản phẩm. Vui lòng thử lại.", retryable: true });
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [code, attempt]);

  const current = lookup?.code === code ? lookup : null;
  const item = current?.item;
  const error = codeError || current?.error;
  const amount = Number(quantity);
  const canSubmit = !locked && item && isInventoryDate(date) && Number.isInteger(amount) && amount > 0 && amount <= MAX_DELIVERY_QUANTITY;

  return <form className="warehouse-manual-delivery" onSubmit={(event) => {
    event.preventDefault();
    if (canSubmit) onSubmit({ delivery_date: date, itemcode: code, ordered_qty: amount });
  }}>
    <div className="warehouse-incoming-fields">
      <label>Ngày giao<input required type="date" value={date} disabled={locked} onChange={(event) => setDate(event.target.value)} /></label>
      <label>Mã sản phẩm (Itemcode)<input required value={itemcode} disabled={locked} autoComplete="off"
        aria-invalid={Boolean(error)} aria-describedby={`${id}-lookup`}
        onChange={(event) => setItemcode(event.target.value)} onBlur={() => { if (code) setItemcode(code); }} /></label>
      <label>Số lượng<input required type="number" min={1} max={MAX_DELIVERY_QUANTITY} step={1} value={quantity} disabled={locked}
        onChange={(event) => setQuantity(event.target.value)} /></label>
      <dl className="warehouse-incoming-item-details" aria-live="polite">
        <div><dt>Tên sản phẩm</dt><dd>{item?.product_name || "—"}</dd></div>
        <div><dt>Khách hàng</dt><dd>{item ? item.customer || "Chưa có tên khách hàng" : "—"}</dd></div>
      </dl>
    </div>
    <div id={`${id}-lookup`} aria-live="polite">
      {error ? <p className="alert alert-error">{error}</p> : code && !current ? <p className="muted small">Đang tra cứu sản phẩm…</p> : null}
      {current?.retryable ? <button type="button" className="button button-secondary button-small" disabled={locked}
        onClick={() => { setLookup(null); setAttempt((value) => value + 1); }}>Thử tra cứu lại</button> : null}
    </div>
    <div className="warehouse-incoming-actions">
      <button type="submit" className="button button-primary" disabled={!canSubmit}>Thêm lịch giao</button>
    </div>
  </form>;
}
