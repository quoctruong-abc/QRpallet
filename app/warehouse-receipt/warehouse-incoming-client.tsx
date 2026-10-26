"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { isInventoryDate, MAX_MANUAL_INCOMING_ROWS, parseManualIncomingRequest, todayInVietnam, type ManualIncomingLine } from "@/lib/warehouse-receipt/incoming";

type ItemDetails = { itemcode: string; product_name: string; customer: string };
type LookupResult = { ok: true; item: ItemDetails } | { ok: false; error: string; aborted?: boolean };
type IncomingDraft = ItemDetails & {
  id: number;
  received_date: string;
  production_date: string;
  wo: string;
  quantity: number;
  note: string;
  lookupStatus: "loading" | "ready" | "error";
  lookupError: string;
  lookupVersion: number;
};
type PendingSubmission = { request_id: string; drafts: IncomingDraft[] };
const PENDING_STORAGE_KEY = "warehouse-incoming-pending-v1";

function postingRows(drafts: IncomingDraft[]): ManualIncomingLine[] {
  return drafts.map((row) => ({
    itemcode: row.itemcode, received_date: row.received_date, production_date: row.production_date || null,
    wo: row.wo || null, quantity: row.quantity, note: row.note,
  }));
}

export function WarehouseIncomingClient() {
  const id = useId();
  const itemInputRef = useRef<HTMLInputElement>(null);
  const requests = useRef(new Map<string, { promise: Promise<LookupResult>; controller: AbortController }>());
  const itemCache = useRef(new Map<string, ItemDetails>());
  const formVersion = useRef(0);
  const nextDraftId = useRef(1);
  const nextLookupVersion = useRef(1);
  const mounted = useRef(true);
  const [itemcode, setItemcode] = useState("");
  const [item, setItem] = useState<ItemDetails | null>(null);
  const [productionDate, setProductionDate] = useState("");
  const [receivedDate, setReceivedDate] = useState(todayInVietnam);
  const [wo, setWO] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [formError, setFormError] = useState("");
  const [drafts, setDrafts] = useState<IncomingDraft[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [submission, setSubmission] = useState<PendingSubmission | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveNotice, setSaveNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const pending = requests.current;
    return () => {
      mounted.current = false;
      formVersion.current += 1;
      for (const request of pending.values()) request.controller.abort();
      pending.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Restore an uncertain submission after hydration so reload + retry uses
    // exactly the original request UUID and payload, including receipt dates.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      let raw: string | null;
      try { raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY); } catch { return; }
      if (!raw) return;
      try {
        const pending = JSON.parse(raw) as PendingSubmission;
        const parsed = parseManualIncomingRequest({ request_id: pending.request_id, rows: postingRows(pending.drafts) });
        const restored = parsed.rows.map((row, index): IncomingDraft => ({
          ...row, production_date: row.production_date || "", wo: row.wo || "",
          product_name: pending.drafts[index].product_name, customer: pending.drafts[index].customer,
          id: index + 1, lookupStatus: "ready", lookupError: "", lookupVersion: nextLookupVersion.current++,
        }));
        if (restored.some((row) => !row.product_name?.trim() || !row.customer?.trim())) throw new Error("Invalid pending metadata");
        nextDraftId.current = restored.length + 1;
        setDrafts(restored);
        setSubmission({ request_id: parsed.request_id, drafts: restored });
        setReviewing(true);
        setSaveNotice({ type: "error", text: "Có lần nhập kho chưa xác nhận được kết quả. Nhấn Thử lại ghi nhận để kiểm tra; hệ thống sẽ không ghi trùng." });
      } catch {
        setRecoveryBlocked(true);
        setSaveNotice({ type: "error", text: "Không thể khôi phục danh sách đang chờ xác nhận. Vui lòng kiểm tra lần nhập trước trước khi tạo danh sách mới." });
      }
    });
    return () => { cancelled = true; };
  }, []);

  function lookupCode(code: string): Promise<LookupResult> {
    const cached = itemCache.current.get(code);
    if (cached) return Promise.resolve({ ok: true, item: cached });
    const pending = requests.current.get(code);
    if (pending) return pending.promise;

    const controller = new AbortController();
    const promise = (async (): Promise<LookupResult> => {
      try {
        const response = await fetch("/api/warehouse-receipt/item-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemcode: code }),
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json();
        if (controller.signal.aborted) return { ok: false, error: "", aborted: true };
        if (!response.ok || !result.success) throw new Error(result.error || "Không thể tra cứu sản phẩm. Vui lòng thử lại.");
        const found = result.item as ItemDetails | undefined;
        if (found?.itemcode !== code || !found.product_name?.trim() || !found.customer?.trim()) {
          throw new Error("Không tìm thấy item, vui lòng cập nhật database");
        }
        itemCache.current.set(code, found);
        return { ok: true, item: found };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Không thể tra cứu sản phẩm. Vui lòng thử lại.", aborted: controller.signal.aborted };
      }
    })();
    requests.current.set(code, { promise, controller });
    void promise.finally(() => {
      if (requests.current.get(code)?.controller === controller) requests.current.delete(code);
    });
    return promise;
  }

  function changeItemcode(value: string) {
    formVersion.current += 1;
    setItemcode(value);
    setItem(null);
    setLookupError("");
    setLookingUp(false);
    setFormError("");
  }

  async function lookupForm(value = itemcode) {
    let code: string;
    try {
      code = normalizeWarehouseItemcode(value);
    } catch (error) {
      if (value.trim()) setLookupError(error instanceof Error ? error.message : "Mã sản phẩm không hợp lệ.");
      return;
    }
    const version = ++formVersion.current;
    setItemcode(code);
    setLookingUp(true);
    setLookupError("");
    const result = await lookupCode(code);
    if (!mounted.current || version !== formVersion.current || (!result.ok && result.aborted)) return;
    setLookingUp(false);
    setItem(result.ok ? result.item : null);
    setLookupError(result.ok ? "" : result.error);
  }

  async function resolveDraft(draft: IncomingDraft) {
    const result = await lookupCode(draft.itemcode);
    if (!mounted.current || (!result.ok && result.aborted)) return;
    setDrafts((current) => current.map((row) => {
      if (row.id !== draft.id || row.lookupVersion !== draft.lookupVersion) return row;
      return result.ok
        ? { ...row, ...result.item, lookupStatus: "ready", lookupError: "" }
        : { ...row, product_name: "", customer: "", lookupStatus: "error", lookupError: result.error };
    }));
  }

  function clearForm(resetDate = true) {
    changeItemcode("");
    setProductionDate("");
    if (resetDate) setReceivedDate(todayInVietnam());
    setWO("");
    setQuantity("");
    setNote("");
    setEditingId(null);
    itemInputRef.current?.focus();
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || submission || recoveryBlocked) return;
    setFormError("");
    if (editingId === null && drafts.length >= MAX_MANUAL_INCOMING_ROWS) {
      setFormError(`Mỗi lần ghi nhận tối đa ${MAX_MANUAL_INCOMING_ROWS} dòng.`);
      return;
    }
    if (!isInventoryDate(receivedDate)) {
      setFormError("Ngày nhập kho không hợp lệ.");
      return;
    }
    let code: string;
    try {
      code = normalizeWarehouseItemcode(itemcode);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Mã sản phẩm không hợp lệ.");
      return;
    }
    if (!note.trim()) {
      setFormError("Vui lòng nhập ghi chú.");
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
    const cached = itemCache.current.get(code);
    const draft: IncomingDraft = {
      itemcode: code,
      product_name: cached?.product_name ?? "",
      customer: cached?.customer ?? "",
      id: editingId ?? nextDraftId.current++,
      received_date: receivedDate,
      production_date: productionDate,
      wo: wo.trim(),
      quantity: amount,
      note: note.trim(),
      lookupStatus: cached ? "ready" : "loading",
      lookupError: "",
      lookupVersion: nextLookupVersion.current++,
    };
    setDrafts((current) => editingId === null ? [...current, draft] : current.map((row) => row.id === editingId ? draft : row));
    setReviewing(false);
    clearForm(false);
    if (!cached) void resolveDraft(draft);
  }

  function editDraft(draft: IncomingDraft) {
    changeItemcode(draft.itemcode);
    setProductionDate(draft.production_date);
    setReceivedDate(draft.received_date);
    setWO(draft.wo);
    setQuantity(String(draft.quantity));
    setNote(draft.note);
    setEditingId(draft.id);
    setReviewing(false);
    itemInputRef.current?.focus();
    itemInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    void lookupForm(draft.itemcode);
  }

  function removeDraft(draftId: number) {
    setDrafts((current) => current.filter((row) => row.id !== draftId));
    if (editingId === draftId) clearForm();
    setReviewing(false);
  }

  function retryDraft(draft: IncomingDraft) {
    const next: IncomingDraft = { ...draft, lookupStatus: "loading", lookupError: "", lookupVersion: nextLookupVersion.current++ };
    setDrafts((current) => current.map((row) => row.id === next.id ? next : row));
    void resolveDraft(next);
  }

  const loadingCount = drafts.filter((row) => row.lookupStatus === "loading").length;
  const errorCount = drafts.filter((row) => row.lookupStatus === "error").length;
  const canProceed = drafts.length > 0 && drafts.length <= MAX_MANUAL_INCOMING_ROWS && loadingCount === 0 && errorCount === 0 && editingId === null && !recoveryBlocked;

  async function postInventory() {
    if (savingRef.current || !canProceed) return;
    let pending = submission;
    if (!pending) {
      pending = { request_id: window.crypto.randomUUID(), drafts: drafts.map((row) => ({ ...row })) };
      try {
        window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
      } catch {
        setSaveNotice({ type: "error", text: "Không thể lưu trạng thái lần nhập trên trình duyệt. Vui lòng cho phép lưu dữ liệu rồi thử lại." });
        return;
      }
      setSubmission(pending);
    }
    savingRef.current = true;
    setSaving(true);
    setSaveNotice(null);
    try {
      const response = await fetch("/api/warehouse-receipt/incoming", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: pending.request_id, rows: postingRows(pending.drafts) }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        if ([400, 404].includes(response.status)) {
          try { window.sessionStorage.removeItem(PENDING_STORAGE_KEY); } catch { /* A rejected request has not posted stock. */ }
          setSubmission(null);
          if (response.status === 404 && typeof result.itemcode === "string") {
            itemCache.current.delete(result.itemcode);
            setDrafts((current) => current.map((row) => row.itemcode === result.itemcode ? { ...row, product_name: "", customer: "", lookupStatus: "error", lookupError: result.error } : row));
            setReviewing(false);
          }
        }
        throw new Error(result.error || "Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại.");
      }
      if (result.batch?.batch_id !== pending.request_id || result.batch.row_count !== pending.drafts.length) throw new Error("Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại.");
      try { window.sessionStorage.removeItem(PENDING_STORAGE_KEY); } catch { /* Retrying this UUID will return the saved batch. */ }
      setSubmission(null);
      setDrafts([]);
      setReviewing(false);
      clearForm();
      setSaveNotice({ type: "success", text: `Đã ghi nhận nhập kho ${result.batch.row_count} dòng, tổng số lượng ${Number(result.batch.total_quantity).toLocaleString("vi-VN")}.` });
    } catch (error) {
      setSaveNotice({ type: "error", text: error instanceof Error ? error.message : "Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại." });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="warehouse-incoming">
      {saveNotice ? <p aria-live="polite" className={`alert alert-${saveNotice.type}`}>{saveNotice.text}</p> : null}
      {!reviewing ? <form className="warehouse-incoming-form" onSubmit={saveDraft}>
        <div className="warehouse-incoming-heading">
          <div><h2>{editingId === null ? "Nhập kho thủ công" : `Sửa dòng ${editingId}`}</h2>
          <p className="muted small">Các trường có dấu * là bắt buộc. Có thể thêm dòng trong lúc thông tin sản phẩm đang được tra cứu.</p></div>
          <label><span>Ngày nhập kho <span className="warehouse-required">*</span></span><input aria-label="Ngày nhập kho" onChange={(event) => setReceivedDate(event.target.value)} required type="date" value={receivedDate} /></label>
        </div>
        <div className="warehouse-incoming-fields">
          <label>
            <span>Mã sản phẩm <span className="warehouse-required">*</span></span>
            <input
              aria-describedby={`${id}-lookup-note${lookupError ? ` ${id}-lookup-error` : ""}`}
              aria-invalid={Boolean(lookupError)}
              autoComplete="off"
              maxLength={200}
              onBlur={() => { void lookupForm(); }}
              onChange={(event) => changeItemcode(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookupForm(); } }}
              placeholder="Nhập itemcode, ví dụ 11011*209"
              ref={itemInputRef}
              required
              value={itemcode}
            />
          </label>
          <label>Tên sản phẩm<input placeholder="Tự động điền theo mã sản phẩm" readOnly value={item?.product_name ?? ""} /></label>
          <label>Khách hàng<input placeholder="Tự động điền theo mã sản phẩm" readOnly value={item?.customer ?? ""} /></label>
          <p aria-live="polite" className="muted small warehouse-incoming-lookup-note" id={`${id}-lookup-note`}>
            {lookingUp ? "Đang tra cứu sản phẩm, bạn có thể nhập tiếp và thêm vào danh sách." : "Dấu * được thay bằng số 0 để đủ 13 ký tự. Nhấn Enter hoặc rời ô để tra cứu."}
          </p>
          <label><span>Ngày sản xuất <small className="warehouse-field-hint">Không bắt buộc</small></span><input onChange={(event) => setProductionDate(event.target.value)} type="date" value={productionDate} /></label>
          <label><span>WO <small className="warehouse-field-hint">Không bắt buộc</small></span><input maxLength={200} onChange={(event) => setWO(event.target.value)} placeholder="Nhập WO nếu có" value={wo} /></label>
          <label><span>Số lượng <span className="warehouse-required">*</span></span><input inputMode="numeric" max={2147483647} min={1} onChange={(event) => setQuantity(event.target.value)} placeholder="Nhập số lượng" required step={1} type="number" value={quantity} /></label>
          <label className="warehouse-incoming-note"><span>Ghi chú <span className="warehouse-required">*</span></span><textarea maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Nhập lý do hoặc nội dung nhập kho" required rows={3} value={note} /></label>
        </div>
        {lookupError ? <p className="alert alert-error" id={`${id}-lookup-error`} role="alert">{lookupError}</p> : null}
        {formError ? <p className="alert alert-error" role="alert">{formError}</p> : null}
        <div className="warehouse-incoming-actions">
          <button className="button button-secondary" onClick={() => clearForm()} type="button">{editingId === null ? "Xóa nội dung" : "Hủy sửa"}</button>
          <button className="button button-primary" type="submit">{editingId === null ? "Thêm vào danh sách" : "Lưu thay đổi"}</button>
        </div>
      </form> : null}

      <section className="scan-table-card">
        <div className="warehouse-incoming-draft-heading">
          <h2>{reviewing ? "Kiểm tra danh sách nhập kho" : "Danh sách chờ nhập"} <span className="muted">({drafts.length})</span></h2>
          <p className="muted small">Danh sách chưa ghi nhận vào tồn kho. Tải lại trang sẽ xóa các dòng đang chờ.</p>
          {!reviewing ? <p aria-live="polite" className={errorCount ? "warehouse-incoming-row-message" : "muted small"}>
            {errorCount ? `${errorCount} dòng chưa tra cứu thành công. Sửa mã hoặc thử lại trước khi tiếp tục.` : loadingCount ? `Đang cập nhật thông tin cho ${loadingCount} dòng...` : editingId !== null ? "Lưu thay đổi hoặc hủy sửa trước khi tiếp tục." : drafts.length ? "Tất cả dòng đã có thông tin sản phẩm." : ""}
          </p> : null}
        </div>
        {drafts.length ? <div className="scan-table-wrap"><table className="warehouse-table">
          <thead><tr><th>Ngày nhập kho</th><th>Mã sản phẩm</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Ngày sản xuất</th><th>WO</th><th>Số lượng</th><th>Ghi chú</th>{!reviewing ? <th>Thao tác</th> : null}</tr></thead>
          <tbody>{drafts.map((draft) => <tr className={draft.lookupStatus === "error" ? "warehouse-incoming-row-error" : undefined} key={draft.id}>
            <td>{draft.received_date.split("-").reverse().join("/")}</td>
            <td><strong>{draft.itemcode}</strong>{draft.lookupStatus !== "ready" ? <span className="warehouse-incoming-row-message" role="status">{draft.lookupStatus === "loading" ? "Đang tra cứu..." : draft.lookupError}</span> : null}</td>
            <td>{draft.product_name || "—"}</td><td>{draft.customer || "—"}</td>
            <td>{draft.production_date ? draft.production_date.split("-").reverse().join("/") : "—"}</td><td>{draft.wo || "—"}</td>
            <td>{draft.quantity.toLocaleString("vi-VN")}</td><td className="warehouse-incoming-draft-note">{draft.note}</td>
            {!reviewing ? <td><div className="warehouse-incoming-row-actions">
              <button aria-label={`Sửa dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" onClick={() => editDraft(draft)} type="button">Sửa</button>
              <button aria-label={`Xóa dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" onClick={() => removeDraft(draft.id)} type="button">Xóa</button>
              {draft.lookupStatus === "error" ? <button aria-label={`Tra cứu lại dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" onClick={() => retryDraft(draft)} type="button">Thử lại</button> : null}
            </div></td> : null}
          </tr>)}</tbody>
        </table></div> : <div className="scan-empty">Chưa có dòng hàng chờ nhập.</div>}
        <div className="warehouse-incoming-next">
          {reviewing ? <>
            <button className="button button-secondary" disabled={saving || Boolean(submission)} onClick={() => setReviewing(false)} type="button">Quay lại chỉnh sửa</button>
            <button className="button button-primary" disabled={saving || !canProceed} onClick={() => { void postInventory(); }} type="button">{saving ? "Đang ghi nhận..." : submission ? "Thử lại ghi nhận" : "Xác nhận nhập kho"}</button>
          </> : <button aria-describedby={`${id}-proceed-note`} className="button button-primary" disabled={!canProceed} onClick={() => { if (canProceed) setReviewing(true); }} type="button">Tiếp theo</button>}
          <p className="muted small" id={`${id}-proceed-note`}>{reviewing ? "Xác nhận để lưu toàn bộ danh sách vào tồn kho." : "Chỉ tiếp tục khi tất cả dòng tra cứu thành công và đã lưu chỉnh sửa."}</p>
        </div>
      </section>
    </div>
  );
}
