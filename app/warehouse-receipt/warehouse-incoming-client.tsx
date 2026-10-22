"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

type ItemDetails = { itemcode: string; product_name: string; customer: string };
type IncomingDraft = ItemDetails & {
  id: number;
  production_date: string;
  wo: string;
  quantity: number;
  note: string;
};

export function WarehouseIncomingClient() {
  const id = useId();
  const itemInputRef = useRef<HTMLInputElement>(null);
  const lookupRef = useRef<{ itemcode: string; promise: Promise<ItemDetails | null>; controller: AbortController } | null>(null);
  const lookupVersion = useRef(0);
  const nextDraftId = useRef(1);
  const [itemcode, setItemcode] = useState("");
  const [item, setItem] = useState<ItemDetails | null>(null);
  const [productionDate, setProductionDate] = useState("");
  const [wo, setWO] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [formError, setFormError] = useState("");
  const [drafts, setDrafts] = useState<IncomingDraft[]>([]);

  useEffect(() => () => {
    lookupVersion.current += 1;
    lookupRef.current?.controller.abort();
  }, []);

  function changeItemcode(value: string) {
    lookupVersion.current += 1;
    lookupRef.current?.controller.abort();
    lookupRef.current = null;
    setItemcode(value);
    setItem(null);
    setLookupError("");
    setLookingUp(false);
    setFormError("");
  }

  async function lookupItem(): Promise<ItemDetails | null> {
    const code = itemcode.trim();
    if (!code) return null;
    if (item?.itemcode === code) return item;
    if (lookupRef.current?.itemcode === code) return lookupRef.current.promise;

    lookupRef.current?.controller.abort();
    const controller = new AbortController();
    const version = ++lookupVersion.current;
    setLookingUp(true);
    setLookupError("");
    setItem(null);

    const promise = (async () => {
      try {
        const response = await fetch("/api/warehouse-receipt/item-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemcode: code }),
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json();
        if (version !== lookupVersion.current) return null;
        if (!response.ok || !result.success) throw new Error(result.error || "Không thể tra cứu sản phẩm. Vui lòng thử lại.");
        const found = result.item as ItemDetails | undefined;
        if (found?.itemcode !== code || !found.product_name?.trim() || !found.customer?.trim()) {
          throw new Error("Không tìm thấy item, vui lòng cập nhật database");
        }
        setItem(found);
        return found;
      } catch (error) {
        if (version === lookupVersion.current && !controller.signal.aborted) {
          setLookupError(error instanceof Error ? error.message : "Không thể tra cứu sản phẩm. Vui lòng thử lại.");
        }
        return null;
      } finally {
        if (version === lookupVersion.current) {
          setLookingUp(false);
          lookupRef.current = null;
        }
      }
    })();
    lookupRef.current = { itemcode: code, promise, controller };
    return promise;
  }

  function clearForm() {
    changeItemcode("");
    setProductionDate("");
    setWO("");
    setQuantity("");
    setNote("");
    itemInputRef.current?.focus();
  }

  async function addDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adding) return;
    setFormError("");
    if (!itemcode.trim() || !note.trim()) {
      setFormError("Vui lòng nhập mã sản phẩm và ghi chú.");
      return;
    }
    const amount = Number(quantity);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 2147483647) {
      setFormError("Số lượng phải là số nguyên từ 1 đến 2.147.483.647.");
      return;
    }
    if (productionDate) {
      const date = new Date(`${productionDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(productionDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== productionDate) {
        setFormError("Ngày sản xuất không hợp lệ.");
        return;
      }
    }
    setAdding(true);
    try {
      const found = await lookupItem();
      if (!found) return;
      const draft: IncomingDraft = {
        ...found,
        id: nextDraftId.current++,
        production_date: productionDate,
        wo: wo.trim(),
        quantity: amount,
        note: note.trim(),
      };
      setDrafts((current) => [...current, draft]);
      clearForm();
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="warehouse-incoming">
      <form className="warehouse-incoming-form" onSubmit={addDraft}>
        <div className="warehouse-incoming-heading">
          <h2>Nhập kho thủ công</h2>
          <p className="muted small">Các trường có dấu * là bắt buộc.</p>
        </div>
        <div className="warehouse-incoming-fields">
          <label>
            <span>Mã sản phẩm <span className="warehouse-required">*</span></span>
            <input
              aria-describedby={`${id}-lookup-note${lookupError ? ` ${id}-lookup-error` : ""}`}
              aria-invalid={Boolean(lookupError)}
              autoComplete="off"
              disabled={adding}
              maxLength={200}
              onBlur={() => { void lookupItem(); }}
              onChange={(event) => changeItemcode(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookupItem(); } }}
              placeholder="Nhập itemcode"
              ref={itemInputRef}
              required
              value={itemcode}
            />
          </label>
          <label>Tên sản phẩm<input placeholder="Tự động điền theo mã sản phẩm" readOnly value={item?.product_name ?? ""} /></label>
          <label>Khách hàng<input placeholder="Tự động điền theo mã sản phẩm" readOnly value={item?.customer ?? ""} /></label>
          <p aria-live="polite" className="muted small warehouse-incoming-lookup-note" id={`${id}-lookup-note`}>
            {lookingUp ? "Đang tra cứu sản phẩm..." : "Nhập mã rồi nhấn Enter hoặc rời ô để tự điền tên sản phẩm và khách hàng."}
          </p>
          <label><span>Ngày sản xuất <small className="warehouse-field-hint">Không bắt buộc</small></span><input disabled={adding} onChange={(event) => setProductionDate(event.target.value)} type="date" value={productionDate} /></label>
          <label><span>WO <small className="warehouse-field-hint">Không bắt buộc</small></span><input disabled={adding} maxLength={200} onChange={(event) => setWO(event.target.value)} placeholder="Nhập WO nếu có" value={wo} /></label>
          <label><span>Số lượng <span className="warehouse-required">*</span></span><input disabled={adding} inputMode="numeric" max={2147483647} min={1} onChange={(event) => setQuantity(event.target.value)} placeholder="Nhập số lượng" required step={1} type="number" value={quantity} /></label>
          <label className="warehouse-incoming-note"><span>Ghi chú <span className="warehouse-required">*</span></span><textarea disabled={adding} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Nhập lý do hoặc nội dung nhập kho" required rows={3} value={note} /></label>
        </div>
        {lookupError ? <p className="alert alert-error" id={`${id}-lookup-error`} role="alert">{lookupError}</p> : null}
        {formError ? <p className="alert alert-error" role="alert">{formError}</p> : null}
        <div className="warehouse-incoming-actions">
          <button className="button button-secondary" disabled={adding} onClick={clearForm} type="button">Xóa nội dung</button>
          <button className="button button-primary" disabled={adding} type="submit">{adding ? "Đang kiểm tra..." : "Thêm vào danh sách"}</button>
        </div>
      </form>

      <section className="scan-table-card">
        <div className="warehouse-incoming-draft-heading">
          <h2>Danh sách chờ nhập <span className="muted">({drafts.length})</span></h2>
          <p className="muted small">Danh sách chưa ghi nhận vào tồn kho. Tải lại trang sẽ xóa các dòng đang chờ.</p>
        </div>
        {drafts.length ? <div className="scan-table-wrap"><table className="warehouse-table">
          <thead><tr><th>Mã sản phẩm</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Ngày sản xuất</th><th>WO</th><th>Số lượng</th><th>Ghi chú</th><th>Thao tác</th></tr></thead>
          <tbody>{drafts.map((draft) => <tr key={draft.id}>
            <td><strong>{draft.itemcode}</strong></td><td>{draft.product_name}</td><td>{draft.customer}</td>
            <td>{draft.production_date ? draft.production_date.split("-").reverse().join("/") : "—"}</td><td>{draft.wo || "—"}</td>
            <td>{draft.quantity.toLocaleString("vi-VN")}</td><td className="warehouse-incoming-draft-note">{draft.note}</td>
            <td><button aria-label={`Xóa dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" onClick={() => setDrafts((current) => current.filter((row) => row.id !== draft.id))} type="button">Xóa</button></td>
          </tr>)}</tbody>
        </table></div> : <div className="scan-empty">Chưa có dòng hàng chờ nhập.</div>}
      </section>
    </div>
  );
}
