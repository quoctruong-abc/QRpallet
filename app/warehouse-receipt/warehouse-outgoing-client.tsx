"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import type { DeliveryPreviewLine, DeliveryRequest } from "@/lib/warehouse-receipt/outgoing";

type Command = { action: string; command_id: string; profile_id: string; payload: Record<string, unknown> };
type History = { id: string; quantity: number; shipped_date: string; entered_by_name: string; inv_delivery_issue_lines: { incoming_id: number; quantity: number; inv_incoming: { received_date: string; production_date: string | null } }[] };
type Lot = { incoming_id: number; quantity: number; inv_incoming: { received_date: string; production_date: string | null; balance_qty: number; reserved_qty: number; available_qty: number } };
const num = (n: number) => Number(n).toLocaleString("vi-VN");
const date = (v: string | null) => v ? v.split("-").reverse().join("/") : "—";
const statusLabel = { pending: "Chờ xuất", partial: "Xuất một phần", done: "Done", cancelled: "Đã hủy" };

export function WarehouseOutgoingClient({ profileId }: { profileId: string }) {
  const id = useId();
  const key = `warehouse-outgoing-command-v1:${profileId}`;
  const importDialog = useRef<HTMLDialogElement>(null);
  const actionDialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [rows, setRows] = useState<DeliveryRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [listError, setListError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DeliveryPreviewLine[] | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<DeliveryRequest | null>(null);
  const [mode, setMode] = useState<"ship" | "edit" | "cancel" | "history">("ship");
  const [quantity, setQuantity] = useState("");
  const [actionDate, setActionDate] = useState(todayInVietnam);
  const [history, setHistory] = useState<History[]>([]);
  const [lots, setLots] = useState<Lot[]>([]);
  const [detailError, setDetailError] = useState("");
  const loadVersion = useRef(0);
  const detailVersion = useRef(0);
  const locked = busy || Boolean(pending) || blocked || !ready;

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, offset: String(offset), closed: String(closed) });
      const response = await fetch(`/api/warehouse-receipt/outgoing?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Không tải được danh sách chờ.");
      if (version !== loadVersion.current) return;
      setRows(data.rows);
      setTotal(data.total);
      if (offset > 0 && offset >= data.total) setOffset(data.total > 0 ? Math.floor((data.total - 1) / 100) * 100 : 0);
      setListError("");
    } catch (error) {
      if (version === loadVersion.current) setListError(error instanceof Error ? error.message : "Không tải được danh sách.");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [search, offset, closed]);

  const cancelLoad = useCallback(() => { loadVersion.current++; }, []);
  useEffect(() => { void Promise.resolve().then(load); return cancelLoad; }, [load, cancelLoad]);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const command = JSON.parse(saved) as Command;
          if (command.profile_id !== profileId || typeof command.command_id !== "string" || !["import", "edit", "cancel", "reserve", "ship"].includes(command.action) || !command.payload) throw new Error("Invalid saved command");
          setPending(command);
          setNotice("Có thao tác xuất kho chưa rõ kết quả. Bấm Thử lại để kiểm tra, không tạo thao tác mới.");
        }
      } catch {
        setBlocked(true);
        setNotice("Không đọc được thao tác đã lưu. Cần kiểm tra kết quả xuất kho và quyền lưu dữ liệu trước khi tiếp tục.");
      } finally { setReady(true); }
    });
    return () => { cancelled = true; };
  }, [key, profileId]);

  async function execute(action: string, payload: Record<string, unknown>, retry?: Command) {
    if (busyRef.current || blocked || !ready) return;
    if (pending && !retry) return;
    let command = retry;
    try {
      const saved = localStorage.getItem(key);
      if (!command) {
        if (saved) {
          setBlocked(true);
          setNotice("Tab khác có thao tác chưa hoàn tất. Tải lại trang để kiểm tra trước khi tiếp tục.");
          return;
        }
        command = { action, payload, profile_id: profileId, command_id: crypto.randomUUID() };
        localStorage.setItem(key, JSON.stringify(command));
      }
    } catch {
      setNotice("Không lưu được mã thao tác trên trình duyệt. Cho phép lưu dữ liệu rồi thử lại.");
      return;
    }
    const current = command;
    if (!current) return;
    setPending(current);
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/warehouse-receipt/outgoing", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        if ([400, 409, 503].includes(response.status)) {
          // These are explicit rejected/rolled-back requests, not ambiguous transport failures.
          if (JSON.parse(localStorage.getItem(key) || "null")?.command_id === current.command_id) localStorage.removeItem(key);
          setPending(null);
        }
        throw new Error(data.error || "Chưa xác nhận được kết quả.");
      }
      if (JSON.parse(localStorage.getItem(key) || "null")?.command_id === current.command_id) localStorage.removeItem(key);
      setPending(null);
      setPreview(null);
      importDialog.current?.close();
      actionDialog.current?.close();
      setSelected(null);
      setNotice(current.action === "ship" ? `Đã ghi nhận xuất ${num(data.result.shipped)}.`
        : current.action === "import" ? `Đã nạp/cập nhật ${data.result.changed} dòng; bỏ qua ${data.result.skipped} dòng không đổi.`
        : current.action === "cancel" ? "Đã hủy phần chờ và trả lại On order."
        : current.action === "reserve" ? "Đã bổ sung On order theo thứ tự ngày giao, trong phạm vi tồn có thể cấp."
        : "Đã cập nhật yêu cầu giao hàng.");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Chưa xác nhận được kết quả. Hãy thử lại cùng thao tác.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function upload() {
    if (!file || locked || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setUploadError("");
    setPreview(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/warehouse-receipt/outgoing", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error([data.error, ...(data.errors || []).map((e: { row: number; message: string }) => `Dòng ${e.row}: ${e.message}`)].join("\n"));
      const parsed = (data.rows as DeliveryPreviewLine[]).slice().sort((a, b) => a.excel_row - b.excel_row);
      setPreview(parsed);
      setChoices(Object.fromEntries(parsed.map((row) => [row.excel_row, row.existing?.id || (row.candidates.length ? "" : "new")])));
    } catch (error) { setUploadError(error instanceof Error ? error.message : "Không kiểm tra được file."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  function importRows() {
    if (!preview || !file) return;
    const inputs = preview.map((row) => {
      const choice = choices[row.excel_row];
      const target = choice === row.existing?.id ? row.existing : row.candidates.find((candidate) => candidate.id === choice);
      return {
        ...row, existing: undefined, candidates: undefined, available_qty: undefined, suggested_reserved: undefined, shortage_qty: undefined,
        mode: choice === "new" ? "new" : "update", target_id: target?.id ?? null, expected_version: target?.version ?? null,
      };
    });
    void execute("import", { rows: inputs, file_name: file.name });
  }

  async function openAction(row: DeliveryRequest, action: typeof mode) {
    setSelected(row);
    setMode(action);
    setQuantity(String(action === "edit" ? row.ordered_qty : row.reserved_qty));
    setActionDate(action === "edit" ? row.delivery_date : todayInVietnam());
    setHistory([]);
    setLots([]);
    setDetailError("");
    actionDialog.current?.showModal();
    const version = ++detailVersion.current;
    try {
      const response = await fetch(`/api/warehouse-receipt/outgoing?id=${row.id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error);
      if (version === detailVersion.current) {
        setHistory(data.history);
        setLots((data.allocations as Lot[]).sort((a, b) =>
          (a.inv_incoming.production_date || a.inv_incoming.received_date).localeCompare(b.inv_incoming.production_date || b.inv_incoming.received_date)
          || a.inv_incoming.received_date.localeCompare(b.inv_incoming.received_date) || a.incoming_id - b.incoming_id));
      }
    } catch (error) { if (version === detailVersion.current) setDetailError(error instanceof Error ? error.message : "Không tải được chi tiết."); }
  }

  const invalidChoice = preview?.some((row) => {
    const chosen = row.existing?.id === choices[row.excel_row] ? row.existing : row.candidates.find((c) => c.id === choices[row.excel_row]);
    return !choices[row.excel_row] || (chosen && !chosen.cancelled && row.ordered_qty < chosen.shipped_qty);
  }) ?? true;

  return <div className="warehouse-outgoing">
    <div className="warehouse-outgoing-toolbar">
      <button className="button button-primary" disabled={locked} onClick={() => importDialog.current?.showModal()} type="button">Nạp lịch giao ERP</button>
      <button className="button button-secondary" disabled={locked} onClick={() => { void execute("reserve", {}); }} type="button">Bổ sung On order</button>
      <button className="button button-secondary" disabled={loading} onClick={() => { void load(); }} type="button">Tải lại</button>
    </div>
    <p className="muted small">On order là hàng đã giữ. Tồn thực tế chỉ giảm khi xác nhận xuất. Bổ sung On order sau khi có hàng nhập mới.</p>
    {notice ? <p role="status" className="alert">{notice}</p> : null}
    {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">{busy ? "Đang xử lý…" : "Thử lại thao tác chưa rõ kết quả"}</button> : null}
    {listError ? <p role="alert" className="alert alert-error">{listError}</p> : null}
    <form className="warehouse-outgoing-toolbar" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(searchInput); }}>
      <input aria-label="Tìm yêu cầu xuất" onChange={(event) => setSearchInput(event.target.value)} placeholder="Tìm PO, Sales ID, item, khách hàng" value={searchInput} />
      <button className="button button-secondary" type="submit">Tìm</button>
      <label className="warehouse-outgoing-checkbox"><input checked={closed} onChange={(event) => { setClosed(event.target.checked); setOffset(0); }} type="checkbox" />Hiện cả Done / Đã hủy</label>
    </form>
    <section className="scan-table-card">
      <div className="warehouse-incoming-draft-heading"><h2>Danh sách chờ xuất hàng ({total})</h2></div>
      <div className="scan-table-wrap"><table className="warehouse-table">
        <thead><tr><th>Ngày giao</th><th>PO</th><th>Sales ID</th><th>Item</th><th>Tên / Khách hàng</th><th>ĐVT</th><th>Yêu cầu</th><th>Đã xuất</th><th>On order</th><th>Còn thiếu</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className={row.shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
          <td>{date(row.delivery_date)}</td><td>{row.purorder}</td><td>{row.sales_id}</td><td>{row.itemcode}</td>
          <td className="warehouse-outgoing-name">{row.product_name}<small>{row.customer}</small></td><td>{row.unit_label}</td>
          <td>{num(row.ordered_qty)}</td><td>{num(row.shipped_qty)}</td><td>{num(row.reserved_qty)}</td><td>{num(row.shortage_qty)}</td><td>{statusLabel[row.status]}</td>
          <td><div className="warehouse-incoming-row-actions">
            {!row.cancelled && row.shipped_qty < row.ordered_qty ? <>
              <button className="button button-primary button-small" disabled={locked || row.reserved_qty === 0} onClick={() => { void openAction(row, "ship"); }} type="button">Xuất</button>
              <button className="button button-secondary button-small" disabled={locked} onClick={() => { void openAction(row, "edit"); }} type="button">Sửa / Dời ngày</button>
              <button className="button button-secondary button-small" disabled={locked} onClick={() => { void openAction(row, "cancel"); }} type="button">Hủy phần chờ</button>
            </> : null}
            <button className="button button-secondary button-small" onClick={() => { void openAction(row, "history"); }} type="button">Chi tiết</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length ? <p className="scan-empty">{loading ? "Đang tải…" : "Không có yêu cầu giao hàng."}</p> : null}
      <div className="warehouse-incoming-next">
        <button className="button button-secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))} type="button">Trước</button>
        <span>{total ? `${offset + 1}–${Math.min(offset + 100, total)} / ${total}` : "0"}</span>
        <button className="button button-secondary" disabled={offset + 100 >= total || loading} onClick={() => setOffset(offset + 100)} type="button">Sau</button>
      </div>
    </section>

    <dialog aria-labelledby={`${id}-import-title`} className="modal-card warehouse-opening-dialog" onCancel={(event) => { if (busy) event.preventDefault(); }} ref={importDialog}>
      <div className="modal-heading"><h2 id={`${id}-import-title`}>Nạp lịch giao ERP</h2><button aria-label="Đóng nạp ERP" className="modal-close" disabled={busy} onClick={() => importDialog.current?.close()} type="button">×</button></div>
      <label>File lịch giao<input accept=".xlsx" disabled={locked} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setUploadError(""); }} type="file" /></label>
      <p className="muted small">Đọc đúng vùng merge. Khóa chống trùng: PO + Sales ID + Item + ngày giao. Kiểm tra file chưa đăng ký On order.</p>
      {uploadError ? <p role="alert" className="alert alert-error warehouse-outgoing-error">{uploadError}</p> : null}
      {notice ? <p role="status" className="alert">{notice}</p> : null}
      {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">Thử lại thao tác chưa rõ kết quả</button> : null}
      {preview ? <>
        <p><strong>{preview.length} dòng.</strong> Có {preview.filter((row) => row.shortage_qty > 0).length} dòng thiếu hàng dự kiến. Số giữ thực tế được kiểm tra lại lúc xác nhận.</p>
        <div className="scan-table-wrap warehouse-outgoing-preview"><table className="warehouse-table">
          <thead><tr><th>Dòng</th><th>Ngày giao</th><th>PO / Sales ID</th><th>Item</th><th>Yêu cầu</th><th>Đã xuất</th><th>Dự kiến giữ</th><th>Thiếu</th><th>Cách nạp</th></tr></thead>
          <tbody>{preview.map((row) => <tr key={row.excel_row} className={row.shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
            <td>{row.excel_row}</td><td>{date(row.delivery_date)}</td><td>{row.purorder}<br />{row.sales_id}</td><td>{row.itemcode}</td>
            <td>{num(row.ordered_qty)}</td><td>{num(row.existing?.shipped_qty ?? 0)}</td><td>{num(row.suggested_reserved)}</td><td>{num(row.shortage_qty)}</td>
            <td>{row.existing ? (row.existing.cancelled ? "Đã hủy — bỏ qua" : row.existing.ordered_qty === row.ordered_qty ? "Không đổi — bỏ qua" : "Cập nhật số lượng") : row.candidates.length ?
              <select aria-label={`Cách nạp dòng ${row.excel_row}`} disabled={locked} onChange={(event) => setChoices((old) => ({ ...old, [row.excel_row]: event.target.value }))} value={choices[row.excel_row] || ""}>
                <option value="">Chọn lịch mới hoặc dời lịch…</option><option value="new">Tạo lịch giao mới</option>
                {row.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>Dời lịch {date(candidate.delivery_date)} — đã xuất {num(candidate.shipped_qty)}</option>)}
              </select> : "Thêm lịch mới"}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="muted small">Khi chọn dời lịch, lượng giữ dự kiến trong bảng có thể thay đổi. Lượng yêu cầu mới phải bằng hoặc lớn hơn số đã xuất của lịch cũ.</p>
      </> : null}
      <div className="modal-actions">
        <button className="button button-secondary" disabled={busy} onClick={() => importDialog.current?.close()} type="button">Đóng</button>
        <button className="button button-secondary" disabled={!file || locked} onClick={() => { void upload(); }} type="button">Kiểm tra file</button>
        <button className="button button-primary" disabled={locked || !preview || invalidChoice} onClick={importRows} type="button">Xác nhận danh sách và giữ hàng</button>
      </div>
    </dialog>

    <dialog aria-labelledby={`${id}-action-title`} className="modal-card warehouse-opening-dialog" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => { detailVersion.current++; }} ref={actionDialog}>
      <div className="modal-heading"><h2 id={`${id}-action-title`}>{mode === "ship" ? "Xác nhận xuất thực tế" : mode === "edit" ? "Sửa yêu cầu / Dời ngày" : mode === "cancel" ? "Hủy phần chưa xuất" : "Chi tiết giao hàng"}</h2>
        <button aria-label="Đóng chi tiết" className="modal-close" disabled={busy} onClick={() => actionDialog.current?.close()} type="button">×</button></div>
      {selected ? <>
        <p>{selected.purorder} / {selected.sales_id} / {selected.itemcode}</p>
        <p>Yêu cầu {num(selected.ordered_qty)} · Đã xuất {num(selected.shipped_qty)} · On order {num(selected.reserved_qty)} · Thiếu {num(selected.shortage_qty)}</p>
        {notice ? <p role="status" className="alert">{notice}</p> : null}
        {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">Thử lại thao tác chưa rõ kết quả</button> : null}
        {mode === "ship" || mode === "edit" ? <div className="warehouse-outgoing-toolbar">
          <label>{mode === "ship" ? "Số thực xuất" : "Số yêu cầu"}<input disabled={locked} max={mode === "ship" ? selected.reserved_qty : 2147483647} min={mode === "ship" ? 1 : Math.max(1, selected.shipped_qty)} onChange={(event) => setQuantity(event.target.value)} step={1} type="number" value={quantity} /></label>
          <label>{mode === "ship" ? "Ngày xuất thực tế" : "Ngày giao dự kiến"}<input disabled={locked} onChange={(event) => setActionDate(event.target.value)} type="date" value={actionDate} /></label>
        </div> : null}
        {mode === "cancel" ? <p>Chỉ hủy phần chưa xuất và trả On order về kho. Lịch sử đã xuất được giữ lại.</p> : null}
        {detailError ? <p className="alert alert-error">{detailError}</p> : null}
        <h3>Lô đang giữ theo FIFO</h3>
        <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>ID lô nhập</th><th>Ngày SX</th><th>Ngày nhập</th><th>Đang giữ cho yêu cầu</th></tr></thead>
          <tbody>{lots.map((lot) => <tr key={lot.incoming_id}><td>{lot.incoming_id}</td><td>{date(lot.inv_incoming.production_date)}</td><td>{date(lot.inv_incoming.received_date)}</td><td>{num(lot.quantity)}</td></tr>)}</tbody></table></div>
        <h3>Lịch sử xuất thực tế</h3>
        {history.length ? <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>Ngày xuất</th><th>Số lượng</th><th>Người xuất</th><th>Lô nhập đã lấy</th></tr></thead>
          <tbody>{history.map((issue) => <tr key={issue.id}><td>{date(issue.shipped_date)}</td><td>{num(issue.quantity)}</td><td>{issue.entered_by_name}</td>
            <td>{issue.inv_delivery_issue_lines.map((line) => `#${line.incoming_id}: ${num(line.quantity)}`).join("; ")}</td></tr>)}</tbody></table></div> : <p className="muted">Chưa có lần xuất.</p>}
        <div className="modal-actions">
          <button className="button button-secondary" disabled={busy} onClick={() => actionDialog.current?.close()} type="button">Đóng</button>
          {mode !== "history" ? <button className="button button-primary" disabled={locked || ((mode === "ship" || mode === "edit") && (!Number.isInteger(Number(quantity)) || Number(quantity) < (mode === "ship" ? 1 : Math.max(1, selected.shipped_qty)) || Number(quantity) > (mode === "ship" ? selected.reserved_qty : 2147483647) || !actionDate))} onClick={() => {
            void execute(mode, { id: selected.id, version: selected.version, ...(mode === "ship" ? { quantity: Number(quantity), shipped_date: actionDate } : mode === "edit" ? { ordered_qty: Number(quantity), delivery_date: actionDate } : {}) });
          }} type="button">{mode === "ship" ? "Ghi nhận xuất kho" : mode === "edit" ? "Lưu thay đổi" : "Xác nhận hủy phần chờ"}</button> : null}
        </div>
      </> : null}
    </dialog>
  </div>;
}
