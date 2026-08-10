"use client";

import { useState, type MouseEvent } from "react";

export type DashboardMode = "wo" | "item";

export type DashboardSummaryRow = {
  key: string;
  label: string;
  itemcode: string;
  productName: string;
  customer: string;
  orderQuantity: number;
  palletCount: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
  warning: boolean;
};

type PalletDetail = {
  id: number;
  pallet_id: string;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | null;
  quantity: number;
  status: string;
  note: string | null;
  has_been_edited: boolean;
  edit_count: number;
  has_been_return: boolean;
  working_day: string;
  created_at: string;
  updated_at: string;
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
  created: {
    actor: string;
    at: string;
  };
  scanned: {
    actor: string;
    at: string;
  } | null;
  warehouse: {
    actor: string;
    at: string | null;
    receiptId: string;
  } | null;
};

type Props = {
  rows: DashboardSummaryRow[];
  mode: DashboardMode;
  startDate: string;
  endDate: string;
  totals: {
    orderQuantity: number;
    palletCount: number;
    producedQuantity: number;
    scannedQuantity: number;
    warehouseQuantity: number;
  };
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
    case "production":
      return "Đã sản xuất";
    case "pendingwh":
      return "Đã scan · chờ xác nhận";
    case "processingwh":
      return "Đang xử lý nhập kho";
    case "whdone":
      return "Đã nhập kho";
    case "deleted":
      return "Đã xóa";
    default:
      return status || "—";
  }
}

function statusClass(status: string) {
  switch (status.toLowerCase()) {
    case "production":
      return "dashboard-status-production";
    case "pendingwh":
      return "dashboard-status-scanned";
    case "processingwh":
      return "dashboard-status-processing";
    case "whdone":
      return "dashboard-status-done";
    case "deleted":
      return "dashboard-status-deleted";
    default:
      return "dashboard-status-default";
  }
}

function QuantityProgress({ value, total }: { value: number; total: number }) {
  const validTotal = total > 0;
  const percent = validTotal ? (value / total) * 100 : 0;

  return (
    <div className="quantity-progress">
      <div className="quantity-progress-label">
        <strong>{formatNumber(value)}</strong>
        <span>/ {validTotal ? formatNumber(total) : "—"}</span>
      </div>
      <div className="quantity-progress-track">
        <span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} />
      </div>
      <small>{validTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small>
    </div>
  );
}

export function DashboardTableClient({ rows, mode, startDate, endDate, totals }: Props) {
  const [selectedRow, setSelectedRow] = useState<DashboardSummaryRow | null>(null);
  const [pallets, setPallets] = useState<PalletDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [historyPallet, setHistoryPallet] = useState<PalletDetail | null>(null);
  const [workflow, setWorkflow] = useState<PalletWorkflow | null>(null);
  const [history, setHistory] = useState<PalletHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  async function openDetails(row: DashboardSummaryRow) {
    setSelectedRow(row);
    setPallets([]);
    setDetailError("");
    setDetailLoading(true);
    setHistoryPallet(null);
    setWorkflow(null);
    setHistory([]);

    try {
      const params = new URLSearchParams({
        mode,
        key: row.key,
        from: startDate,
        to: endDate,
      });
      const response = await fetch(`/api/production-dashboard/details?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể tải chi tiết pallet.");
      }
      setPallets(result.pallets as PalletDetail[]);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Không thể tải chi tiết pallet.");
    } finally {
      setDetailLoading(false);
    }
  }

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

  function closeDetails() {
    setSelectedRow(null);
    setPallets([]);
    setDetailError("");
    setHistoryPallet(null);
    setWorkflow(null);
    setHistory([]);
    setHistoryError("");
  }

  function closeHistory() {
    setHistoryPallet(null);
    setWorkflow(null);
    setHistory([]);
    setHistoryError("");
  }

  const historyEditCount = history.filter((event) => event.type === "edit").length;
  const historyHasReturn = history.some((event) => event.type === "return");

  return (
    <>
      <style>{`
        .dashboard-table { min-width: 1260px; }
        .dashboard-warning-button { width: 22px; height: 22px; display: inline-grid; place-items: center; margin-left: 7px; padding: 0; border: 0; border-radius: 50%; color: white; background: #d92d20; font-size: .76rem; font-weight: 900; line-height: 1; cursor: pointer; vertical-align: middle; box-shadow: 0 2px 6px rgba(217,45,32,.28); }
        .dashboard-warning-button:hover { transform: translateY(-1px); background: #b42318; }
        .dashboard-total-row td { border-top: 2px solid #98a2b3; background: #f8fafc; font-weight: 800; }
        .dashboard-total-label { font-size: 1rem; }
        .dashboard-empty { padding: 42px 20px; color: var(--muted); text-align: center; }
        .dashboard-pallet-count { display: inline-flex; min-width: 46px; justify-content: center; padding: 5px 10px; border-radius: 999px; color: #175cd3; background: #eff8ff; font-weight: 850; }
        .dashboard-detail-button { white-space: nowrap; }
        .dashboard-detail-modal { width: min(1180px, calc(100% - 24px)); max-height: 90vh; overflow: auto; }
        .dashboard-history-backdrop { z-index: 1100; }
        .dashboard-history-modal { width: min(900px, calc(100% - 24px)); max-height: 90vh; overflow: auto; }
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
          .dashboard-detail-modal, .dashboard-history-modal { padding: 18px; }
          .dashboard-history-heading { flex-direction: column; gap: 4px; }
          .dashboard-flow-section { padding: 14px; }
        }
      `}</style>

      <div className="table-wrap">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>{mode === "wo" ? "WO" : "Itemcode"}</th>
              {mode === "wo" ? <th>Itemcode</th> : null}
              <th>Product name</th>
              <th>Customer</th>
              <th>Quan order</th>
              <th>Số pallet</th>
              <th>Đã sản xuất</th>
              <th>Đã scan</th>
              <th>Đã nhập kho</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.warning ? (
                      <button
                        aria-label={`Có pallet thuộc ${row.label} đã chỉnh sửa, return hoặc xóa`}
                        className="dashboard-warning-button"
                        onClick={() => openDetails(row)}
                        title="Có pallet đã chỉnh sửa, return hoặc xóa. Bấm để xem chi tiết."
                        type="button"
                      >
                        !
                      </button>
                    ) : null}
                  </td>
                  {mode === "wo" ? <td>{row.itemcode}</td> : null}
                  <td>{row.productName}</td>
                  <td>{row.customer}</td>
                  <td>{formatNumber(row.orderQuantity)}</td>
                  <td><span className="dashboard-pallet-count">{formatNumber(row.palletCount)}</span></td>
                  <td><QuantityProgress total={row.orderQuantity} value={row.producedQuantity} /></td>
                  <td><QuantityProgress total={row.orderQuantity} value={row.scannedQuantity} /></td>
                  <td><QuantityProgress total={row.orderQuantity} value={row.warehouseQuantity} /></td>
                  <td>
                    <button
                      className="button button-secondary button-small dashboard-detail-button"
                      onClick={() => openDetails(row)}
                      type="button"
                    >
                      Xem pallet
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="dashboard-empty" colSpan={mode === "wo" ? 10 : 9}>
                  Không có dữ liệu pallet trong khoảng ngày đã chọn.
                </td>
              </tr>
            )}

            {rows.length ? (
              <tr className="dashboard-total-row">
                <td className="dashboard-total-label">TOTAL</td>
                {mode === "wo" ? <td>—</td> : null}
                <td>—</td>
                <td>—</td>
                <td>{formatNumber(totals.orderQuantity)}</td>
                <td>{formatNumber(totals.palletCount)}</td>
                <td><QuantityProgress total={totals.orderQuantity} value={totals.producedQuantity} /></td>
                <td><QuantityProgress total={totals.orderQuantity} value={totals.scannedQuantity} /></td>
                <td><QuantityProgress total={totals.orderQuantity} value={totals.warehouseQuantity} /></td>
                <td>—</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedRow ? (
        <div className="modal-backdrop" onMouseDown={closeDetails}>
          <div
            aria-modal="true"
            className="modal-card dashboard-detail-modal"
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">CHI TIẾT PALLET</p>
                <h2>{mode === "wo" ? `WO ${selectedRow.label}` : `Item ${selectedRow.label}`}</h2>
              </div>
              <button className="modal-close" onClick={closeDetails} type="button">×</button>
            </div>

            <div className="dashboard-modal-summary">
              <span>{selectedRow.palletCount.toLocaleString("vi-VN")} pallet active</span>
              <span>{selectedRow.producedQuantity.toLocaleString("vi-VN")} pcs đã sản xuất</span>
              <span>{selectedRow.scannedQuantity.toLocaleString("vi-VN")} pcs đã scan</span>
              <span>{selectedRow.warehouseQuantity.toLocaleString("vi-VN")} pcs đã nhập kho</span>
              {pallets.some((pallet) => pallet.is_deleted) ? (
                <span>{pallets.filter((pallet) => pallet.is_deleted).length.toLocaleString("vi-VN")} pallet đã xóa</span>
              ) : null}
            </div>

            {detailLoading ? <p className="alert alert-success">Đang tải tình trạng pallet...</p> : null}
            {detailError ? <p className="alert alert-error">{detailError}</p> : null}

            {!detailLoading && !detailError ? (
              <div className="table-wrap">
                <table className="dashboard-pallet-table">
                  <thead>
                    <tr>
                      <th>Pallet ID</th>
                      <th>WO</th>
                      <th>Itemcode</th>
                      <th>Số lượng</th>
                      <th>Tình trạng</th>
                      <th>Working day</th>
                      <th>Ngày tạo</th>
                      <th>Phiếu nhập kho</th>
                      <th>Lịch sử</th>
                    </tr>
                  </thead>
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
                            onClick={() => openHistory(pallet)}
                            title="Xem flow chính và lịch sử thay đổi"
                            type="button"
                          >
                            Xem
                            {pallet.has_been_edited || pallet.has_been_return || pallet.is_deleted ? (
                              <span aria-hidden="true" className="dashboard-history-alert">!</span>
                            ) : null}
                          </button>
                        </td>
                      </tr>
                    )) : (
                      <tr><td className="dashboard-empty" colSpan={9}>Không tìm thấy pallet phù hợp.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {historyPallet ? (
        <div className="modal-backdrop dashboard-history-backdrop" onMouseDown={closeHistory}>
          <div
            aria-modal="true"
            className="modal-card dashboard-history-modal"
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">LỊCH SỬ PALLET</p>
                <h2>{historyPallet.pallet_id}</h2>
              </div>
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
                  <p className="eyebrow">FLOW CHÍNH</p>
                  <h3>Thứ tự xử lý pallet</h3>

                  <div className="dashboard-flow">
                    <div className="dashboard-flow-step is-complete">
                      <div className="dashboard-flow-marker">1</div>
                      <div className="dashboard-flow-content">
                        <strong>Tạo pallet</strong>
                        <p>{workflow.created.actor}</p>
                        <time>{formatDateTime(workflow.created.at)}</time>
                      </div>
                    </div>

                    <div className="dashboard-flow-connector" aria-hidden="true" />

                    <div className={`dashboard-flow-step ${workflow.scanned ? "is-complete" : ""}`}>
                      <div className="dashboard-flow-marker">2</div>
                      <div className="dashboard-flow-content">
                        <strong>Scan pallet</strong>
                        {workflow.scanned ? (
                          <>
                            <p>{workflow.scanned.actor}</p>
                            <time>{formatDateTime(workflow.scanned.at)}</time>
                          </>
                        ) : (
                          <p className="dashboard-flow-pending">Chưa scan</p>
                        )}
                      </div>
                    </div>

                    <div className="dashboard-flow-connector" aria-hidden="true" />

                    <div className={`dashboard-flow-step ${workflow.warehouse ? "is-complete" : ""}`}>
                      <div className="dashboard-flow-marker">3</div>
                      <div className="dashboard-flow-content">
                        <strong>Nhập kho</strong>
                        {workflow.warehouse ? (
                          <>
                            <p>{workflow.warehouse.actor}</p>
                            <time>{formatDateTime(workflow.warehouse.at)}</time>
                            <p className="dashboard-flow-receipt">Phiếu: {workflow.warehouse.receiptId}</p>
                          </>
                        ) : (
                          <p className="dashboard-flow-pending">Chưa nhập kho</p>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="dashboard-change-section">
                  <p className="eyebrow">LỊCH SỬ CHỈNH SỬA / RETURN / XÓA</p>
                  <h3>Dấu vết thay đổi</h3>

                  {history.length ? (
                    <div className="dashboard-history-list">
                      {history.map((event) => (
                        <article className="dashboard-history-card" key={event.id}>
                          <span className={`dashboard-history-type dashboard-history-type-${event.type}`}>
                            {event.type === "edit" ? "EDIT" : event.type === "return" ? "RETURN" : "DELETE"}
                          </span>
                          <div className="dashboard-history-heading">
                            <div>
                              <strong>{event.title}</strong>
                              <span className="dashboard-history-actor">Thực hiện bởi: {event.actor}</span>
                            </div>
                            <time>{formatDateTime(event.occurredAt)}</time>
                          </div>
                          <p>{event.description}</p>
                          {event.reason ? <p><strong>Lý do:</strong> {event.reason}</p> : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="dashboard-history-empty">Pallet chưa có chỉnh sửa, return hoặc xóa.</p>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
