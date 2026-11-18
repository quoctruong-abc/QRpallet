"use client";

import { useEffect, useId, useRef, useState } from "react";
import { parseManualIncomingRequest, type ManualIncomingLine } from "@/lib/warehouse-receipt/incoming";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { WarehouseActionConfirmation } from "./warehouse-action-confirmation";

type Proposal = ManualIncomingLine & {
  id: string; version: number; product_name: string; customer: string | null;
  proposed_by_name: string; created_at: string;
};
type Approval = { request_id: string; rows: { id: string; version: number }[] };
const date = (value: string | null) => value ? value.split("-").reverse().join("/") : "—";
const num = (value: number) => value.toLocaleString("vi-VN");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function WarehouseIncomingProposals({ canEdit, profileId, revision }: { canEdit: boolean; profileId: string; revision: number }) {
  const titleId = useId();
  const editor = useRef<HTMLDialogElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const storageKey = `warehouse-incoming-approval-v1:${profileId}`;
  const [rows, setRows] = useState<Proposal[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Approval | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<Proposal | null>(null);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [editError, setEditError] = useState("");
  const lookupVersion = useRef(0);
  const selected = rows.filter((row) => !excluded.has(row.id));
  const locked = busy || Boolean(pending) || !ready || blocked;

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const value = JSON.parse(raw);
          if (!uuid(value.request_id) || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 500
            || !value.rows.every((row: Approval["rows"][number]) => uuid(row.id) && Number.isSafeInteger(row.version) && row.version > 0)) throw new Error();
          setPending(value);
        }
      } catch { setBlocked(true); setError("Không đọc được lần duyệt đã lưu. Kiểm tra kết quả nhập kho và quyền lưu dữ liệu trước khi tiếp tục."); }
      finally { setReady(true); }
    });
    return () => { cancelled = true; };
  }, [storageKey]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const response = await fetch(`/api/warehouse-receipt/incoming-proposals?offset=${offset}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || "Không tải được đề xuất nhập kho.");
        if (controller.signal.aborted) return;
        setRows(data.rows); setTotal(data.total); setLoadError("");
      } catch (cause) { if (!controller.signal.aborted) { setRows([]); setLoadError(cause instanceof Error ? cause.message : "Không tải được đề xuất."); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    });
    return () => controller.abort();
  }, [offset, reload, revision]);

  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selected.length > 0 && selected.length < rows.length; }, [selected.length, rows.length]);

  async function approve() {
    if (!canEdit || busyRef.current || blocked || !ready || (!pending && (!selected.length || loading))) return;
    const command = pending ?? { request_id: window.crypto.randomUUID(), rows: selected.map(({ id, version }) => ({ id, version })) };
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== (pending ? JSON.stringify(pending) : null)) throw new Error("Lần duyệt đã thay đổi ở tab khác. Tải lại trang trước khi tiếp tục.");
      window.localStorage.setItem(storageKey, JSON.stringify(command));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Không lưu được lần duyệt trên trình duyệt."); return; }
    setPending(command); busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/warehouse-receipt/incoming-proposals", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...command, action: "approve", profile_id: profileId }) });
      const data = await response.json();
      if (!response.ok || !data.success) {
        if ([400, 403, 404, 409, 503].includes(response.status)) {
          if (window.localStorage.getItem(storageKey) === JSON.stringify(command)) { window.localStorage.removeItem(storageKey); setPending(null); }
          setReload((value) => value + 1);
        }
        throw new Error(data.error || "Chưa xác nhận được kết quả duyệt. Thử lại cùng thao tác để tránh ghi trùng.");
      }
      if (data.batch?.batch_id !== command.request_id || data.batch?.row_count !== command.rows.length) throw new Error("Chưa xác nhận được kết quả duyệt. Hãy thử lại thao tác đã lưu.");
      if (window.localStorage.getItem(storageKey) !== JSON.stringify(command)) throw new Error("Lần duyệt đã thay đổi ở tab khác. Tải lại để kiểm tra kết quả.");
      window.localStorage.removeItem(storageKey); setPending(null);
      setNotice(`Đã duyệt và nhập kho ${data.batch.row_count} dòng · Tổng số lượng ${num(Number(data.batch.total_quantity))}.`);
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chưa xác nhận được kết quả duyệt."); }
    finally { busyRef.current = false; setBusy(false); setConfirming(false); }
  }

  async function saveEdit(remove = false) {
    const row = remove ? deleting : editing;
    if (!canEdit || !row || locked || busyRef.current) return;
    let value: ManualIncomingLine | undefined;
    try { if (!remove) value = parseManualIncomingRequest({ request_id: row.id, rows: [row] }).rows[0]; }
    catch (cause) { setEditError(cause instanceof Error ? cause.message : "Dữ liệu không hợp lệ."); return; }
    busyRef.current = true; setBusy(true); setEditError(""); setError("");
    try {
      const response = await fetch("/api/warehouse-receipt/incoming-proposals", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: remove ? "delete" : "edit", profile_id: profileId, id: row.id, version: row.version, row: value }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không cập nhật được đề xuất. Tải lại danh sách để kiểm tra.");
      lookupVersion.current++; editor.current?.close(); setEditing(null); setDeleting(null); setReload((old) => old + 1);
      setNotice(remove ? "Đã xóa dòng đề xuất khỏi danh sách chờ." : "Đã cập nhật dòng đề xuất.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Không cập nhật được đề xuất.";
      if (remove) setError(message); else setEditError(message);
    } finally { busyRef.current = false; setBusy(false); if (remove) setDeleting(null); }
  }

  async function lookupItem() {
    if (!editing) return;
    const version = ++lookupVersion.current;
    try {
      const code = normalizeWarehouseItemcode(editing.itemcode);
      const response = await fetch("/api/warehouse-receipt/item-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemcode: code }) });
      const data = await response.json();
      if (lookupVersion.current !== version) return;
      if (!response.ok || !data.success) throw new Error(data.error || "Không tra được sản phẩm.");
      setEditing((current) => current ? { ...current, itemcode: code, product_name: data.item.product_name, customer: data.item.customer } : current); setEditError("");
    } catch (cause) { if (lookupVersion.current === version) setEditError(cause instanceof Error ? cause.message : "Không tra được sản phẩm."); }
  }

  return <section className="scan-table-card warehouse-incoming-proposals">
    <div className="warehouse-incoming-draft-heading"><h2>Đề xuất nhập kho chờ duyệt <span className="muted">({num(total)})</span></h2>
      <p className="muted small">Danh sách dùng chung. {canEdit ? `Đã chọn ${selected.length}/${rows.length} dòng trên trang; duyệt để ghi nhận tồn kho.` : "Supervisor có quyền edit-WH sẽ duyệt và ghi nhận tồn kho."}</p>
      <button className="button button-secondary button-small" disabled={busy || loading} type="button" onClick={() => setReload((value) => value + 1)}>Tải lại đề xuất</button>
    </div>
    {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
    {loadError ? <p className="alert alert-error" role="alert">{loadError}</p> : null}
    {notice ? <p className="alert alert-success" role="status">{notice}</p> : null}
    {pending ? <p className="alert" role="status">Có lần duyệt chưa rõ kết quả. {canEdit ? "Thử lại cùng thao tác để kiểm tra, không nhập trùng." : "Cần quyền edit-WH để kiểm tra lại lần duyệt đã lưu."}</p> : null}
    {loading ? <p className="scan-empty" role="status">Đang tải đề xuất…</p> : rows.length ? <div className="scan-table-wrap"><table className="warehouse-table">
      <thead><tr>{canEdit ? <th><input type="checkbox" ref={allRef} aria-label="Chọn tất cả đề xuất trên trang" checked={rows.length > 0 && selected.length === rows.length} disabled={locked} onChange={(event) => { const checked = event.target.checked; setExcluded((current) => { const next = new Set(current); for (const row of rows) { if (checked) next.delete(row.id); else next.add(row.id); } return next; }); }} /></th> : null}
        <th>Người đề xuất</th><th>Ngày nhập</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>Ngày sản xuất</th><th>WO</th><th>Số lượng</th><th>Ghi chú</th>{canEdit ? <th>Thao tác</th> : null}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>{canEdit ? <td><input type="checkbox" aria-label={`Chọn đề xuất ${row.id}`} checked={!excluded.has(row.id)} disabled={locked} onChange={(event) => { const checked = event.target.checked; setExcluded((current) => { const next = new Set(current); if (checked) next.delete(row.id); else next.add(row.id); return next; }); }} /></td> : null}
        <td>{row.proposed_by_name}</td><td>{date(row.received_date)}</td><td>{row.itemcode}</td><td>{row.product_name}</td><td>{row.customer || "—"}</td><td>{date(row.production_date)}</td><td>{row.wo || "—"}</td><td>{num(row.quantity)}</td><td>{row.note || "—"}</td>
        {canEdit ? <td><div className="warehouse-incoming-row-actions"><button className="button button-secondary button-small" type="button" disabled={locked} onClick={() => { lookupVersion.current++; setEditing({ ...row }); setEditError(""); editor.current?.showModal(); }}>Sửa</button>
          <button className="button button-secondary button-small" type="button" disabled={locked} onClick={() => setDeleting(row)}>Xóa</button></div></td> : null}</tr>)}</tbody>
    </table></div> : <p className="scan-empty">Chưa có đề xuất nhập kho chờ duyệt.</p>}
    <div className="warehouse-incoming-next">
      {offset > 0 ? <button className="button button-secondary" type="button" disabled={locked || loading} onClick={() => setOffset(Math.max(0, offset - 100))}>Trước</button> : null}
      {offset + rows.length < total ? <button className="button button-secondary" type="button" disabled={locked || loading} onClick={() => setOffset(offset + 100)}>Sau</button> : null}
      {canEdit ? <button className="button button-primary" type="button" disabled={busy || !ready || blocked || (!pending && (loading || !selected.length))} onClick={() => setConfirming(true)}>{pending ? "Thử lại lần duyệt đã lưu" : "Duyệt và nhập kho các dòng đã chọn"}</button> : null}
    </div>
    <WarehouseActionConfirmation open={confirming} title={pending ? "Kiểm tra lại lần duyệt nhập kho?" : "Duyệt và nhập kho?"} confirmLabel={pending ? "Đồng ý thử lại" : "Duyệt và nhập kho"} busy={busy}
      disabled={!canEdit || blocked || !ready || (!pending && (loading || !selected.length))} onCancel={() => setConfirming(false)} onConfirm={approve}>
      <p>{pending ? `Tiếp tục cùng mã thao tác cho ${pending.rows.length} dòng đã lưu.` : `Duyệt ${selected.length} dòng đã chọn · Tổng số lượng ${num(selected.reduce((sum, row) => sum + row.quantity, 0))}.`}</p>
      <p>Tồn kho được cập nhật sau khi xác nhận; các dòng chưa chọn vẫn chờ duyệt.</p>
    </WarehouseActionConfirmation>
    <WarehouseActionConfirmation open={Boolean(deleting)} title="Xóa đề xuất nhập kho?" confirmLabel="Xóa dòng" busy={busy} disabled={!canEdit || locked}
      onCancel={() => setDeleting(null)} onConfirm={() => saveEdit(true)}><p>Xóa dòng {deleting?.itemcode} khỏi danh sách chờ duyệt?</p></WarehouseActionConfirmation>
    <dialog ref={editor} className="modal-card warehouse-opening-dialog warehouse-catalog-dialog" aria-labelledby={titleId} onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => { lookupVersion.current++; setEditing(null); }}>
      <div className="modal-heading"><h2 id={titleId}>Sửa đề xuất nhập kho</h2><button className="modal-close" type="button" aria-label="Đóng sửa đề xuất" disabled={busy} onClick={() => editor.current?.close()}>×</button></div>
      {editing ? <form onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}><div className="warehouse-incoming-fields">
        <label><span>Mã sản phẩm</span><input required value={editing.itemcode} maxLength={200} disabled={busy} onBlur={() => { void lookupItem(); }} onChange={(event) => { lookupVersion.current++; setEditing({ ...editing, itemcode: event.target.value, product_name: "", customer: null }); }} /></label>
        <label><span>Số lượng</span><input required type="number" min={1} max={2147483647} step={1} disabled={busy} value={editing.quantity} onChange={(event) => setEditing({ ...editing, quantity: Number(event.target.value) })} /></label>
        <label><span>Ngày nhập kho</span><input required type="date" disabled={busy} value={editing.received_date} onChange={(event) => setEditing({ ...editing, received_date: event.target.value })} /></label>
        <label><span>Ngày sản xuất</span><input required type="date" disabled={busy} value={editing.production_date || ""} onChange={(event) => setEditing({ ...editing, production_date: event.target.value })} /></label>
        <label><span>WO</span><input disabled={busy} maxLength={200} value={editing.wo || ""} onChange={(event) => setEditing({ ...editing, wo: event.target.value })} /></label>
        <label><span>Ghi chú</span><input disabled={busy} maxLength={2000} value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} /></label>
      </div><p>{editing.product_name || "—"} · {editing.customer || "Chưa có tên khách hàng"}</p>{editError ? <p className="alert alert-error" role="alert">{editError}</p> : null}
        <div className="modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => editor.current?.close()}>Đóng</button><button className="button button-primary" type="submit" disabled={locked || !canEdit}>Lưu thay đổi</button></div>
      </form> : null}
    </dialog>
  </section>;
}
