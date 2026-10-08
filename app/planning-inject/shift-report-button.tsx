"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlanningRow } from "@/lib/planning";
import "./shift-report.css";

type ShiftReportProps = {
  machines: string[];
  rows: PlanningRow[];
  totalRows: number;
};

type PrintMode = "with-background" | "without-background";

export function ShiftReportButton(props: ShiftReportProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeDialog() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="button button-primary"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        In báo ca
      </button>
      {open
        ? createPortal(<ShiftReportDialog {...props} onClose={closeDialog} />, document.body)
        : null}
    </>
  );
}

function ShiftReportDialog({
  machines,
  rows,
  totalRows,
  onClose,
}: ShiftReportProps & { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const printNoteId = useId();
  const modeName = useId();
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(() => new Set());
  const [selectedWO, setSelectedWO] = useState<Record<string, string>>({});
  const [printMode, setPrintMode] = useState<PrintMode>("with-background");

  const machinePlans = useMemo(() => {
    const plans = new Map<string, PlanningRow[]>();
    for (const machine of machines) plans.set(machine, []);
    for (const row of rows) {
      const machine = row.machine?.trim();
      const wo = row.wo?.trim();
      if (!machine || !wo || wo === "0") continue;
      const options = plans.get(machine) ?? [];
      // Keep the first occurrence and the current plan's order for each WO.
      if (!options.some((option) => option.wo?.trim() === wo)) options.push(row);
      plans.set(machine, options);
    }
    return plans;
  }, [machines, rows]);
  const machineNames = Array.from(machinePlans.keys());
  const selectedCount = machineNames.filter((machine) => selectedMachines.has(machine)).length;
  const allSelected = machineNames.length > 0 && selectedCount === machineNames.length;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function toggleMachine(machine: string) {
    setSelectedMachines((current) => {
      const next = new Set(current);
      if (next.has(machine)) next.delete(machine);
      else next.add(machine);
      return next;
    });
  }

  return (
    <dialog
      aria-labelledby={titleId}
      className="shift-report-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <header className="shift-report-header">
        <div>
          <p className="eyebrow">CURRENT PLAN</p>
          <h2 id={titleId}>In báo ca</h2>
          <p className="muted small">Chọn máy và WO cần điền vào báo cáo ca.</p>
        </div>
        <div className="shift-report-selection">
          <span className="muted small">Đã chọn {selectedCount}/{machineNames.length} máy</span>
          <button
            aria-pressed={allSelected}
            className="button button-secondary"
            disabled={machineNames.length === 0}
            onClick={() => setSelectedMachines(allSelected ? new Set() : new Set(machineNames))}
            type="button"
          >
            {allSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}
          </button>
        </div>
      </header>

      <div className="shift-report-body">
        {totalRows > rows.length ? (
          <p className="planning-warning">
            WO đang hiển thị từ {rows.length} dòng kế hoạch đã tải. Danh sách WO đầy đủ sẽ được bổ sung ở bước lấy dữ liệu báo ca.
          </p>
        ) : null}
        <div className="shift-report-table-wrap">
          <table className="shift-report-table">
            <colgroup>
              <col className="shift-report-check-column" />
              <col className="shift-report-machine-column" />
              <col className="shift-report-wo-column" />
              <col className="shift-report-customer-column" />
              <col className="shift-report-item-column" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Chọn</th>
                <th scope="col">Máy</th>
                <th scope="col">WO</th>
                <th scope="col">Customer</th>
                <th scope="col">Itemcode</th>
                <th scope="col">Tên sản phẩm</th>
              </tr>
            </thead>
            <tbody>
              {machineNames.length === 0 ? (
                <tr><td className="shift-report-empty" colSpan={6}>Chưa có máy trong kế hoạch hiện tại.</td></tr>
              ) : machineNames.map((machine) => {
                const options = machinePlans.get(machine) ?? [];
                const plan = options.find((option) => option.wo?.trim() === selectedWO[machine]) ?? options[0];
                const checked = selectedMachines.has(machine);
                return (
                  <tr className={checked ? "is-selected" : undefined} key={machine}>
                    <td>
                      <input
                        aria-label={`Chọn máy ${machine}`}
                        checked={checked}
                        onChange={() => toggleMachine(machine)}
                        type="checkbox"
                      />
                    </td>
                    <th scope="row">{machine}</th>
                    <td>
                      <select
                        aria-label={`WO của máy ${machine}`}
                        disabled={options.length === 0}
                        onChange={(event) => setSelectedWO((current) => ({
                          ...current,
                          [machine]: event.target.value,
                        }))}
                        value={plan?.wo?.trim() ?? ""}
                      >
                        {options.length === 0 ? <option value="">Chưa có WO đã tải</option> : null}
                        {options.map((option) => (
                          <option key={option.wo?.trim()} value={option.wo?.trim()}>{option.wo}</option>
                        ))}
                      </select>
                    </td>
                    <td>{plan?.customer || "—"}</td>
                    <td>{plan?.itemcode || "—"}</td>
                    <td>{plan?.product_name || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="shift-report-footer">
        <fieldset className="shift-report-modes">
          <legend>Chế độ in</legend>
          <label>
            <input checked={printMode === "with-background"} name={modeName} onChange={() => setPrintMode("with-background")} type="radio" value="with-background" />
            <span>Có nền <small>In cả form và thông tin</small></span>
          </label>
          <label>
            <input checked={printMode === "without-background"} name={modeName} onChange={() => setPrintMode("without-background")} type="radio" value="without-background" />
            <span>Không nền <small>Điền thông tin lên giấy có sẵn form</small></span>
          </label>
        </fieldset>
        <div className="shift-report-footer-actions">
          <p className="muted small" id={printNoteId}>Chức năng in sẽ được bổ sung ở bước tiếp theo.</p>
          <div className="shift-report-buttons">
            <button aria-describedby={printNoteId} className="button button-primary" disabled type="button">In báo ca</button>
            <button className="button button-secondary" onClick={onClose} type="button">Cancel</button>
          </div>
        </div>
      </footer>
    </dialog>
  );
}
