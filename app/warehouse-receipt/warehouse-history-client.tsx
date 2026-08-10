"use client";

import { useEffect, useState } from "react";

type ReceiptRow = {
  receipt_id: string;
  receipt_date: string;
  total_pallet: number;
  total_quantity: number;
  status: "active" | "cancelled";
  created_at: string;
  cancelled_at: string | null;
  creator_name: string;
};

type ReceiptPalletRow = {
  pallet_id: string;
  wo: string | null;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  quantity: number | string | null;
};

export function WarehouseHistoryClient() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [working, setWorking] = useState<"history" | "reprint" | "detail" | null>(null);
  const [activeReceiptId, setActiveReceiptId] = useState<string | null>(null);
  const [detailReceiptId, setDetailReceiptId] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<ReceiptPalletRow[]>([]);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function loadReceipts(from = "", to = "") {
    if ((from && !to) || (!from && to)) {
      setNotice({ type: "error", text: "Vui lòng chọn đầy đủ Từ ngày và Đến ngày." });
      return;
    }

    setWorking("history");
    setNotice(null);
    try {
      const params = new URLSearchParams();
      if (from && to) {
        params.set("from", from);
        params.set("to", to);
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`/api/warehouse-receipt/list${query}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Không thể tải lịch sử phiếu.");
      setReceipts(result.receipts ?? []);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể tải lịch sử phiếu." });
    } finally {
      setWorking(null);
    }
  }

  async function loadReceiptDetail(receiptId: string) {
    setWorking("detail");
    setActiveReceiptId(receiptId);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/warehouse-receipt/detail?receiptId=${encodeURIComponent(receiptId)}`,
        { cache: "no-store" },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Không thể tải chi tiết phiếu.");
      }
      setDetailRows(result.pallets ?? []);
      setDetailReceiptId(receiptId);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể tải chi tiết phiếu." });
    } finally {
      setWorking(null);
      setActiveReceiptId(null);
    }
  }

  function reprintReceipt(receiptId: string) {
    setWorking("reprint");
    setActiveReceiptId(receiptId);
    setNotice(null);

    const printWindow = window.open(
      `/api/warehouse-receipt/reprint?receiptId=${encodeURIComponent(receiptId)}`,
      "_blank",
    );

    if (!printWindow) {
      setNotice({ type: "error", text: "Trình duyệt đã chặn cửa sổ in. Vui lòng cho phép pop-up rồi thử lại." });
    } else {
      printWindow.opener = null;
      setNotice({ type: "success", text: `Đã mở phiếu ${receiptId} và chuẩn bị hộp thoại in.` });
    }

    setWorking(null);
    setActiveReceiptId(null);
  }

  useEffect(() => { void loadReceipts(); }, []);

  const rangeReady = Boolean(fromDate && toDate);

  return (
    <section className="warehouse-page">
      <div className="hero-row">
        <div><h1>Lịch sử phiếu nhập kho</h1><p className="muted">Mặc định hiển thị 10 phiếu nhập kho gần nhất. Có thể lọc theo khoảng ngày để xem lịch sử cũ hơn.</p></div>
        <div className="stat-card"><span className="stat-number">{receipts.length}</span><span className="muted">Phiếu đang hiển thị</span></div>
      </div>

      <div className="warehouse-filter-card">
        <label><span>Từ ngày</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label><span>Đến ngày</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        <button
          className="button button-primary"
          type="button"
          disabled={working === "history" || !rangeReady}
          onClick={() => loadReceipts(fromDate, toDate)}
        >
          {working === "history" ? "Đang tải..." : "Tìm khoảng ngày"}
        </button>
      </div>

      {notice ? <div className={`alert ${notice.type === "error" ? "alert-error" : "alert-success"}`}>{notice.text}</div> : null}

      <div className="scan-table-card">
        {!receipts.length ? <div className="scan-empty">Không có phiếu nhập kho phù hợp.</div> : <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>Số phiếu</th><th>Ngày</th><th>Người tạo phiếu</th><th>Tổng pallet</th><th>Tổng số lượng</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>
          {receipts.map((receipt) => <tr key={receipt.receipt_id}><td><strong>{receipt.receipt_id}</strong></td><td>{receipt.receipt_date}</td><td>{receipt.creator_name || "—"}</td><td>{Number(receipt.total_pallet).toLocaleString("vi-VN")}</td><td>{Number(receipt.total_quantity).toLocaleString("vi-VN")}</td><td>{receipt.status === "cancelled" ? "Đã hủy" : "Hoạt động"}</td><td><div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}><button className="button button-primary" type="button" disabled={working === "detail"} onClick={() => loadReceiptDetail(receipt.receipt_id)}>{working === "detail" && activeReceiptId === receipt.receipt_id ? "Đang tải..." : "Xem chi tiết"}</button><button className="button button-secondary" type="button" disabled={working === "reprint"} onClick={() => reprintReceipt(receipt.receipt_id)}>{working === "reprint" && activeReceiptId === receipt.receipt_id ? "Đang in..." : "In lại"}</button></div></td></tr>)}
        </tbody></table></div>}
      </div>

      {detailReceiptId ? <div className="modal-backdrop" onMouseDown={() => setDetailReceiptId(null)}><div className="modal-card" style={{ maxWidth: "1100px", width: "calc(100% - 2rem)" }} onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">CHI TIẾT PHIẾU NHẬP KHO</p><h2>{detailReceiptId}</h2></div><button type="button" className="modal-close" onClick={() => setDetailReceiptId(null)}>×</button></div><div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>Pallet ID</th><th>WO</th><th>Item code</th><th>Product name</th><th>Customer</th><th>Số lượng</th></tr></thead><tbody>{detailRows.map((row) => <tr key={row.pallet_id}><td><strong>{row.pallet_id}</strong></td><td>{row.wo || "—"}</td><td>{row.itemcode || "—"}</td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td>{Number(row.quantity ?? 0).toLocaleString("vi-VN")}</td></tr>)}</tbody></table></div><div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setDetailReceiptId(null)}>Đóng</button></div></div></div> : null}
    </section>
  );
}
