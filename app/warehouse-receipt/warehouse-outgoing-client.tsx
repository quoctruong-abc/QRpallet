"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { todayInVietnam } from "@/lib/warehouse-receipt/incoming";
import { loadWarehouseRows, matchesWarehouseSearch, warehouseSearchTokens, WAREHOUSE_PAGE_SIZE } from "@/lib/warehouse-receipt/outgoing-list";
import { MAX_DELIVERY_QUANTITY, previewDeliveryDemand, type DeliveryPreviewLine, type DeliveryRequest, type FifoPreview } from "@/lib/warehouse-receipt/outgoing";
import { WarehouseManualDelivery } from "./warehouse-manual-delivery";

type Command = { action: string; command_id: string; profile_id: string; payload: Record<string, unknown> };
type History = { id: string; quantity: number; shipped_date: string; entered_by_name: string; inv_delivery_issue_lines: { incoming_id: number; quantity: number; inv_incoming: { received_date: string; production_date: string | null } }[] };
import { WarehouseStockSummary } from "./warehouse-stock-summary";
const num = (n: number) => Number(n).toLocaleString("vi-VN");
const date = (v: string | null) => v ? v.split("-").reverse().join("/") : "—";
const statusLabel = { pending: "Chờ xuất", partial: "Xuất một phần", done: "Done", cancelled: "Đã hủy" };
const maxDeliveryQty = MAX_DELIVERY_QUANTITY;
const manualReference = (row: DeliveryRequest) => `NT-${row.id.slice(0, 8).toUpperCase()}`;

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
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [systemCustomer, setSystemCustomer] = useState("");
  const [closed, setClosed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [listError, setListError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sourcePreview, setPreview] = useState<DeliveryPreviewLine[] | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [choices, setChoices] = useState<Record<number, string>>({});
  const preview = useMemo(() => sourcePreview ? previewDeliveryDemand(sourcePreview, choices) : null, [sourcePreview, choices]);
  const [selected, setSelected] = useState<DeliveryRequest | null>(null);
  const [mode, setMode] = useState<"ship" | "edit" | "cancel" | "history">("ship");
  const [quantity, setQuantity] = useState("");
  const [actionDate, setActionDate] = useState(todayInVietnam);
  const [history, setHistory] = useState<History[]>([]);
  const [fifo, setFifo] = useState<FifoPreview | null>(null);
  const [revision, setRevision] = useState(0);
  const [manualSaved, setManualSaved] = useState(0);
  const [detailError, setDetailError] = useState("");
  const detailVersion = useRef(0);
  const locked = busy || Boolean(pending) || blocked || !ready;

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const data = await loadWarehouseRows<DeliveryRequest>({ closed: String(closed) }, (row) => row.id, controller.signal);
        if (controller.signal.aborted) return;
        setRows(data);
        setListError("");
      } catch (error) {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "Không tải được danh sách.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    });
    return () => controller.abort();
  }, [closed, revision]);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const command = JSON.parse(saved) as Command;
          if (command.profile_id !== profileId || typeof command.command_id !== "string" || !["manual", "import", "edit", "cancel", "reserve", "ship"].includes(command.action) || !command.payload) throw new Error("Invalid saved command");
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
      if (current.action === "manual") setManualSaved((value) => value + 1);
      setNotice(current.action === "ship" ? `Đã ghi nhận xuất ${num(data.result.shipped)}.`
        : current.action === "manual" ? "Đã thêm lịch giao thủ công vào danh sách chờ xuất hàng."
        : current.action === "import" ? `Đã nạp/cập nhật ${data.result.changed} dòng; bỏ qua ${data.result.skipped} dòng không đổi.`
        : current.action === "cancel" ? "Đã hủy phần chờ và cập nhật On order của item."
        : current.action === "reserve" ? "On order được tính tự động từ danh sách còn phải giao."
        : "Đã cập nhật yêu cầu giao hàng.");
      setRevision((value) => value + 1);
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
        ...row, existing: undefined, candidates: undefined, item_stock_qty: undefined, item_on_order_qty: undefined, item_on_order_after: undefined, item_shortage_after: undefined,
        mode: choice === "new" ? "new" : "update", target_id: target?.id ?? null, expected_version: target?.version ?? null,
      };
    });
    void execute("import", { rows: inputs, file_name: file.name });
  }

  const loadDetails = useCallback(async (requestId: string, amount: number) => {
    const version = ++detailVersion.current;
    setDetailError("");
    try {
      const response = await fetch(`/api/warehouse-receipt/outgoing?id=${requestId}&quantity=${amount}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error);
      if (version === detailVersion.current) {
        setHistory(data.history);
        setFifo(data);
      }
    } catch (error) { if (version === detailVersion.current) setDetailError(error instanceof Error ? error.message : "Không tải được chi tiết."); }
  }, []);

  function openAction(row: DeliveryRequest, action: typeof mode) {
    setSelected(row);
    setMode(action);
    setQuantity(String(action === "edit" ? row.ordered_qty : Math.min(row.remaining_qty, row.item_stock_qty)));
    setActionDate(action === "edit" ? row.delivery_date : todayInVietnam());
    setHistory([]);
    setFifo(null);
    setDetailError("");
    actionDialog.current?.showModal();
    if (action !== "ship") void loadDetails(row.id, 0);
  }

  const invalidateDetails = useCallback(() => { detailVersion.current++; }, []);
  const amount = Number(quantity);
  const validShipInput = Number.isInteger(amount) && amount > 0 && amount <= maxDeliveryQty - (selected?.shipped_qty ?? 0);
  useEffect(() => {
    if (!selected || mode !== "ship" || !validShipInput) return;
    const timer = window.setTimeout(() => { void loadDetails(selected.id, amount); }, 200);
    return () => { window.clearTimeout(timer); invalidateDetails(); };
  }, [selected, mode, amount, validShipInput, loadDetails, invalidateDetails]);

  const maxShipQty = Math.min(maxDeliveryQty - (selected?.shipped_qty ?? 0), fifo?.item_stock_qty ?? selected?.item_stock_qty ?? 0);
  const minOrderQty = selected ? Math.max(1, Math.min(selected.ordered_qty, selected.shipped_qty)) : 1;
  const shipExcess = validShipInput && selected ? Math.max(0, amount - selected.remaining_qty) : 0;
  const canSubmit = !locked && (mode === "cancel"
    || (mode === "ship" && actionDate && validShipInput && fifo?.can_ship && fifo.quantity === amount && amount <= maxShipQty)
    || (mode === "edit" && actionDate && Number.isInteger(amount) && amount >= minOrderQty && amount <= maxDeliveryQty));

  const selectedTargets = preview?.map((row) => row.existing?.id || (choices[row.excel_row] === "new" ? null : choices[row.excel_row])).filter(Boolean) || [];
  const invalidChoice = new Set(selectedTargets).size !== selectedTargets.length || (preview?.some((row) => {
    const chosen = row.existing?.id === choices[row.excel_row] ? row.existing : row.candidates.find((c) => c.id === choices[row.excel_row]);
    return !choices[row.excel_row] || (chosen && !chosen.cancelled && row.ordered_qty < Math.min(chosen.ordered_qty, chosen.shipped_qty));
  }) ?? true);

  const loaded = useMemo(() => closed ? rows : rows.filter((row) => !row.cancelled && row.remaining_qty > 0), [rows, closed]);
  const dateOptions = useMemo(() => [...new Set(loaded.map((row) => row.delivery_date))].sort(), [loaded]);
  const customerOptions = useMemo(() => [...new Set(loaded.map((row) => row.system_customer_name).filter((name): name is string => Boolean(name)))]
    .sort((a, b) => a.localeCompare(b, "vi")), [loaded]);
  const hasUnnamedCustomer = loaded.some((row) => !row.system_customer_name);
  const activeDate = dateOptions.includes(deliveryDate) ? deliveryDate : "";
  const activeCustomer = (systemCustomer === "missing" && hasUnnamedCustomer) || customerOptions.includes(systemCustomer.slice(5))
    ? systemCustomer : "";
  const filtered = useMemo(() => {
    const tokens = warehouseSearchTokens(search);
    return loaded.filter((row) => (!activeDate || row.delivery_date === activeDate)
      && (!activeCustomer || (activeCustomer === "missing" ? !row.system_customer_name : `name:${row.system_customer_name}` === activeCustomer))
      && matchesWarehouseSearch(tokens, [row.purorder, row.sales_id, row.itemcode, row.product_name, row.customer, row.system_customer_name,
        row.delivery_source === "manual" ? `Nhập tay ${manualReference(row)}` : null]));
  }, [loaded, activeDate, activeCustomer, search]);
  const total = filtered.length;
  const pageStart = Math.min(offset, Math.max(0, Math.floor((total - 1) / WAREHOUSE_PAGE_SIZE) * WAREHOUSE_PAGE_SIZE));
  const visible = filtered.slice(pageStart, pageStart + WAREHOUSE_PAGE_SIZE);

  return <div className="warehouse-outgoing">
    <div className="warehouse-outgoing-toolbar">
      <button className="button button-primary" disabled={locked} onClick={() => importDialog.current?.showModal()} type="button">Nạp lịch giao ERP</button>
      <button className="button button-secondary" disabled={loading} onClick={() => setRevision((value) => value + 1)} type="button">Tải lại</button>
    </div>
    <p className="muted small">On order là tổng số còn phải giao của từng item. Chỉ chọn lô FIFO và trừ tồn khi xác nhận xuất thực tế.</p>
    {notice ? <p role="status" className="alert">{notice}</p> : null}
    {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">{busy ? "Đang xử lý…" : "Thử lại thao tác chưa rõ kết quả"}</button> : null}
    {listError ? <p role="alert" className="alert alert-error">{listError}</p> : null}
    <WarehouseManualDelivery locked={locked} saved={manualSaved} onSubmit={(payload) => { void execute("manual", payload); }} />
    <WarehouseStockSummary revision={revision} />
    <div className="warehouse-outgoing-toolbar">
      <input type="search" aria-label="Tìm yêu cầu xuất" onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
        placeholder="Tìm PO, Sales ID, item, khách hàng" value={search} />
      <label>Ngày giao
        <select value={activeDate} onChange={(event) => { setDeliveryDate(event.target.value); setOffset(0); }}>
          <option value="">Tất cả ngày giao</option>
          {dateOptions.map((value) => <option key={value} value={value}>{date(value)}</option>)}
        </select>
      </label>
      <label>Khách hệ thống
        <select value={activeCustomer} onChange={(event) => { setSystemCustomer(event.target.value); setOffset(0); }}>
          <option value="">Tất cả khách hệ thống</option>
          {customerOptions.map((value) => <option key={value} value={`name:${value}`}>{value}</option>)}
          {hasUnnamedCustomer ? <option value="missing">Chưa có tên hệ thống</option> : null}
        </select>
      </label>
      <label className="warehouse-outgoing-checkbox"><input checked={closed} onChange={(event) => { setClosed(event.target.checked); setOffset(0); }} type="checkbox" />Hiện cả Done / Đã hủy</label>
    </div>
    <section className="scan-table-card">
      <div className="warehouse-incoming-draft-heading"><h2>Danh sách chờ xuất hàng ({total})</h2></div>
      <div className="scan-table-wrap"><table className="warehouse-table">
        <thead><tr><th>Ngày giao</th><th>PO</th><th>Sales ID</th><th>Item</th><th>Tên / Khách ERP</th><th>Khách hệ thống</th><th>ĐVT</th><th>Yêu cầu</th><th>Đã xuất</th><th>Còn phải giao</th><th>Thiếu của item</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.id} className={row.item_shortage_qty > 0 ? "warehouse-outgoing-shortage" : undefined}>
          <td>{date(row.delivery_date)}</td>
          <td>{row.delivery_source === "manual" ? <span title={row.purorder}>Nhập tay · {manualReference(row)}</span> : row.purorder}</td>
          <td>{row.delivery_source === "manual" ? "—" : row.sales_id}</td><td>{row.itemcode}</td>
          <td className="warehouse-outgoing-name">{row.product_name}{row.delivery_source !== "manual" && row.customer ? <small>{row.customer}</small> : null}</td><td>{row.system_customer_name || "—"}</td><td>{row.unit_label || "—"}</td>
          <td>{num(row.ordered_qty)}</td><td>{num(row.shipped_qty)}</td><td>{num(row.remaining_qty)}</td><td>{num(row.item_shortage_qty)}</td><td>{statusLabel[row.status]}</td>
          <td><div className="warehouse-incoming-row-actions">
            {!row.cancelled && row.shipped_qty < row.ordered_qty ? <>
              <button className="button button-primary button-small" disabled={locked || row.item_stock_qty === 0} onClick={() => { void openAction(row, "ship"); }} type="button">Xuất</button>
              <button className="button button-secondary button-small" disabled={locked} onClick={() => { void openAction(row, "edit"); }} type="button">Sửa / Dời ngày</button>
              <button className="button button-secondary button-small" disabled={locked} onClick={() => { void openAction(row, "cancel"); }} type="button">Hủy phần chờ</button>
            </> : null}
            <button className="button button-secondary button-small" onClick={() => { void openAction(row, "history"); }} type="button">Chi tiết</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {!visible.length ? <p className="scan-empty">{loading ? "Đang tải…" : "Không có yêu cầu giao hàng."}</p> : null}
      <div className="warehouse-incoming-next">
        <button className="button button-secondary" disabled={pageStart === 0} onClick={() => setOffset(pageStart - WAREHOUSE_PAGE_SIZE)} type="button">Trước</button>
        <span>{total ? `${pageStart + 1}–${Math.min(pageStart + WAREHOUSE_PAGE_SIZE, total)} / ${total}` : "0"}</span>
        <button className="button button-secondary" disabled={pageStart + WAREHOUSE_PAGE_SIZE >= total} onClick={() => setOffset(pageStart + WAREHOUSE_PAGE_SIZE)} type="button">Sau</button>
      </div>
    </section>

    <dialog aria-labelledby={`${id}-import-title`} className="modal-card warehouse-opening-dialog warehouse-outgoing-import-dialog" onCancel={(event) => { if (busy) event.preventDefault(); }} ref={importDialog}>
      <div className="modal-heading"><h2 id={`${id}-import-title`}>Nạp lịch giao ERP</h2><button aria-label="Đóng nạp ERP" className="modal-close" disabled={busy} onClick={() => importDialog.current?.close()} type="button">×</button></div>
      <label>File lịch giao<input accept=".xlsx" disabled={locked} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setUploadError(""); }} type="file" /></label>
      <p className="muted small">Đọc đúng vùng merge. Khóa chống trùng: PO + Sales ID + Item + ngày giao. Kiểm tra file chưa cập nhật On order.</p>
      {uploadError ? <p role="alert" className="alert alert-error warehouse-outgoing-error">{uploadError}</p> : null}
      {notice ? <p role="status" className="alert">{notice}</p> : null}
      {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">Thử lại thao tác chưa rõ kết quả</button> : null}
      {preview ? <>
        <p><strong>{preview.length} dòng.</strong> Có {new Set(preview.filter((row) => row.item_shortage_after > 0).map((row) => row.itemcode)).size} item thiếu hàng dự kiến. On order được tính theo tổng nhu cầu của item, chưa chọn lô.</p>
        <div className="scan-table-wrap warehouse-outgoing-preview"><table className="warehouse-table">
          <thead><tr><th>Dòng</th><th>Ngày giao</th><th>PO / Sales ID</th><th>Item</th><th>Yêu cầu trong file</th><th>Tồn hiện tại</th><th>Đã yêu cầu</th><th>Tồn khả dụng</th><th>On order sau nạp</th><th>Thiếu của item</th><th>Cách nạp</th></tr></thead>
          <tbody>{preview.map((row) => <tr key={row.excel_row} className={row.item_shortage_after > 0 ? "warehouse-outgoing-shortage" : undefined}>
            <td>{row.excel_row}</td><td>{date(row.delivery_date)}</td><td>{row.purorder}<br />{row.sales_id}</td><td>{row.itemcode}</td>
            <td>{num(row.ordered_qty)}</td><td>{num(row.item_stock_qty)}</td><td>{num(row.item_on_order_qty)}</td>
            {/* The preview already contains both operands of inv_stock_summary.available_qty from the same snapshot. */}
            <td>{num(row.item_stock_qty - row.item_on_order_qty)}</td><td>{num(row.item_on_order_after)}</td><td>{num(row.item_shortage_after)}</td>
            <td>{row.existing ? (row.existing.cancelled ? "Đã hủy — bỏ qua" : row.existing.ordered_qty === row.ordered_qty ? "Không đổi — bỏ qua" : "Cập nhật số lượng") : row.candidates.length ?
              <select aria-label={`Cách nạp dòng ${row.excel_row}`} disabled={locked} onChange={(event) => setChoices((old) => ({ ...old, [row.excel_row]: event.target.value }))} value={choices[row.excel_row] || ""}>
                <option value="">Chọn lịch mới hoặc dời lịch…</option><option value="new">Tạo lịch giao mới</option>
                {row.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>Dời lịch {date(candidate.delivery_date)} — đã xuất {num(candidate.shipped_qty)}</option>)}
              </select> : "Thêm lịch mới"}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="muted small">Tổng nhu cầu dự kiến cập nhật theo lựa chọn lịch mới / dời lịch; hệ thống kiểm tra lại khi xác nhận. Lượng yêu cầu mới phải bằng hoặc lớn hơn số đã xuất của lịch cũ.</p>
      </> : null}
      <div className="modal-actions">
        <button className="button button-secondary" disabled={busy} onClick={() => importDialog.current?.close()} type="button">Đóng</button>
        <button className="button button-secondary" disabled={!file || locked} onClick={() => { void upload(); }} type="button">Kiểm tra file</button>
        <button className="button button-primary" disabled={locked || !preview || invalidChoice} onClick={importRows} type="button">Xác nhận danh sách giao hàng</button>
      </div>
    </dialog>

    <dialog aria-labelledby={`${id}-action-title`} className="modal-card warehouse-opening-dialog" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => { detailVersion.current++; setSelected(null); }} ref={actionDialog}>
      <div className="modal-heading"><h2 id={`${id}-action-title`}>{mode === "ship" ? "Xác nhận xuất thực tế" : mode === "edit" ? "Sửa yêu cầu / Dời ngày" : mode === "cancel" ? "Hủy phần chưa xuất" : "Chi tiết giao hàng"}</h2>
        <button aria-label="Đóng chi tiết" className="modal-close" disabled={busy} onClick={() => actionDialog.current?.close()} type="button">×</button></div>
      {selected ? <>
        <p>{selected.delivery_source === "manual" ? `Nhập tay · ${manualReference(selected)}` : `${selected.purorder} / ${selected.sales_id}`} / {selected.itemcode}</p>
        <p>Yêu cầu {num(selected.ordered_qty)} · Đã xuất {num(selected.shipped_qty)} · Còn phải giao {num(selected.remaining_qty)} · Tồn item {num(fifo?.item_stock_qty ?? selected.item_stock_qty)}</p>
        {notice ? <p role="status" className="alert">{notice}</p> : null}
        {pending ? <button className="button button-primary" disabled={busy} onClick={() => { void execute(pending.action, pending.payload, pending); }} type="button">Thử lại thao tác chưa rõ kết quả</button> : null}
        {mode === "ship" || mode === "edit" ? <div className="warehouse-outgoing-toolbar">
          <label>{mode === "ship" ? "Số thực xuất" : "Số yêu cầu"}<input disabled={locked} max={mode === "ship" ? maxShipQty : maxDeliveryQty} min={mode === "ship" ? 1 : minOrderQty} onChange={(event) => {
            setQuantity(event.target.value);
            if (Number(event.target.value) !== amount) { setFifo(null); detailVersion.current++; }
          }} step={1} type="number" value={quantity} /></label>
          <label>{mode === "ship" ? "Ngày xuất thực tế" : "Ngày giao dự kiến"}<input disabled={locked} onChange={(event) => setActionDate(event.target.value)} type="date" value={actionDate} /></label>
        </div> : null}
        {mode === "cancel" ? <p>Chỉ hủy phần chưa xuất và giảm On order của item. Lịch sử đã xuất được giữ lại.</p> : null}
        {detailError ? <p className="alert alert-error">{detailError}</p> : null}
        {mode === "ship" ? <>
          {shipExcess > 0 ? <p role="status" className="alert">Xuất vượt {num(shipExcess)} so với số còn phải giao. Kho sẽ trừ đủ số thực xuất; số yêu cầu giữ nguyên.</p> : null}
          <h3>Gợi ý FIFO cho số thực xuất</h3>
          <p className="muted small">Ưu tiên lô không có ngày sản xuất, sau đó lấy theo ngày sản xuất cũ nhất. Khi xác nhận, hệ thống chọn lại lô theo tồn thực tế.</p>
          {validShipInput && !fifo && !detailError ? <p className="muted">Đang cập nhật gợi ý…</p> : null}
          {fifo && !fifo.can_ship ? <p className="alert alert-error">Số lượng xuất vượt tồn thực tế hoặc không còn phần phải giao.</p> : null}
          <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>ID lô nhập</th><th>Ngày SX</th><th>Ngày nhập</th><th>Số lượng đề xuất</th></tr></thead>
            <tbody>{fifo?.fifo.map((lot) => <tr key={lot.incoming_id}><td>{lot.incoming_id}</td><td>{lot.production_date ? date(lot.production_date) : "Không có ngày sản xuất"}</td><td>{date(lot.received_date)}</td><td>{num(lot.quantity)}</td></tr>)}</tbody></table></div>
        </> : null}
        <h3>Lịch sử xuất thực tế</h3>
        {history.length ? <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>Ngày xuất</th><th>Số lượng</th><th>Người xuất</th><th>Lô nhập đã lấy</th></tr></thead>
          <tbody>{history.map((issue) => <tr key={issue.id}><td>{date(issue.shipped_date)}</td><td>{num(issue.quantity)}</td><td>{issue.entered_by_name}</td>
            <td>{issue.inv_delivery_issue_lines.map((line) => `#${line.incoming_id}: ${num(line.quantity)}`).join("; ")}</td></tr>)}</tbody></table></div> : <p className="muted">Chưa có lần xuất.</p>}
        <div className="modal-actions">
          <button className="button button-secondary" disabled={busy} onClick={() => actionDialog.current?.close()} type="button">Đóng</button>
          {mode !== "history" ? <button className="button button-primary" disabled={!canSubmit} onClick={() => {
            void execute(mode, { id: selected.id, version: selected.version, ...(mode === "ship" ? { quantity: amount, shipped_date: actionDate } : mode === "edit" ? { ordered_qty: amount, delivery_date: actionDate } : {}) });
          }} type="button">{mode === "ship" ? "Ghi nhận xuất kho" : mode === "edit" ? "Lưu thay đổi" : "Xác nhận hủy phần chờ"}</button> : null}
        </div>
      </> : null}
    </dialog>
  </div>;
}
