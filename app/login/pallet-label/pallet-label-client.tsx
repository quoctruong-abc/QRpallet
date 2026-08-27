"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PlanItem = {
  machine: string;
  itemcode: string;
  product_name: string;
  customer: string;
  wo: string;
  quanorder: number | null;
  produced_quantity: number;
  warehouse_quantity: number;
  quantity_per_pallet: number | null;
};

type Props = {
  rows: PlanItem[];
};

type Mode = "full" | "partial";

function formatNumber(value: number | null) {
  return value === null ? "—" : value.toLocaleString("vi-VN");
}

function QuantityProgress({ value, total }: { value: number; total: number | null }) {
  const validTotal = total !== null && total > 0;
  const percent = validTotal ? (value / total) * 100 : 0;
  const barWidth = Math.min(Math.max(percent, 0), 100);

  return (
    <div className="quantity-progress" title={validTotal ? `${percent.toFixed(1)}% kế hoạch` : "Chưa có số lượng order"}>
      <div className="quantity-progress-label">
        <strong>{formatNumber(value)}</strong>
        <span>/ {formatNumber(total)}</span>
      </div>
      <div className="quantity-progress-track" aria-hidden="true">
        <span style={{ width: `${barWidth}%` }} />
      </div>
      <small>{validTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small>
    </div>
  );
}

function ProjectedQuantityProgress({
  current,
  addition,
  total,
}: {
  current: number;
  addition: number;
  total: number | null;
}) {
  const validTotal = total !== null && total > 0;
  const safeCurrent = Math.max(current, 0);
  const safeAddition = Number.isFinite(addition) ? Math.max(addition, 0) : 0;
  const projected = safeCurrent + safeAddition;
  const currentWidth = validTotal
    ? Math.min((safeCurrent / total) * 100, 100)
    : 0;
  const projectedWidth = validTotal
    ? Math.max(Math.min((projected / total) * 100, 100) - currentWidth, 0)
    : 0;

  return (
    <div className="quantity-progress pallet-projected-progress">
      <div className="quantity-progress-label">
        <strong>{formatNumber(safeCurrent)}</strong>
        <span>+ {formatNumber(safeAddition)} = {formatNumber(projected)} / {formatNumber(total)}</span>
      </div>
      <div className="quantity-progress-track quantity-progress-track-projected" aria-hidden="true">
        <span className="quantity-progress-current" style={{ width: `${currentWidth}%` }} />
        <span className="quantity-progress-added" style={{ width: `${projectedWidth}%` }} />
      </div>
      <small>{validTotal ? `Sau khi tạo: ${Math.round((projected / total) * 100)}%` : "Chưa có order"}</small>
    </div>
  );
}

function previousVietnamWorkingDay() {
  const shifted = new Date(Date.now() + 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

export function PalletLabelClient({ rows }: Props) {
  const router = useRouter();
  const machines = useMemo(
    () => Array.from(new Set(rows.map((row) => row.machine))).sort((a, b) => a.localeCompare(b, "vi")),
    [rows],
  );
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<PlanItem | null>(null);
  const [mode, setMode] = useState<Mode>("full");
  const [partialQuantity, setPartialQuantity] = useState("");
  const [differentWorkingDay, setDifferentWorkingDay] = useState(false);
  const [workingDay, setWorkingDay] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const visibleRows = selectedMachine ? rows.filter((row) => row.machine === selectedMachine) : [];

  function openModal(row: PlanItem) {
    setSelectedRow(row);
    setMode("full");
    setPartialQuantity("");
    setDifferentWorkingDay(false);
    setWorkingDay("");
    setMessage(null);
  }

  function closeModal() {
    if (pending) return;
    setSelectedRow(null);
    setMessage(null);
    setDifferentWorkingDay(false);
    setWorkingDay("");
  }

  async function savePallet() {
    if (!selectedRow) return;
    setMessage(null);

    const quantity = mode === "full" ? selectedRow.quantity_per_pallet : Number(partialQuantity);
    if (!quantity || !Number.isInteger(quantity) || quantity <= 0) {
      setMessage({ type: "error", text: "Vui lòng nhập số lượng pallet lẻ hợp lệ." });
      return;
    }
    if (mode === "full" && !selectedRow.quantity_per_pallet) {
      setMessage({
        type: "error",
        text: `Chưa khai báo số lượng/pallet cho item ${selectedRow.itemcode} trong item_pallet_config.`,
      });
      return;
    }
    if (differentWorkingDay && !workingDay) {
      setMessage({ type: "error", text: "Vui lòng chọn ngày trên tem." });
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/pallet-label/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...selectedRow,
          quantity,
          even_pallet: mode === "full",
          working_day: differentWorkingDay ? workingDay : null,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể lưu pallet.");

      setMessage({
        type: "success",
        text: `Đã lưu pallet ${result.pallet.pallet_id} với số lượng ${Number(result.pallet.quantity).toLocaleString("vi-VN")}.`,
      });
      router.refresh();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể lưu pallet." });
    } finally {
      setPending(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <strong>Chưa có dữ liệu kế hoạch</strong>
        <p className="muted">Hãy import dữ liệu ở Planning Inject trước khi xuất tem pallet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="machine-grid" aria-label="Danh sách máy">
        {machines.map((machine) => {
          const active = machine === selectedMachine;
          const machineRows = rows.filter((row) => row.machine === machine);
          return (
            <div className="machine-grid-item" key={machine}>
              <button
                type="button"
                className={`machine-card ${active ? "machine-card-active" : ""}`}
                aria-expanded={active}
                onClick={() => setSelectedMachine(active ? null : machine)}
              >
                <span className="machine-icon" aria-hidden="true">⚙</span>
                <span>
                  <strong>{machine}</strong>
                  <small>{machineRows.length} WO / item</small>
                </span>
                <span className={`machine-chevron ${active ? "machine-chevron-open" : ""}`} aria-hidden="true">⌄</span>
              </button>

              {active ? (
                <section className="panel pallet-table-panel machine-detail-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">MACHINE</p>
                      <h2>{machine}</h2>
                    </div>
                    <button className="button button-secondary button-small" type="button" onClick={() => setSelectedMachine(null)}>
                      Thu gọn
                    </button>
                  </div>

                  <div className="table-wrap">
                    <table className="pallet-table">
                      <thead>
                        <tr>
                          <th>In tem</th>
                          <th>Itemcode</th>
                          <th>WO</th>
                          <th>Product name</th>
                          <th>Customer</th>
                          <th>Quan order</th>
                          <th>Đã chạy</th>
                          <th>Đã nhập kho</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) => (
                          <tr key={`${row.machine}-${row.wo}-${row.itemcode}`}>
                            <td>
                              <button className="button button-primary button-small" type="button" onClick={() => openModal(row)}>
                                In tem
                              </button>
                            </td>
                            <td><strong>{row.itemcode}</strong></td>
                            <td><span className="badge">{row.wo}</span></td>
                            <td>{row.product_name || "—"}</td>
                            <td>{row.customer || "—"}</td>
                            <td>{formatNumber(row.quanorder)}</td>
                            <td><QuantityProgress value={row.produced_quantity} total={row.quanorder} /></td>
                            <td><QuantityProgress value={row.warehouse_quantity} total={row.quanorder} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}
            </div>
          );
        })}
      </div>

      {selectedRow ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeModal}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="pallet-modal-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">TẠO PALLET</p>
                <h2 id="pallet-modal-title">{selectedRow.wo} · {selectedRow.itemcode}</h2>
                <p className="pallet-modal-order">SL đặt hàng: <strong>{formatNumber(selectedRow.quanorder)}</strong></p>
              </div>
              <button className="modal-close" type="button" onClick={closeModal} aria-label="Đóng">×</button>
            </div>

            <div className="pallet-summary">
              <div><span>Máy</span><strong>{selectedRow.machine}</strong></div>
              <div><span>Sản phẩm</span><strong>{selectedRow.product_name || "—"}</strong></div>
              <div><span>SL chuẩn/pallet</span><strong>{formatNumber(selectedRow.quantity_per_pallet)}</strong></div>
            </div>

            <div className="pallet-choice-grid">
              <label className={`choice-card ${mode === "full" ? "choice-card-active" : ""}`}>
                <input type="radio" name="pallet-mode" checked={mode === "full"} onChange={() => setMode("full")} />
                <span><strong>Pallet chẵn</strong><small>Lấy số lượng chuẩn theo itemcode</small></span>
              </label>
              <label className={`choice-card ${mode === "partial" ? "choice-card-active" : ""}`}>
                <input type="radio" name="pallet-mode" checked={mode === "partial"} onChange={() => setMode("partial")} />
                <span><strong>Pallet lẻ</strong><small>Nhập số lượng thực tế</small></span>
              </label>
            </div>

            <div className="pallet-quantity-grid">
              <label>
                Số lượng pallet
                <input
                  type="number"
                  min="1"
                  step="1"
                  disabled={mode === "full"}
                  value={mode === "full" ? selectedRow.quantity_per_pallet ?? "" : partialQuantity}
                  onChange={(event) => setPartialQuantity(event.target.value)}
                  placeholder={mode === "full" ? "Chưa cấu hình" : "Nhập số lượng pallet lẻ"}
                />
              </label>
              <ProjectedQuantityProgress
                current={selectedRow.produced_quantity}
                addition={mode === "full" ? selectedRow.quantity_per_pallet ?? 0 : Number(partialQuantity)}
                total={selectedRow.quanorder}
              />
            </div>

            <div className="pallet-date-section">
              <label className="pallet-date-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={differentWorkingDay}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDifferentWorkingDay(checked);
                    setWorkingDay(checked ? previousVietnamWorkingDay() : "");
                  }}
                />
                <span className="pallet-switch" aria-hidden="true" />
                <span><strong>Tem khác ngày</strong><small>Bật để chọn ngày sản xuất trên tem</small></span>
              </label>
              {differentWorkingDay ? (
                <label className="pallet-date-input">
                  Ngày trên tem
                  <input type="date" value={workingDay} onChange={(event) => setWorkingDay(event.target.value)} />
                </label>
              ) : null}
            </div>

            {message ? <p className={`alert alert-${message.type}`}>{message.text}</p> : null}

            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={closeModal} disabled={pending}>Hủy</button>
              <button className="button button-primary" type="button" onClick={savePallet} disabled={pending}>
                {pending ? "Đang lưu..." : "Xác nhận & lưu pallet"}
              </button>
            </div>
            <p className="muted small modal-note">Bước hiện tại chỉ lưu database. Chưa gửi template và chưa xuất PDF.</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
