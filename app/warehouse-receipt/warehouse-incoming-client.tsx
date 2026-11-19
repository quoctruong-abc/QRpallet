"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { isInventoryDate, parseManualIncomingRequest, todayInVietnam, type ManualIncomingLine } from "@/lib/warehouse-receipt/incoming";
import { incomingStorageKey, incomingStoredRows, completeIncomingSubmission, INCOMING_DRAFT_TTL, parseStoredIncoming, type StoredIncoming } from "@/lib/warehouse-receipt/incoming-storage";
import { WarehouseItemBuildUp, WarehouseMasterData } from "./warehouse-master-data";
import { WarehouseCatalogEditors } from "./warehouse-catalog-editors";
import { WarehouseOpeningInventory } from "./warehouse-opening-inventory";
import { WarehouseIncomingProposals } from "./warehouse-incoming-proposals";

type ItemDetails = { itemcode: string; product_name: string; customer: string | null };
const LEGACY_PENDING_KEY = "warehouse-incoming-pending-v1";

export function WarehouseIncomingClient({ isSuperAdmin, profileId, canEdit }: { isSuperAdmin: boolean; profileId: string; canEdit: boolean }) {
  const id = useId();
  const storageKey = incomingStorageKey(profileId);
  const itemInput = useRef<HTMLInputElement>(null);
  const quantityInput = useRef<HTMLInputElement>(null);
  const formVersion = useRef(0);
  const lookupRequest = useRef<AbortController | null>(null);
  const storedRaw = useRef<string | null>(null);
  const legacyRaw = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [itemcode, setItemcode] = useState("");
  const [item, setItem] = useState<ItemDetails | null>(null);
  const [productionDate, setProductionDate] = useState("");
  const [receivedDate, setReceivedDate] = useState(todayInVietnam);
  const [wo, setWO] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [saved, setSaved] = useState<StoredIncoming | null>(null);
  const [recoverOne, setRecoverOne] = useState(false);
  const [ready, setReady] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposalRevision, setProposalRevision] = useState(0);
  const recovering = Boolean(saved && (saved.status === "pending" || (!recoverOne && (saved.rows.length > 1 || saved.remaining_rows?.length))));
  const locked = !ready || busy || conflict || recoveryBlocked;
  const legacyPosting = saved?.status === "pending" && (saved.action ?? "post") === "post";

  const changeCode = useCallback((value: string) => {
    formVersion.current++;
    lookupRequest.current?.abort();
    setItemcode(value); setItem(null); setLookupError(""); setLookingUp(false);
  }, []);

  const lookup = useCallback(async (value: string) => {
    let code: string;
    try { code = normalizeWarehouseItemcode(value); }
    catch (cause) { if (value.trim()) setLookupError(cause instanceof Error ? cause.message : "Mã sản phẩm không hợp lệ."); return; }
    lookupRequest.current?.abort();
    const controller = new AbortController();
    lookupRequest.current = controller;
    const version = ++formVersion.current;
    setItemcode(code); setLookingUp(true); setLookupError("");
    try {
      const response = await fetch("/api/warehouse-receipt/item-lookup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemcode: code }), signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      if (controller.signal.aborted || formVersion.current !== version) return;
      if (!response.ok || !data.success || data.item?.itemcode !== code || !data.item?.product_name?.trim()) throw new Error(data.error || "Không tìm thấy item, vui lòng cập nhật database.");
      setItem(data.item);
    } catch (cause) { if (!controller.signal.aborted && formVersion.current === version) { setItem(null); setLookupError(cause instanceof Error ? cause.message : "Không tra cứu được sản phẩm."); } }
    finally { if (!controller.signal.aborted && formVersion.current === version) setLookingUp(false); }
  }, []);

  useEffect(() => () => lookupRequest.current?.abort(), []);

  const fillForm = useCallback((row: ManualIncomingLine) => {
    changeCode(row.itemcode); setReceivedDate(row.received_date); setProductionDate(row.production_date || "");
    setWO(row.wo || ""); setQuantity(String(row.quantity)); setNote(row.note);
    void lookup(row.itemcode);
  }, [changeCode, lookup]);

  const clearForm = useCallback(() => {
    changeCode(""); setProductionDate(""); setWO(""); setQuantity(""); setNote("");
    itemInput.current?.focus();
  }, [changeCode]);

  useEffect(() => {
    if (ready && !busy && !recovering && !conflict && !recoveryBlocked) itemInput.current?.focus();
  }, [ready, busy, recovering, conflict, recoveryBlocked]);

  const writeSaved = useCallback((next: StoredIncoming | null) => {
    try {
      if (window.localStorage.getItem(storageKey) !== storedRaw.current) { setConflict(true); return false; }
      const raw = next ? JSON.stringify(next) : null;
      if (raw === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, raw);
      storedRaw.current = raw; setSaved(next);
      return true;
    } catch { setNotice({ type: "error", text: "Không lưu được thao tác trên trình duyệt. Kiểm tra quyền lưu dữ liệu rồi thử lại." }); return false; }
  }, [storageKey]);

  function clearLegacy() {
    if (!legacyRaw.current) return;
    try { window.sessionStorage.removeItem(LEGACY_PENDING_KEY); } catch { /* Original UUID still prevents duplicate posting on a later recovery. */ }
    legacyRaw.current = null;
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        storedRaw.current = window.localStorage.getItem(storageKey);
        let restored = storedRaw.current ? parseStoredIncoming(storedRaw.current) : null;
        if (!restored) {
          try { legacyRaw.current = window.sessionStorage.getItem(LEGACY_PENDING_KEY); } catch { /* New requests use local storage. */ }
          if (legacyRaw.current) {
            const legacy = JSON.parse(legacyRaw.current);
            const rows = legacy.drafts.map((row: ManualIncomingLine) => ({ itemcode: row.itemcode, received_date: row.received_date,
              production_date: row.production_date || null, wo: row.wo || null, quantity: row.quantity, note: row.note }));
            restored = { ...parseManualIncomingRequest({ request_id: legacy.request_id, rows }), status: "pending", action: "post", expiresAt: Date.now() + INCOMING_DRAFT_TTL };
          }
        }
        if (!restored) return;
        if (restored.expiresAt <= Date.now()) {
          if (writeSaved(null)) setNotice({ type: "error", text: restored.status === "pending" ? "Bản lưu đã hết hạn 7 ngày. Hãy kiểm tra Proposal và lịch sử nhập kho trước khi nhập lại lần chưa rõ kết quả." : "Bản nháp cũ đã hết hạn 7 ngày và được xóa." });
          return;
        }
        setSaved(restored);
        if (restored.status === "draft" && restored.rows.length === 1) fillForm(restored.rows[0]);
      } catch { setRecoveryBlocked(true); setNotice({ type: "error", text: "Không đọc được bản lưu cũ. Giữ nguyên bộ nhớ và kiểm tra lần nhập trước khi tiếp tục." }); }
      finally { setReady(true); }
    });
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === storageKey || event.key === null)) setConflict(window.localStorage.getItem(storageKey) !== storedRaw.current);
    };
    window.addEventListener("storage", onStorage);
    return () => { cancelled = true; window.removeEventListener("storage", onStorage); };
  }, [fillForm, storageKey, writeSaved]);

  useEffect(() => {
    if (!saved || busy || conflict || legacyRaw.current) return;
    const expire = () => {
      if (Date.now() < saved.expiresAt || busyRef.current) return;
      if (writeSaved(null)) {
        clearForm(); setRecoverOne(false); setReceivedDate(todayInVietnam());
        setNotice({ type: "error", text: saved.status === "pending" ? "Bản lưu đã hết hạn 7 ngày. Kiểm tra Proposal/lịch sử nhập kho trước khi nhập lại." : "Bản nháp đã hết hạn 7 ngày và được xóa." });
      }
    };
    const timer = window.setTimeout(expire, Math.max(0, saved.expiresAt - Date.now()));
    window.addEventListener("focus", expire);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", expire); };
  }, [saved, busy, conflict, writeSaved, clearForm]);

  async function send(record: StoredIncoming) {
    const posting = record.status === "pending" && (record.action ?? "post") === "post";
    if (busyRef.current || locked || (posting && !canEdit)) return;
    if (record.expiresAt <= Date.now()) { setNotice({ type: "error", text: "Bản lưu đã hết hạn. Tải lại trang và kiểm tra kết quả trước khi nhập lại." }); return; }
    if (legacyRaw.current) {
      try {
        if (window.sessionStorage.getItem(LEGACY_PENDING_KEY) !== legacyRaw.current || window.localStorage.getItem(storageKey) !== storedRaw.current) { setConflict(true); return; }
      } catch { setNotice({ type: "error", text: "Không kiểm tra được lần nhập cũ để thử lại." }); return; }
    } else if (!writeSaved(record)) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    try {
      const response = await fetch(posting ? "/api/warehouse-receipt/incoming" : "/api/warehouse-receipt/incoming-proposals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile_id: profileId, request_id: record.request_id, rows: record.rows }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        if ([400, 404].includes(response.status)) {
          const rows = incomingStoredRows(record).map(({ itemcode, received_date, production_date, wo, quantity, note }) => ({ itemcode, received_date, production_date, wo, quantity, note }));
          const draft: StoredIncoming = { request_id: window.crypto.randomUUID(), rows, status: "draft", action: "propose", expiresAt: record.expiresAt };
          if (writeSaved(draft)) { clearLegacy(); if (rows.length === 1) fillForm(rows[0]); }
        }
        throw new Error(data.error || "Chưa xác nhận được kết quả. Thử lại cùng thao tác để tránh ghi trùng.");
      }
      if (data.batch?.batch_id !== record.request_id || data.batch?.row_count !== record.rows.length) throw new Error("Chưa xác nhận được kết quả. Hãy thử lại thao tác đã lưu.");
      const remainder = completeIncomingSubmission(record, window.crypto.randomUUID());
      if (!writeSaved(remainder)) return;
      clearLegacy(); clearForm(); setRecoverOne(false);
      if (remainder?.rows.length === 1) fillForm(remainder.rows[0]);
      setProposalRevision((value) => value + 1);
      setNotice({ type: "success", text: `${posting ? "Đã kiểm tra và hoàn tất lần nhập kho cũ" : "Đã gửi Proposal nhập kho chờ supervisor duyệt"}: ${data.batch.row_count} dòng.${remainder ? " Các dòng còn lại được giữ để gửi tiếp." : ""}` });
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "Chưa xác nhận được kết quả. Thử lại cùng thao tác đã lưu." }); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || recovering || busyRef.current) return;
    try {
      if (!isInventoryDate(productionDate)) throw new Error("Vui lòng nhập ngày sản xuất hợp lệ.");
      const body = parseManualIncomingRequest({ request_id: window.crypto.randomUUID(), rows: [{ itemcode, received_date: receivedDate,
        production_date: productionDate, wo, quantity: Number(quantity), note }] });
      const remaining = recoverOne && saved?.status === "draft" ? saved.rows.slice(1) : [];
      await send({ ...body, status: "pending", action: "propose", expiresAt: Date.now() + INCOMING_DRAFT_TTL,
        ...(remaining.length ? { remaining_rows: remaining } : {}) });
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "Thông tin nhập kho không hợp lệ." }); }
  }

  return <div className="warehouse-incoming">
    {notice ? <p className={`alert alert-${notice.type}`} role="status">{notice.text}</p> : null}
    {conflict ? <p className="alert alert-error" role="alert">Bản lưu đã thay đổi ở tab khác. Tải lại trang trước khi tiếp tục.</p> : null}
    {saved ? <div className="alert" role="status">
      {saved.status === "pending" ? <p>Có lần {legacyPosting ? "nhập kho cũ" : "gửi Proposal"} chưa rõ kết quả. Giữ nguyên mã thao tác để kiểm tra lại.</p>
        : saved.rows.length > 1 ? <p>Còn {saved.rows.length} dòng bản nháp cũ chưa gửi. Chuyển các dòng này sang Proposal để supervisor kiểm tra và duyệt.</p>
          : <p>Đã khôi phục nội dung chưa gửi vào form. Có thể sửa thông tin và gửi Proposal.</p>}
      {recovering ? <button className="button button-secondary" disabled={locked || (legacyPosting && !canEdit)} type="button" onClick={() => {
        const record: StoredIncoming = saved.status === "pending" ? saved : { request_id: saved.request_id, rows: saved.rows, status: "pending", action: "propose", expiresAt: Date.now() + INCOMING_DRAFT_TTL };
        return send(record);
      }}>{busy ? "Đang xử lý…" : saved.status === "pending" ? "Kiểm tra lại thao tác đã lưu" : `Chuyển ${saved.rows.length} dòng sang Proposal`}</button> : null}
      {legacyPosting && !canEdit ? <p>Cần quyền edit-WH để kiểm tra lần nhập kho cũ này.</p> : null}
      {saved.status === "draft" && saved.rows.length > 1 ? <button className="button button-secondary" disabled={locked} type="button" onClick={() => { fillForm(saved.rows[0]); setRecoverOne(true); }}>Khôi phục từng dòng vào form</button> : null}
    </div> : null}
    <section className="warehouse-incoming-form">
      <div className="warehouse-incoming-heading">
        <div><h2>Nhập kho thủ công</h2><p className="muted small">Nhập thông tin rồi nhấn Enter hoặc Gửi Proposal. Supervisor duyệt tại danh sách Proposal bên dưới để ghi nhận tồn kho.</p></div>
        {canEdit || isSuperAdmin ? <div className="warehouse-incoming-admin-actions">
          {canEdit ? <WarehouseCatalogEditors onSaved={(code) => { if (itemcode.trim() === code) void lookup(code); }} /> : null}
          {isSuperAdmin ? <><WarehouseOpeningInventory /><WarehouseMasterData /><WarehouseItemBuildUp /></> : null}
        </div> : null}
      </div>
      <form onSubmit={propose}>
        <fieldset disabled={locked || recovering} className="warehouse-incoming-fieldset">
          <div className="warehouse-incoming-fields">
            <label><span>Mã sản phẩm <span className="warehouse-required">*</span></span><input ref={itemInput} required autoComplete="off" maxLength={200} value={itemcode}
              aria-describedby={`${id}-lookup-note`} aria-invalid={Boolean(lookupError)} placeholder="Nhập itemcode, ví dụ 11011*209"
              onChange={(event) => changeCode(event.target.value)} onBlur={() => { void lookup(itemcode); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); quantityInput.current?.focus(); } }} /></label>
            <label><span>Số lượng <span className="warehouse-required">*</span></span><input ref={quantityInput} required type="number" inputMode="numeric" min={1} max={2147483647} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Nhập số lượng" /></label>
            <label><span>Ngày nhập kho <span className="warehouse-required">*</span></span><input required type="date" value={receivedDate} onChange={(event) => setReceivedDate(event.target.value)} /></label>
            <dl className="warehouse-incoming-item-details"><div><dt>Tên sản phẩm</dt><dd>{item?.product_name || "—"}</dd></div><div><dt>Khách hàng</dt><dd>{item?.customer || "—"}</dd></div></dl>
            <p id={`${id}-lookup-note`} className="muted small warehouse-incoming-lookup-note" aria-live="polite">{lookingUp ? "Đang tra cứu sản phẩm; bạn có thể nhập tiếp. Hệ thống kiểm tra lại thông tin khi gửi Proposal." : "Dấu * được thay bằng số 0 để đủ 13 ký tự. Tên sản phẩm và khách hàng tự điền theo mã."}</p>
            <label><span>Ngày sản xuất <span className="warehouse-required">*</span></span><input required type="date" value={productionDate} onChange={(event) => setProductionDate(event.target.value)} /></label>
            <label><span>WO <small className="warehouse-field-hint">Không bắt buộc</small></span><input maxLength={200} value={wo} onChange={(event) => setWO(event.target.value)} /></label>
            <label className="warehouse-incoming-note"><span>Ghi chú <small className="warehouse-field-hint">Không bắt buộc</small></span><textarea rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          </div>
          {lookupError ? <p className="alert alert-error" role="alert">{lookupError}</p> : null}
          <div className="warehouse-incoming-actions">{recoverOne ? <button className="button button-secondary" type="button" onClick={() => { setRecoverOne(false); clearForm(); }}>Quay lại khôi phục bản cũ</button>
            : <button className="button button-secondary" type="button" onClick={() => { if (!saved || writeSaved(null)) clearForm(); }}>Xóa nội dung</button>}
            <button className="button button-primary" type="submit">{busy ? "Đang gửi…" : "Gửi Proposal nhập kho"}</button></div>
        </fieldset>
      </form>
    </section>
    <WarehouseIncomingProposals canEdit={canEdit} profileId={profileId} revision={proposalRevision} />
  </div>;
}
