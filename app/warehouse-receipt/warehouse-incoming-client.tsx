"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { isInventoryDate, MAX_MANUAL_INCOMING_ROWS, parseManualIncomingRequest, todayInVietnam, type ManualIncomingLine } from "@/lib/warehouse-receipt/incoming";
import { incomingStorageKey, INCOMING_DRAFT_TTL, parseStoredIncoming, type StoredIncoming } from "@/lib/warehouse-receipt/incoming-storage";
import { WarehouseOpeningInventory } from "./warehouse-opening-inventory";

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
const LEGACY_PENDING_KEY = "warehouse-incoming-pending-v1";

function postingRows(drafts: IncomingDraft[]): ManualIncomingLine[] {
  return drafts.map((row) => ({
    itemcode: row.itemcode, received_date: row.received_date, production_date: row.production_date || null,
    wo: row.wo || null, quantity: row.quantity, note: row.note,
  }));
}

export function WarehouseIncomingClient({ canLoadOpeningInventory, profileId }: { canLoadOpeningInventory: boolean; profileId: string }) {
  const id = useId();
  const storageKey = incomingStorageKey(profileId);
  const itemInputRef = useRef<HTMLInputElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);
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
  const [savedList, setSavedList] = useState<StoredIncoming | null>(null);
  const storedRaw = useRef<string | null>(null);
  const legacyRaw = useRef<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageConflict, setStorageConflict] = useState(false);
  const submission = savedList?.status === "pending" ? savedList : null;
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

  const lookupCode = useCallback((code: string): Promise<LookupResult> => {
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
  }, []);

  const changeItemcode = useCallback((value: string) => {
    formVersion.current += 1;
    setItemcode(value);
    setItem(null);
    setLookupError("");
    setLookingUp(false);
    setFormError("");
  }, []);

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

  const resolveDraft = useCallback(async (draft: IncomingDraft) => {
    const result = await lookupCode(draft.itemcode);
    if (!mounted.current || (!result.ok && result.aborted)) return;
    setDrafts((current) => current.map((row) => {
      if (row.id !== draft.id || row.lookupVersion !== draft.lookupVersion) return row;
      return result.ok
        ? { ...row, ...result.item, lookupStatus: "ready", lookupError: "" }
        : { ...row, product_name: "", customer: "", lookupStatus: "error", lookupError: result.error };
    }));
  }, [lookupCode]);

  const clearForm = useCallback((resetDate = true) => {
    changeItemcode("");
    setProductionDate("");
    if (resetDate) setReceivedDate(todayInVietnam());
    setWO("");
    setQuantity("");
    setNote("");
    setEditingId(null);
    itemInputRef.current?.focus();
  }, [changeItemcode]);

  const writeSavedList = useCallback((next: StoredIncoming | null) => {
    try {
      if (window.localStorage.getItem(storageKey) !== storedRaw.current) {
        setStorageConflict(true);
        return false;
      }
      const raw = next ? JSON.stringify(next) : null;
      if (raw === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, raw);
      storedRaw.current = raw;
      setSavedList(next);
      return true;
    } catch {
      setSaveNotice({ type: "error", text: "Không thể cập nhật bản nháp trên trình duyệt. Kiểm tra quyền lưu dữ liệu rồi thử lại." });
      return false;
    }
  }, [storageKey]);

  const expireSavedList = useCallback((pending: boolean) => {
    if (!writeSavedList(null)) return;
    setDrafts([]);
    setReviewing(false);
    clearForm();
    setSaveNotice({
      type: "error",
      text: pending
        ? "Danh sách đã hết hạn 7 ngày. Lần nhập trước chưa rõ kết quả; hãy kiểm tra tồn kho trước khi nhập lại."
        : "Danh sách chờ nhập đã hết hạn 7 ngày và được xóa.",
    });
  }, [clearForm, writeSavedList]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        storedRaw.current = window.localStorage.getItem(storageKey);
        let stored = storedRaw.current ? parseStoredIncoming(storedRaw.current) : null;
        // Older versions kept in-flight requests in the current tab only.
        // Keep those requests in that tab rather than copying them to localStorage.
        let legacyDrafts: IncomingDraft[] | undefined;
        if (!stored) {
          try { legacyRaw.current = window.sessionStorage.getItem(LEGACY_PENDING_KEY); } catch { /* Local storage is enough for new drafts. */ }
          if (legacyRaw.current) {
            const legacy = JSON.parse(legacyRaw.current);
            legacyDrafts = legacy.drafts;
            stored = {
              ...parseManualIncomingRequest({ request_id: legacy.request_id, rows: postingRows(legacy.drafts) }),
              status: "pending", expiresAt: Date.now() + INCOMING_DRAFT_TTL,
            };
          }
        }
        if (!stored) return;
        if (stored.expiresAt <= Date.now()) {
          expireSavedList(stored.status === "pending");
          return;
        }
        const pending = stored.status === "pending";
        const restored = stored.rows.map((row, index): IncomingDraft => ({
          ...row, production_date: row.production_date || "", wo: row.wo || "",
          product_name: legacyDrafts?.[index]?.product_name ?? "", customer: legacyDrafts?.[index]?.customer ?? "",
          id: nextDraftId.current++, lookupStatus: pending ? "ready" : "loading",
          lookupError: "", lookupVersion: nextLookupVersion.current++,
        }));
        setSavedList(stored);
        setDrafts(restored);
        setReviewing(pending);
        if (pending) {
          setSaveNotice({ type: "error", text: "Có lần nhập kho chưa xác nhận được kết quả. Nhấn Thử lại ghi nhận để kiểm tra; hệ thống sẽ không ghi trùng." });
        } else {
          for (const row of restored) void resolveDraft(row);
        }
      } catch {
        setRecoveryBlocked(true);
        setSaveNotice({ type: "error", text: "Không thể đọc danh sách đã lưu. Vui lòng kiểm tra lần nhập trước và quyền lưu dữ liệu của trình duyệt." });
      } finally {
        setStorageReady(true);
      }
    });
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === storageKey || event.key === null)) {
        setStorageConflict(window.localStorage.getItem(storageKey) !== storedRaw.current);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, [expireSavedList, resolveDraft, storageKey]);

  useEffect(() => {
    if (!savedList || saving || storageConflict || legacyRaw.current) return;
    const expire = () => {
      if (Date.now() >= savedList.expiresAt && !savingRef.current) expireSavedList(savedList.status === "pending");
    };
    const timer = window.setTimeout(expire, Math.max(0, savedList.expiresAt - Date.now()));
    window.addEventListener("focus", expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", expire);
    };
  }, [expireSavedList, savedList, saving, storageConflict]);

  function persistDrafts(next: IncomingDraft[]) {
    if (!storageReady || storageConflict || recoveryBlocked || savingRef.current || submission) return false;
    if (savedList && savedList.expiresAt <= Date.now()) {
      expireSavedList(false);
      return false;
    }
    const record: StoredIncoming | null = next.length ? {
      request_id: window.crypto.randomUUID(), rows: postingRows(next),
      status: "draft", expiresAt: Date.now() + INCOMING_DRAFT_TTL,
    } : null;
    if (!writeSavedList(record)) return false;
    setSaveNotice(null);
    // Keep lookup results that may have arrived while this edit was queued.
    setDrafts((current) => {
      const byId = new Map(current.map((row) => [row.id, row]));
      return next.map((row) => {
        const latest = byId.get(row.id);
        return latest?.lookupVersion === row.lookupVersion ? latest : row;
      });
    });
    return true;
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storageReady || storageConflict || savingRef.current || submission || recoveryBlocked) return;
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
    const amount = Number(quantity);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 2147483647) {
      setFormError("Số lượng phải là số nguyên từ 1 đến 2.147.483.647.");
      return;
    }
    if (productionDate && !isInventoryDate(productionDate)) {
      setFormError("Ngày sản xuất không hợp lệ.");
      return;
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
    if (!persistDrafts(editingId === null ? [...drafts, draft] : drafts.map((row) => row.id === editingId ? draft : row))) return;
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
    if (!persistDrafts(drafts.filter((row) => row.id !== draftId))) return;
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
  const canProceed = storageReady && !storageConflict && !recoveryBlocked && drafts.length > 0
    && loadingCount === 0 && errorCount === 0 && editingId === null;

  function clearLegacySubmission() {
    if (!legacyRaw.current) return;
    try {
      window.sessionStorage.removeItem(LEGACY_PENDING_KEY);
      legacyRaw.current = null;
    } catch { /* The old request can still be safely retried with its original UUID. */ }
  }

  async function postInventory() {
    if (savingRef.current || !canProceed || !savedList) return;
    if (!legacyRaw.current && savedList.expiresAt <= Date.now()) {
      expireSavedList(Boolean(submission));
      return;
    }
    const pending: StoredIncoming = submission ?? {
      ...savedList, status: "pending", expiresAt: Date.now() + INCOMING_DRAFT_TTL,
    };
    if (legacyRaw.current) {
      // Retry an older tab's request only while that exact session record still exists.
      try {
        if (window.sessionStorage.getItem(LEGACY_PENDING_KEY) !== legacyRaw.current
            || window.localStorage.getItem(storageKey) !== storedRaw.current) {
          setStorageConflict(true);
          return;
        }
      } catch {
        setSaveNotice({ type: "error", text: "Không thể đọc lần nhập đã lưu để thử lại." });
        return;
      }
    } else if (!writeSavedList(pending)) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveNotice(null);
    try {
      const response = await fetch("/api/warehouse-receipt/incoming", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: profileId, request_id: pending.request_id, rows: pending.rows }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        if ([400, 404].includes(response.status) && writeSavedList({ ...pending, status: "draft" })) {
          clearLegacySubmission();
          const missing = response.status === 404 && typeof result.itemcode === "string" ? result.itemcode : null;
          if (missing) itemCache.current.delete(missing);
          const editable = drafts.map((row): IncomingDraft => {
            if (row.itemcode === missing) return { ...row, product_name: "", customer: "", lookupStatus: "error", lookupError: result.error };
            if (row.product_name && row.customer) return row;
            return { ...row, lookupStatus: "loading", lookupVersion: nextLookupVersion.current++ };
          });
          setDrafts(editable);
          setReviewing(false);
          for (const row of editable) if (row.lookupStatus === "loading") void resolveDraft(row);
        }
        throw new Error(result.error || "Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại.");
      }
      if (result.batch?.batch_id !== pending.request_id || result.batch.row_count !== pending.rows.length) throw new Error("Chưa xác nhận được kết quả nhập kho. Vui lòng thử lại.");
      clearLegacySubmission();
      if (!writeSavedList(null)) return;
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
      {storageConflict ? <p role="alert" className="alert alert-error">Danh sách đã thay đổi ở tab khác. Tải lại trang để tiếp tục với danh sách mới nhất.</p> : null}
      {!reviewing ? <div className="warehouse-incoming-form">
        <div className="warehouse-incoming-heading">
          <div><h2>{editingId === null ? "Nhập kho thủ công" : `Sửa dòng ${editingId}`}</h2>
          <p className="muted small">Nhập mã sản phẩm, nhấn Tab để nhập số lượng, rồi nhấn Enter để thêm dòng.</p></div>
          {canLoadOpeningInventory ? <WarehouseOpeningInventory /> : null}
        </div>
        <form onSubmit={saveDraft}>
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
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    quantityInputRef.current?.focus();
                  }
                }}
                placeholder="Nhập itemcode, ví dụ 11011*209"
                ref={itemInputRef}
                required
                value={itemcode}
              />
            </label>
            <label><span>Số lượng <span className="warehouse-required">*</span></span><input inputMode="numeric" max={2147483647} min={1} onChange={(event) => setQuantity(event.target.value)} placeholder="Nhập số lượng" ref={quantityInputRef} required step={1} type="number" value={quantity} /></label>
            <label><span>Ngày nhập kho <span className="warehouse-required">*</span></span><input onChange={(event) => setReceivedDate(event.target.value)} required type="date" value={receivedDate} /></label>
            <dl className="warehouse-incoming-item-details">
              <div><dt>Tên sản phẩm</dt><dd>{item?.product_name || "—"}</dd></div>
              <div><dt>Khách hàng</dt><dd>{item?.customer || "—"}</dd></div>
            </dl>
            <p aria-live="polite" className="muted small warehouse-incoming-lookup-note" id={`${id}-lookup-note`}>
              {lookingUp ? "Đang tra cứu sản phẩm, bạn có thể nhập tiếp và thêm vào danh sách." : "Dấu * được thay bằng số 0 để đủ 13 ký tự. Tên sản phẩm và khách hàng tự điền theo mã."}
            </p>
            <label><span>Ngày sản xuất <small className="warehouse-field-hint">Không bắt buộc</small></span><input onChange={(event) => setProductionDate(event.target.value)} type="date" value={productionDate} /></label>
            <label><span>WO <small className="warehouse-field-hint">Không bắt buộc</small></span><input maxLength={200} onChange={(event) => setWO(event.target.value)} placeholder="Nhập WO nếu có" value={wo} /></label>
            <label className="warehouse-incoming-note"><span>Ghi chú <small className="warehouse-field-hint">Không bắt buộc</small></span><textarea maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Nhập lý do hoặc nội dung nhập kho nếu có" rows={3} value={note} /></label>
          </div>
          {lookupError ? <p className="alert alert-error" id={`${id}-lookup-error`} role="alert">{lookupError}</p> : null}
          {formError ? <p className="alert alert-error" role="alert">{formError}</p> : null}
          <div className="warehouse-incoming-actions">
            <button className="button button-secondary" onClick={() => clearForm()} type="button">{editingId === null ? "Xóa nội dung" : "Hủy sửa"}</button>
            <button className="button button-primary" disabled={!storageReady || storageConflict || recoveryBlocked} type="submit">{editingId === null ? "Thêm vào danh sách" : "Lưu thay đổi"}</button>
          </div>
        </form>
      </div> : null}

      <section className="scan-table-card">
        <div className="warehouse-incoming-draft-heading">
          <h2>{reviewing ? "Kiểm tra danh sách nhập kho" : "Danh sách chờ nhập"} <span className="muted">({drafts.length})</span></h2>
          <p className="muted small">Danh sách được lưu trên trình duyệt này trong 7 ngày kể từ lần lưu gần nhất và tự xóa khi xác nhận nhập kho thành công.</p>
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
            <td>{draft.quantity.toLocaleString("vi-VN")}</td><td className="warehouse-incoming-draft-note">{draft.note || "—"}</td>
            {!reviewing ? <td><div className="warehouse-incoming-row-actions">
              <button aria-label={`Sửa dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" disabled={storageConflict} onClick={() => editDraft(draft)} type="button">Sửa</button>
              <button aria-label={`Xóa dòng ${draft.id} - ${draft.itemcode}`} className="button button-secondary button-small" disabled={storageConflict} onClick={() => removeDraft(draft.id)} type="button">Xóa</button>
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
