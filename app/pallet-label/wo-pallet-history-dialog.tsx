"use client";

import { useEffect, useState, type MouseEvent } from "react";

type PalletDetail = {
  id: number;
  pallet_id: string;
  itemcode: string | null;
  wo: string | null;
  quantity: number;
  status: string;
  has_been_edited: boolean;
  edit_count: number;
  has_been_return: boolean;
  working_day: string;
  created_at: string;
  scanned_at: string | null;
  wh_receipt: string | null;
  is_deleted: boolean;
};

type PalletHistoryEvent = {
  id: string;
  type: "edit" | "return" | "delete";
  occurredAt: string;
  actor: string;
  title: string;
  description: string;
  reason: string | null;
};

type PalletWorkflow = {
  created: { actor: string; at: string };
  scanned: { actor: string; at: string } | null;
  warehouse: { actor: string; at: string | null; receiptId: string } | null;
};

type Props = {
  wo: string;
  onClose: () => void;
};

function formatNumber(value: number | null) {
  return value === null ? "—" : Number(value || 0).toLocaleString("vi-VN");
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("vi-VN");
}

function formatWorkingDay(value: string) {
  return new Date(`${value}T00:00:00+07:00`).toLocaleDateString("vi-VN");
}

function statusLabel(status: string) {
  switch (status.toLowerCase()) {
    case "production": return "Đã sản xuất";
    case "pendingwh": return "Đã scan · chờ xác nhận";
    case "processingwh": return "Đang xử lý nhập kho";
    case "whdone": return "Đã nhập kho";
    case "deleted": return "Đã xóa";
    default: return status || "—";
  }
}

function statusClass(status: string) {
  switch (status.toLowerCase()) {
    case "production": return "dashboard-status-production";
    case "pendingwh": return "dashboard-status-scanned";
    case "processingwh": return "dashboard-status-processing";
    case "whdone": return "dashboard-status-done";
    case "deleted": return "dashboard-status-deleted";
    default: return "dashboard-status-default";
  }
}

export function WoPalletHistoryDialog({ wo, onClose }: Props) {
  const [pallets, setPallets] = useState<PalletDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [historyPallet, setHistoryPallet] = useState<PalletDetail | null>(null);
  const [workflow, setWorkflow] = useState<PalletWorkflow | null>(null);
  const [history, setHistory] = useState<PalletHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadDetails() {
      try {
        const params = new URLSearchParams({ mode: "wo", key: wo, allDates: "1" });
        const response = await fetch(`/api/production-dashboard/details?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error ?? "Không thể tải chi tiết pallet.");
        }
        setPallets(result.pallets as PalletDetail[]);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailError(error instanceof Error ? error.message : "Không thể tải chi tiết pallet.");
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }

    void loadDetails();
    return () => controller.abort();
  }, [wo]);

  async function openHistory(pallet: PalletDetail) {
    setHistoryPallet(pallet);
    setWorkflow(null);
    setHistory([]);
    setHistoryError("");
    setHistoryLoading(true);

    try {
      const params = new URLSearchParams({ palletId: pallet.pallet_id });
      const response = await fetch(`/api/production-dashboard/details?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể tải lịch sử pallet.");
      }
      setWorkflow(result.flow as PalletWorkflow);
      setHistory(result.events as PalletHistoryEvent[]);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Không thể tải lịch sử pallet.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function closeHistory() {
    setHistoryPallet(null);
    setWorkflow(null);
    setHistory([]);
    setHistoryError("");
  }

  const activePallets = pallets.filter((pallet) => !pallet.is_deleted);
  const activeQuantity = activePallets.reduce((sum, pallet) => sum + pallet.quantity, 0);
  const scannedQuantity = activePallets
    .filter((pallet) => pallet.scanned_at || pallet.status.toLowerCase() !== "production")
    .reduce((sum, pallet) => sum + pallet.quantity, 0);
  const warehouseQuantity = activePallets
    .filter((pallet) => pallet.wh_receipt || pallet.status.toLowerCase() === "whdone")
    .reduce((sum, pallet) => sum + pallet.quantity, 0);
  const deletedCount = pallets.filter((pallet) => pallet.is_deleted).length;
  const historyEditCount = history.filter((event) => event.type === "edit").length;
  const historyHasReturn = history.some((event) => event.type === "return");

  return (
    <>
      <style>{`
        .pallet-wo-history-modal { width: min(1180px, calc(100% - 24px)); max-height: 90vh; overflow: auto; }
        .pallet-wo-history-backdrop { z-index: 1100; }
        .pallet-history-modal { width: min(900px, calc(100% - 24px)); max-height: 90vh; overflow: auto; }
        .dashboard-modal-summary { display: flex; gap: 12px; flex-wrap: wrap; margin: -4px 0 18px; }
        .dashboard-modal-summary span { padding: 7px 11px; border-radius: 999px; background: #f2f4f7; color: #475467; font-size: .82rem; font-weight: 750; }
        .dashboard-pallet-table { min-width: 1080px; }
        .dashboard-status { display: inline-flex; padding: 6px 9px; border-radius: 999px; font-size: .76rem; font-weight: 850; white-space: nowrap; }
        .dashboard-status-production { color: #175cd3; background: #eff8ff; }
        .dashboard-status-scanned { color: #854a0e; background: #fffaeb; }
        .dashboard-status-processing { color: #5925dc; background: #f4f3ff; }
        .dashboard-status-done { color: #027a48; background: #ecfdf3; }
        .dashboard-status-deleted { color: #b42318; background: #fef3f2; }
        .dashboard-status-default { color: #475467; background: #f2f4f7; }
        .dashboard-history-open-button { position: relative; min-width: 64px; }
        .dashboard-history-open-button .dashboard-history-alert { position: absolute; top: -7px; right: -7px; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: #d92d20; font-size: .66rem; font-weight: 900; box-shadow: 0 2px 6px rgba(217,45,32,.3); }
        .dashboard-flow-section { margin-top: 20px; padding: 18px; border: 1px solid var(--border); border-radius: 16px; background: #f8fafc; }
        .dashboard-flow-section h3, .dashboard-change-section h3 { margin: 3px 0 0; font-size: 1rem; }
        .dashboard-flow { display: grid; grid-template-columns: minmax(0,1fr) 58px minmax(0,1fr) 58px minmax(0,1fr); align-items: center; margin-top: 18px; }
        .dashboard-flow-step { min-width: 0; display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 10px; align-items: start; padding: 14px; border: 1px solid #d0d5dd; border-radius: 14px; background: #fff; }
        .dashboard-flow-step.is-complete { border-color: #abefc6; background: #f6fef9; }
        .dashboard-flow-marker { width: 38px; height: 38px; display: grid; place-items: center; border: 2px solid #d0d5dd; border-radius: 50%; color: #667085; background: #fff; font-size: .8rem; font-weight: 900; }
        .dashboard-flow-step.is-complete .dashboard-flow-marker { border-color: #12b76a; color: #027a48; background: #ecfdf3; }
        .dashboard-flow-content { min-width: 0; }
        .dashboard-flow-content strong { display: block; margin-bottom: 5px; color: #101828; }
        .dashboard-flow-content p { margin: 2px 0; color: #344054; font-size: .84rem; overflow-wrap: anywhere; }
        .dashboard-flow-content time { display: block; margin-top: 5px; color: #667085; font-size: .76rem; }
        .dashboard-flow-receipt { margin-top: 8px !important; padding-top: 8px; border-top: 1px dashed #d0d5dd; font-weight: 800; }
        .dashboard-flow-pending { color: #98a2b3 !important; }
        .dashboard-flow-connector { position: relative; height: 2px; background: #d0d5dd; }
        .dashboard-flow-connector::after { content: ""; position: absolute; top: 50%; right: -1px; width: 8px; height: 8px; border-top: 2px solid #98a2b3; border-right: 2px solid #98a2b3; transform: translateY(-50%) rotate(45deg); }
        .dashboard-change-section { margin-top: 22px; }
        .dashboard-history-list { display: grid; gap: 12px; margin-top: 14px; }
        .dashboard-history-card { padding: 15px; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
        .dashboard-history-heading { display: flex; justify-content: space-between; gap: 14px; align-items: start; margin-bottom: 9px; }
        .dashboard-history-heading strong { display: block; }
        .dashboard-history-heading time { color: var(--muted); font-size: .78rem; white-space: nowrap; }
        .dashboard-history-type { display: inline-flex; margin-bottom: 8px; padding: 4px 8px; border-radius: 999px; font-size: .7rem; font-weight: 900; text-transform: uppercase; letter-spacing: .04em; }
        .dashboard-history-type-edit { color: #175cd3; background: #eff8ff; }
        .dashboard-history-type-return { color: #854a0e; background: #fffaeb; }
        .dashboard-history-type-delete { color: #b42318; background: #fef3f2; }
        .dashboard-history-card p { margin: 5px 0 0; line-height: 1.5; }
        .dashboard-history-actor { display: block; color: var(--muted); font-size: .82rem; }
        .dashboard-history-empty { margin-top: 14px; padding: 18px; border: 1px dashed #d0d5dd; border-radius: 14px; color: #667085; text-align: center; background: #fcfcfd; }
        @media (max-width: 760px) {
          .dashboard-flow { grid-template-columns: 1fr; gap: 0; }
          .dashboard-flow-connector { width: 2px; height: 28px; margin-left: 32px; }
          .dashboard-flow-connector::after { top: auto; right: auto; bottom: -1px; left: 50%; transform: translateX(-50%) rotate(135deg); }
        }
        @media (max-width: 640px) {
          .pallet-wo-history-modal, .pallet-history-modal { padding: 18px; }
          .dashboard-history-heading { flex-direction: column; gap: 4px; }
          .dashboard-flow-section { padding: 14px; }
        }
      `}</style>

      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          aria-modal="true"
          className="modal-card pallet-wo-history-modal"
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
          role="dialog"
        >
          <div className="modal-heading">
            <div><p className="eyebrow">CHI TIẾT PALLET</p><h2>WO {wo}</h2></div>
            <button className="modal-close" onClick={onClose} type="button">×</button>
          </div>

          <div className="dashboard-modal-summary">
            <span>{activePallets.length.toLocaleString("vi-VN")} pallet active</span>
            <span>{activeQuantity.toLocaleString("vi-VN")} pcs đã sản xuất</span>
            <span>{scannedQuantity.toLocaleString("vi-VN")} pcs đã scan</span>
            <span>{warehouseQuantity.toLocaleString("vi-VN")} pcs đã nhập kho</span>
            {deletedCount ? <span>{deletedCount.toLocaleString("vi-VN")} pallet đã xóa</span> : null}
          </div>

          {detailLoading ? <p className="alert alert-success">Đang tải lịch sử in tem...</p> : null}
          {detailError ? <p className="alert alert-error">{detailError}</p> : null}

          {!detailLoading && !detailError ? (
            <div className="table-wrap">
              <table className="dashboard-pallet-table">
                <thead><tr><th>Pallet ID</th><th>WO</th><th>Itemcode</th><th>Số lượng</th><th>Tình trạng</th><th>Working day</th><th>Ngày tạo</th><th>Phiếu nhập kho</th><th>Lịch sử</th></tr></thead>
                <tbody>
                  {pallets.length ? pallets.map((pallet) => (
                    <tr key={pallet.id}>
                      <td><strong>{pallet.pallet_id}</strong></td>
                      <td>{pallet.wo ?? "—"}</td>
                      <td>{pallet.itemcode ?? "—"}</td>
                      <td>{formatNumber(pallet.quantity)}</td>
                      <td><span className={`dashboard-status ${statusClass(pallet.status)}`}>{statusLabel(pallet.status)}</span></td>
                      <td>{formatWorkingDay(pallet.working_day)}</td>
                      <td>{formatDateTime(pallet.created_at)}</td>
                      <td>{pallet.wh_receipt ?? "—"}</td>
                      <td>
                        <button
                          aria-label={`Xem lịch sử ${pallet.pallet_id}`}
                          className="button button-secondary button-small dashboard-history-open-button"
                          onClick={() => void openHistory(pallet)}
                          title="Xem flow chính và lịch sử thay đổi"
                          type="button"
                        >
                          Xem
                          {pallet.has_been_edited || pallet.has_been_return || pallet.is_deleted ? <span aria-hidden="true" className="dashboard-history-alert">!</span> : null}
                        </button>
                      </td>
                    </tr>
                  )) : <tr><td colSpan={9}>WO này chưa có lịch sử in tem.</td></tr>}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      {historyPallet ? (
        <div className="modal-backdrop pallet-wo-history-backdrop" onMouseDown={closeHistory}>
          <div
            aria-modal="true"
            className="modal-card pallet-history-modal"
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div><p className="eyebrow">LỊCH SỬ PALLET</p><h2>{historyPallet.pallet_id}</h2></div>
              <button className="modal-close" onClick={closeHistory} type="button">×</button>
            </div>

            <div className="dashboard-modal-summary">
              <span>{Math.max(historyEditCount, historyPallet.edit_count)} lần chỉnh sửa</span>
              <span>{historyHasReturn || historyPallet.has_been_return ? "Đã từng return" : "Chưa return"}</span>
              <span>Hiện tại: {statusLabel(historyPallet.status)}</span>
            </div>

            {historyLoading ? <p className="alert alert-success">Đang tải lịch sử...</p> : null}
            {historyError ? <p className="alert alert-error">{historyError}</p> : null}

            {!historyLoading && !historyError && workflow ? (
              <>
                <section className="dashboard-flow-section">
                  <p className="eyebrow">FLOW CHÍNH</p><h3>Thứ tự xử lý pallet</h3>
                  <div className="dashboard-flow">
                    <div className="dashboard-flow-step is-complete">
                      <div className="dashboard-flow-marker">1</div>
                      <div className="dashboard-flow-content"><strong>Tạo pallet</strong><p>{workflow.created.actor}</p><time>{formatDateTime(workflow.created.at)}</time></div>
                    </div>
                    <div className="dashboard-flow-connector" aria-hidden="true" />
                    <div className={`dashboard-flow-step ${workflow.scanned ? "is-complete" : ""}`}>
                      <div className="dashboard-flow-marker">2</div>
                      <div className="dashboard-flow-content"><strong>Scan pallet</strong>{workflow.scanned ? <><p>{workflow.scanned.actor}</p><time>{formatDateTime(workflow.scanned.at)}</time></> : <p className="dashboard-flow-pending">Chưa scan</p>}</div>
                    </div>
                    <div className="dashboard-flow-connector" aria-hidden="true" />
                    <div className={`dashboard-flow-step ${workflow.warehouse ? "is-complete" : ""}`}>
                      <div className="dashboard-flow-marker">3</div>
                      <div className="dashboard-flow-content"><strong>Nhập kho</strong>{workflow.warehouse ? <><p>{workflow.warehouse.actor}</p><time>{formatDateTime(workflow.warehouse.at)}</time><p className="dashboard-flow-receipt">Phiếu: {workflow.warehouse.receiptId}</p></> : <p className="dashboard-flow-pending">Chưa nhập kho</p>}</div>
                    </div>
                  </div>
                </section>

                <section className="dashboard-change-section">
                  <p className="eyebrow">LỊCH SỬ CHỈNH SỬA / RETURN / XÓA</p><h3>Dấu vết thay đổi</h3>
                  {history.length ? (
                    <div className="dashboard-history-list">
                      {history.map((event) => (
                        <article className="dashboard-history-card" key={event.id}>
                          <span className={`dashboard-history-type dashboard-history-type-${event.type}`}>{event.type === "edit" ? "EDIT" : event.type === "return" ? "RETURN" : "DELETE"}</span>
                          <div className="dashboard-history-heading"><div><strong>{event.title}</strong><span className="dashboard-history-actor">Thực hiện bởi: {event.actor}</span></div><time>{formatDateTime(event.occurredAt)}</time></div>
                          <p>{event.description}</p>
                          {event.reason ? <p><strong>Lý do:</strong> {event.reason}</p> : null}
                        </article>
                      ))}
                    </div>
                  ) : <p className="dashboard-history-empty">Pallet chưa có chỉnh sửa, return hoặc xóa.</p>}
                </section>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
