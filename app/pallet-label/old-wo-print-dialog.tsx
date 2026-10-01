"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { PlanItem } from "./pallet-label-client";

type OldWoPallet = {
  pallet_id: string;
  wo: string;
  itemcode: string;
  quantity: number;
  status: string;
  working_day: string | null;
  created_at: string;
  reprint_count: number;
  is_deleted: boolean;
};

type Props = {
  onClose: () => void;
  onPrintCompensation: (workOrder: PlanItem) => void;
};

const vietnamDateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatNumber(value: number | null) {
  return value === null ? "—" : Number(value).toLocaleString("vi-VN");
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : vietnamDateTimeFormatter.format(date);
}

function formatWorkingDay(value: string | null) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function statusLabel(status: string) {
  switch (status.toLowerCase()) {
    case "production": return "Đã sản xuất";
    case "pendingwh": return "Đã scan";
    case "processingwh": return "Đang nhập kho";
    case "whdone": return "Đã nhập kho";
    case "deleted": return "Đã xóa";
    default: return status || "—";
  }
}

function ProgressBar({ value, total }: { value: number; total: number | null }) {
  const hasTotal = total !== null && total > 0;
  const percent = hasTotal ? (value / total) * 100 : 0;

  return (
    <div className="old-wo-progress">
      <div className="old-wo-progress-copy">
        <strong>{formatNumber(value)}</strong>
        <span>/ {formatNumber(total)}</span>
        <small>{hasTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small>
      </div>
      <div className="quantity-progress-track" aria-hidden="true">
        <span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} />
      </div>
    </div>
  );
}

export function OldWoPrintDialog({ onClose, onPrintCompensation }: Props) {
  const router = useRouter();
  const [searchWo, setSearchWo] = useState("");
  const [workOrder, setWorkOrder] = useState<PlanItem | null>(null);
  const [pallets, setPallets] = useState<OldWoPallet[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [reprintingPalletId, setReprintingPalletId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function searchOldWo() {
    const wo = searchWo.trim();
    if (!wo) {
      setMessage({ type: "error", text: "Vui lòng nhập số WO cần tìm." });
      return;
    }

    setSearching(true);
    setSearched(false);
    setWorkOrder(null);
    setPallets([]);
    setMessage(null);

    try {
      const params = new URLSearchParams({ wo });
      const response = await fetch(`/api/pallet-label/old-wo?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể tải dữ liệu WO cũ.");
      }

      setWorkOrder(result.workOrder as PlanItem);
      setPallets(result.pallets as OldWoPallet[]);
      setSearched(true);
    } catch (error) {
      setSearched(true);
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể tải dữ liệu WO cũ.",
      });
    } finally {
      setSearching(false);
    }
  }

  async function reprintPallet(palletId: string) {
    const pdfWindow = window.open("", "_blank");
    setReprintingPalletId(palletId);
    setMessage(null);

    try {
      const response = await fetch("/api/pallet-label/reprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pallet_id: palletId }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể in lại pallet.");
      }

      const reprintCount = Number(result.pallet?.reprint_count ?? 0);
      setPallets((current) => current.map((pallet) => (
        pallet.pallet_id === palletId ? { ...pallet, reprint_count: reprintCount } : pallet
      )));

      const pdfUrl = `/api/pallet-label/pdf?palletId=${encodeURIComponent(palletId)}`;
      if (pdfWindow) pdfWindow.location.href = pdfUrl;
      else router.push(pdfUrl);
      setMessage({
        type: "success",
        text: `Đã mở PDF in lại ${palletId}. Số lần in lại: ${reprintCount}.`,
      });
    } catch (error) {
      pdfWindow?.close();
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể in lại pallet.",
      });
    } finally {
      setReprintingPalletId(null);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void searchOldWo();
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !reprintingPalletId) onClose();
  }

  return (
    <div className="modal-backdrop old-wo-print-backdrop" onMouseDown={handleBackdropMouseDown}>
      <style>{`
        .old-wo-print-backdrop { z-index: 1050; }
        .old-wo-print-modal { width: min(1180px, calc(100% - 24px)); max-height: 92vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; }
        .old-wo-search { display: grid; grid-template-columns: minmax(240px, 1fr) auto; gap: 10px; align-items: end; margin-bottom: 16px; }
        .old-wo-search label { display: grid; gap: 6px; }
        .old-wo-search label span { color: var(--muted); font-size: .76rem; font-weight: 850; letter-spacing: .04em; text-transform: uppercase; }
        .old-wo-result { min-height: 0; overflow: auto; padding-right: 2px; }
        .old-wo-info-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
        .old-wo-info-item { min-width: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: #f8fafc; }
        .old-wo-info-item span { display: block; margin-bottom: 5px; color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
        .old-wo-info-item strong { display: block; overflow-wrap: anywhere; }
        .old-wo-progress-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        .old-wo-progress-card { padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
        .old-wo-progress-card > span { display: block; margin-bottom: 9px; color: #344054; font-size: .82rem; font-weight: 850; }
        .old-wo-progress { display: grid; gap: 8px; }
        .old-wo-progress-copy { display: flex; align-items: baseline; gap: 5px; }
        .old-wo-progress-copy strong { font-size: 1.08rem; }
        .old-wo-progress-copy span { color: var(--muted); }
        .old-wo-progress-copy small { margin-left: auto; color: var(--primary); font-weight: 850; }
        .old-wo-table-wrap { max-height: 330px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
        .old-wo-table { min-width: 980px; margin: 0; }
        .old-wo-table thead { position: sticky; top: 0; z-index: 1; }
        .old-wo-table th { background: #f8fafc; }
        .old-wo-deleted-row { color: #667085; background: #fcfcfd; }
        .old-wo-status { display: inline-flex; padding: 5px 8px; border-radius: 999px; background: #f2f4f7; font-size: .75rem; font-weight: 800; white-space: nowrap; }
        .old-wo-empty { padding: 34px 16px; color: var(--muted); text-align: center; }
        .old-wo-footer { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
        @media (max-width: 720px) {
          .old-wo-print-modal { max-height: 94vh; padding: 18px; }
          .old-wo-search { grid-template-columns: 1fr; }
          .old-wo-search .button { width: 100%; }
          .old-wo-info-grid { grid-template-columns: 1fr 1fr; }
          .old-wo-info-item-product { grid-column: 1 / -1; }
          .old-wo-progress-grid { grid-template-columns: 1fr; }
          .old-wo-footer .button { flex: 1; }
        }
      `}</style>

      <div className="modal-card old-wo-print-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><p className="eyebrow">PALLET</p><h2>In tem ngày cũ</h2></div>
          <button className="modal-close" disabled={reprintingPalletId !== null} onClick={onClose} type="button">×</button>
        </div>

        <div className="old-wo-search">
          <label>
            <span>Tìm theo WO</span>
            <input
              autoFocus
              value={searchWo}
              onChange={(event) => setSearchWo(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Nhập chính xác số WO"
            />
          </label>
          <button className="button button-primary" disabled={searching} onClick={() => void searchOldWo()} type="button">
            {searching ? "Đang tìm..." : "Tìm kiếm"}
          </button>
        </div>

        <div className="old-wo-result">
          {message ? <p className={`alert alert-${message.type}`}>{message.text}</p> : null}

          {workOrder ? <>
            <div className="old-wo-info-grid">
              <div className="old-wo-info-item"><span>WO</span><strong>{workOrder.wo}</strong></div>
              <div className="old-wo-info-item"><span>Itemcode</span><strong>{workOrder.itemcode || "—"}</strong></div>
              <div className="old-wo-info-item"><span>Máy</span><strong>{workOrder.machine || "—"}</strong></div>
              <div className="old-wo-info-item"><span>Khách hàng</span><strong>{workOrder.customer || "—"}</strong></div>
              <div className="old-wo-info-item"><span>Quan order</span><strong>{formatNumber(workOrder.quanorder)}</strong></div>
              <div className="old-wo-info-item old-wo-info-item-product"><span>Product name</span><strong>{workOrder.product_name || "—"}</strong></div>
            </div>

            <div className="old-wo-progress-grid">
              <div className="old-wo-progress-card"><span>Tiến độ sản xuất</span><ProgressBar value={workOrder.produced_quantity} total={workOrder.quanorder} /></div>
              <div className="old-wo-progress-card"><span>Tiến độ kho nhập</span><ProgressBar value={workOrder.warehouse_quantity} total={workOrder.quanorder} /></div>
            </div>

            <div className="old-wo-table-wrap">
              <table className="old-wo-table">
                <thead><tr><th>Pallet ID</th><th>WO</th><th>Itemcode</th><th>Số lượng</th><th>Ngày sản xuất</th><th>Trạng thái</th><th>Ngày tạo</th><th>Lần in lại</th><th>Thao tác</th></tr></thead>
                <tbody>
                  {pallets.map((pallet) => <tr className={pallet.is_deleted ? "old-wo-deleted-row" : undefined} key={`${pallet.pallet_id}-${pallet.created_at}`}>
                    <td><strong>{pallet.pallet_id}</strong></td>
                    <td>{pallet.wo}</td>
                    <td>{pallet.itemcode || "—"}</td>
                    <td>{formatNumber(pallet.quantity)}</td>
                    <td>{formatWorkingDay(pallet.working_day)}</td>
                    <td><span className="old-wo-status">{statusLabel(pallet.status)}</span></td>
                    <td>{formatDateTime(pallet.created_at)}</td>
                    <td>{formatNumber(pallet.reprint_count)}</td>
                    <td>
                      <button
                        className="button button-primary button-small"
                        disabled={pallet.is_deleted || reprintingPalletId !== null}
                        onClick={() => void reprintPallet(pallet.pallet_id)}
                        title={pallet.is_deleted ? "Không thể in lại pallet đã xóa" : undefined}
                        type="button"
                      >
                        {reprintingPalletId === pallet.pallet_id ? "Đang mở..." : "In lại"}
                      </button>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </> : searched && !message ? <div className="old-wo-empty">Không tìm thấy dữ liệu WO.</div> : !searching && !message ? <div className="old-wo-empty">Nhập WO để tải thông tin và lịch sử pallet đã in.</div> : null}
        </div>

        <div className="modal-actions old-wo-footer">
          <button className="button button-secondary" disabled={reprintingPalletId !== null} onClick={onClose} type="button">Hủy</button>
          <button
            className="button button-primary"
            disabled={!workOrder || reprintingPalletId !== null}
            onClick={() => workOrder && onPrintCompensation(workOrder)}
            type="button"
          >
            In bù tem
          </button>
        </div>
      </div>
    </div>
  );
}
