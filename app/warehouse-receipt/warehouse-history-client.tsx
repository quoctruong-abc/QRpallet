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

export function WarehouseHistoryClient() {
  const [receiptDate, setReceiptDate] = useState("");
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [working, setWorking] = useState<"history" | "reprint" | null>(null);
  const [activeReceiptId, setActiveReceiptId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function loadReceipts(date = receiptDate) {
    setWorking("history");
    setNotice(null);
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
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
      setNotice({ type: "success", text: `Đã tải lại phiếu ${receiptId}.` });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể in lại phiếu." });
    } finally {
      setWorking(null);
      setActiveReceiptId(null);
    }
  }

  useEffect(() => { void loadReceipts(""); }, []);

  return (
    <section className="warehouse-page">
      <div className="hero-row">
        <div><h1>Lịch sử phiếu nhập kho</h1><p className="muted">Module này chỉ dùng để xem lịch sử và in lại phiếu. Việc tạo phiếu được thực hiện tại module Scan nhập kho.</p></div>
        <div className="stat-card"><span className="stat-number">{receipts.length}</span><span className="muted">Phiếu đang hiển thị</span></div>
      </div>

      <div className="warehouse-filter-card">
        <label><span>Ngày phiếu</span><input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} /></label>
        <button className="button button-primary" type="button" disabled={working === "history"} onClick={() => loadReceipts()}>{working === "history" ? "Đang tải..." : "Tìm theo ngày"}</button>
        <button className="button button-secondary" type="button" disabled={working === "history"} onClick={() => { setReceiptDate(""); void loadReceipts(""); }}>7 ngày gần nhất</button>
      </div>

      {notice ? <div className={`alert ${notice.type === "error" ? "alert-error" : "alert-success"}`}>{notice.text}</div> : null}

      <div className="scan-table-card">
        {!receipts.length ? <div className="scan-empty">Không có phiếu nhập kho phù hợp.</div> : <div className="scan-table-wrap"><table className="warehouse-table"><thead><tr><th>Số phiếu</th><th>Ngày</th><th>Tổng pallet</th><th>Tổng số lượng</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>
          {receipts.map((receipt) => <tr key={receipt.receipt_id}><td><strong>{receipt.receipt_id}</strong></td><td>{receipt.receipt_date}</td><td>{Number(receipt.total_pallet).toLocaleString("vi-VN")}</td><td>{Number(receipt.total_quantity).toLocaleString("vi-VN")}</td><td>{receipt.status === "cancelled" ? "Đã hủy" : "Hoạt động"}</td><td><button className="button button-secondary" type="button" disabled={working === "reprint"} onClick={() => reprintReceipt(receipt.receipt_id)}>{activeReceiptId === receipt.receipt_id ? "Đang in..." : "In lại"}</button></td></tr>)}
        </tbody></table></div>}
      </div>
    </section>
  );
}
