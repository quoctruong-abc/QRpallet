"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type WarehousePallet = {
  pallet_id: string;
  itemcode: string;
  product_name: string | null;
  customer: string | null;
  wo: string;
  quantity: number;
  status: string;
  updated_at: string;
};

type ReceiptRow = {
  receipt_id: string;
  receipt_date: string;
  total_pallet: number;
  total_quantity: number;
  status: "active" | "cancelled";
  created_at: string;
  cancelled_at: string | null;
};

type SummaryRow = {
  itemcode: string;
  customer: string;
  productName: string;
  palletCount: number;
  totalQuantity: number;
};

type Props = {
  initialRows: WarehousePallet[];
  canConfirm: boolean;
  canCancel: boolean;
};

function downloadPdf(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WarehouseReceiptClient({ initialRows, canConfirm, canCancel }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [itemFilter, setItemFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<"confirm" | "cancel" | "history" | "reprint" | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [receiptDate, setReceiptDate] = useState("");
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [activeReceiptId, setActiveReceiptId] = useState<string | null>(null);

  const itemOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.itemcode))).sort(), [rows]);
  const customerOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.customer || ""))).filter(Boolean).sort(), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) =>
    (!itemFilter || row.itemcode === itemFilter) && (!customerFilter || (row.customer || "") === customerFilter)
  ), [rows, itemFilter, customerFilter]);
  const filteredIds = filteredRows.map((row) => row.pallet_id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.pallet_id)), [rows, selected]);
  const totalQuantity = selectedRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const reviewRows = useMemo(() => {
    const grouped = new Map<string, SummaryRow>();
    selectedRows.forEach((row) => {
      const key = `${row.itemcode}::${row.customer || ""}::${row.product_name || ""}`;
      const current = grouped.get(key) ?? {
        itemcode: row.itemcode,
        customer: row.customer || "-",
        productName: row.product_name || "-",
        palletCount: 0,
        totalQuantity: 0,
      };
      current.palletCount += 1;
      current.totalQuantity += Number(row.quantity || 0);
      grouped.set(key, current);
    });
    return Array.from(grouped.values()).sort((a, b) => a.itemcode.localeCompare(b.itemcode));
  }, [selectedRows]);

  function toggleAllFiltered() {
    setSelected((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function cancelSelected() {
    if (!canCancel) return;
    const palletIds = Array.from(selected);
    if (!palletIds.length) return;
    setWorking("cancel");
    setNotice(null);
    try {
      const response = await fetch("/api/warehouse-receipt/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletIds }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Không thể hủy pallet.");
      setRows((current) => current.filter((row) => !selected.has(row.pallet_id)));
      setSelected(new Set());
      setNotice({ type: "success", text: `Đã trả ${palletIds.length} pallet về production.` });
      router.refresh();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể hủy pallet." });
    } finally {
      setWorking(null);
    }
  }

  async function confirmSelected() {
    if (!canConfirm) return;
    const palletIds = Array.from(selected);
    if (!palletIds.length) return;
    setWorking("confirm");
    setNotice(null);
    try {
      const response = await fetch("/api/warehouse-receipt/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletIds }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error || "Không thể tạo phiếu nhập kho.");
      }
      const blob = await response.blob();
      const receiptId = response.headers.get("X-Receipt-Id") || "warehouse-receipt";
      downloadPdf(blob, receiptId);
      setRows((current) => current.filter((row) => !selected.has(row.pallet_id)));
      setSelected(new Set());
      setReviewOpen(false);
      setNotice({ type: "success", text: `Đã tạo phiếu ${receiptId} và chuyển ${palletIds.length} pallet sang WHdone.` });
      router.refresh();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể tạo phiếu nhập kho." });
    } finally {
      setWorking(null);
    }
  }

  async function loadReceipts(date = receiptDate) {
    setWorking("history");
    setNotice(null);
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const response = await fetch(`/api/warehouse-receipt/list${query}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Không thể tải danh sách phiếu.");
      setReceipts(result.receipts);
      setHistoryOpen(true);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể tải danh sách phiếu." });
    } finally {
      setWorking(null);
    }
  }

  async function reprintReceipt(receiptId: string) {
    setWorking("reprint");
    setActiveReceiptId(receiptId);
    setNotice(null);
    try {
      const response = await fetch("/api/warehouse-receipt/reprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptId }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error || "Không thể in lại phiếu.");
      }
      downloadPdf(await response.blob(), receiptId);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể in lại phiếu." });
    } finally {
      setWorking(null);
      setActiveReceiptId(null);
    }
  }

  return <section className="warehouse-page">
    <div className="hero-row">
      <div><p className="eyebrow">MODULE 04</p><h1>Xử lý nhập kho</h1><p className="muted">Production review và xác nhận nhập kho; Warehouse hủy bỏ và trả pallet về Production.</p></div>
      <div className="warehouse-hero-actions">
        <button className="button button-secondary" type="button" disabled={working === "history"} onClick={() => loadReceipts("")}>{working === "history" ? "Đang tải..." : "Lịch sử / In lại phiếu"}</button>
        <div className="stat-card"><span className="stat-number">{rows.length}</span><span className="muted">Pallet chờ xử lý</span></div>
      </div>
    </div>

    <div className="warehouse-filter-card">
      <label><span>Item</span><select value={itemFilter} onChange={(event) => setItemFilter(event.target.value)}><option value="">Tất cả item</option>{itemOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label><span>Khách hàng</span><select value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}><option value="">Tất cả khách hàng</option>{customerOptions.map((customer) => <option key={customer}>{customer}</option>)}</select></label>
      <button className="button button-secondary" type="button" onClick={() => { setItemFilter(""); setCustomerFilter(""); }}>Xóa bộ lọc</button>
    </div>

    <div className="warehouse-summary-bar"><span>Đang hiển thị <strong>{filteredRows.length}</strong> / {rows.length} pallet</span><span>Đã chọn <strong>{selected.size}</strong> pallet - <strong>{totalQuantity.toLocaleString("vi-VN")}</strong> pcs</span></div>
    {notice ? <div className={`alert ${notice.type === "error" ? "alert-error" : "alert-success"}`}>{notice.text}</div> : null}

    <div className="scan-table-card">
      {filteredRows.length === 0 ? <div className="scan-empty">Không có pallet processingWH phù hợp bộ lọc.</div> : <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th><input aria-label="Chọn tất cả dòng đang lọc" type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} /></th><th>ID pallet</th><th>Itemcode</th><th>Customer</th><th>Product name</th><th>WO</th><th>Quantity</th></tr></thead><tbody>
        {filteredRows.map((row) => <tr key={row.pallet_id} className={selected.has(row.pallet_id) ? "is-selected" : ""}><td><input aria-label={`Chọn ${row.pallet_id}`} type="checkbox" checked={selected.has(row.pallet_id)} onChange={() => toggleOne(row.pallet_id)} /></td><td><strong>{row.pallet_id}</strong></td><td>{row.itemcode}</td><td>{row.customer || "-"}</td><td>{row.product_name || "-"}</td><td>{row.wo}</td><td>{Number(row.quantity).toLocaleString("vi-VN")}</td></tr>)}
      </tbody></table></div>}
    </div>

    <div className="warehouse-actions">
      {canCancel ? <button className="button button-danger" type="button" disabled={!selected.size || !!working} onClick={cancelSelected}>{working === "cancel" ? "Đang hủy..." : "Hủy bỏ - trả về Production"}</button> : null}
      {canConfirm ? <button className="button button-primary" type="button" disabled={!selected.size || !!working} onClick={() => setReviewOpen(true)}>Review & xác nhận</button> : null}
    </div>

    {canConfirm && reviewOpen ? <div className="modal-backdrop" onMouseDown={() => !working && setReviewOpen(false)}><div className="modal-card scan-confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><p className="eyebrow">REVIEW PHIẾU</p><h2>Kiểm tra dữ liệu trước khi xác nhận</h2></div><button className="modal-close" type="button" disabled={!!working} onClick={() => setReviewOpen(false)}>×</button></div>
      <div className="pallet-summary"><div><span>Tổng pallet</span><strong>{selectedRows.length}</strong></div><div><span>Tổng số lượng</span><strong>{totalQuantity.toLocaleString("vi-VN")}</strong></div><div><span>Số dòng tổng hợp</span><strong>{reviewRows.length}</strong></div></div>
      <div className="scan-summary-wrap"><table className="scan-summary-table"><thead><tr><th>Itemcode</th><th>Customer</th><th>Product name</th><th>Total pallet</th><th>Total quantity</th></tr></thead><tbody>{reviewRows.map((row) => <tr key={`${row.itemcode}-${row.customer}-${row.productName}`}><td><strong>{row.itemcode}</strong></td><td>{row.customer}</td><td>{row.productName}</td><td>{row.palletCount}</td><td>{row.totalQuantity.toLocaleString("vi-VN")}</td></tr>)}</tbody></table></div>
      <p className="muted">Sau khi xác nhận, pallet sẽ chuyển sang WHdone, bị khóa nghiệp vụ và PDF sẽ được tải xuống.</p>
      <div className="modal-actions"><button className="button button-secondary" disabled={!!working} onClick={() => setReviewOpen(false)}>Quay lại chỉnh</button><button className="button button-primary" disabled={!!working} onClick={confirmSelected}>{working === "confirm" ? "Đang tạo phiếu..." : "Xác nhận cuối & xuất PDF"}</button></div>
    </div></div> : null}

    {historyOpen ? <div className="modal-backdrop" onMouseDown={() => !working && setHistoryOpen(false)}><div className="modal-card receipt-history-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><p className="eyebrow">LỊCH SỬ PHIẾU</p><h2>Phiếu nhập kho 7 ngày gần nhất</h2></div><button className="modal-close" type="button" disabled={!!working} onClick={() => setHistoryOpen(false)}>×</button></div>
      <div className="receipt-search-row"><label><span>Tìm theo ngày</span><input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} /></label><button className="button button-primary" disabled={working === "history"} onClick={() => loadReceipts(receiptDate)}>Tìm kiếm</button><button className="button button-secondary" disabled={working === "history"} onClick={() => { setReceiptDate(""); loadReceipts(""); }}>7 ngày gần nhất</button></div>
      <div className="scan-table-wrap"><table className="receipt-history-table"><thead><tr><th>ID Receipt</th><th>Date</th><th>Total pallet</th><th>Total quantity</th><th>Status</th><th>Thao tác</th></tr></thead><tbody>
        {receipts.length ? receipts.map((receipt) => <tr key={receipt.receipt_id}><td><strong>{receipt.receipt_id}</strong></td><td>{receipt.receipt_date.split("-").reverse().join("/")}</td><td>{receipt.total_pallet}</td><td>{Number(receipt.total_quantity).toLocaleString("vi-VN")}</td><td><span className={`receipt-status receipt-status-${receipt.status}`}>{receipt.status === "active" ? "Đang hiệu lực" : "Đã hủy trước đây"}</span></td><td><button className="button button-small button-secondary" disabled={receipt.status === "cancelled" || !!working} onClick={() => reprintReceipt(receipt.receipt_id)}>{working === "reprint" && activeReceiptId === receipt.receipt_id ? "Đang in..." : "In lại"}</button></td></tr>) : <tr><td colSpan={6} className="scan-empty">Không tìm thấy phiếu phù hợp.</td></tr>}
      </tbody></table></div>
    </div></div> : null}
  </section>;
}
