"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  hasShiftReportWO,
  MAX_SHIFT_REPORT_OFFSET_MM,
  MAX_SHIFT_REPORT_PAGES,
  parseShiftReportOffset,
  SHIFT_REPORT_OFFSET_STORAGE_KEY,
  todayInVietnam,
  type ShiftReportPlanRow,
  type ShiftReportPrintMode,
} from "@/lib/planning-inject/shift-report";
import "./shift-report.css";

export function ShiftReportButton() {
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
        ? createPortal(<ShiftReportDialog onClose={closeDialog} />, document.body)
        : null}
    </>
  );
}

function ShiftReportDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const printNoteId = useId();
  const modeName = useId();
  const offsetNoteId = useId();
  const [selectedMachines, setSelectedMachines] = useState<Set<string>>(() => new Set());
  const [selectedWO, setSelectedWO] = useState<Record<string, string[]>>({});
  const [printMode, setPrintMode] = useState<ShiftReportPrintMode>("with-background");
  const [date, setDate] = useState(todayInVietnam);
  const [offsetInput, setOffsetInput] = useState({ x: "0", y: "0" });
  const [rows, setRows] = useState<ShiftReportPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const offset = offsetInput.x.trim() && offsetInput.y.trim()
    ? parseShiftReportOffset({ x: Number(offsetInput.x), y: Number(offsetInput.y) }) : null;
  const invalidOffset = printMode === "without-background" && !offset;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SHIFT_REPORT_OFFSET_STORAGE_KEY);
      if (!saved) return;
      const restored = parseShiftReportOffset(JSON.parse(saved));
      if (restored) setOffsetInput({ x: String(restored.x), y: String(restored.y) });
    } catch {
      // Unavailable storage or corrupt settings fall back to the original coordinates.
    }
  }, []);

  function changeOffset(axis: "x" | "y", value: string) {
    const next = { ...offsetInput, [axis]: value };
    setOffsetInput(next);
    const valid = next.x.trim() && next.y.trim()
      ? parseShiftReportOffset({ x: Number(next.x), y: Number(next.y) }) : null;
    if (!valid) return;
    try {
      window.localStorage.setItem(SHIFT_REPORT_OFFSET_STORAGE_KEY, JSON.stringify(valid));
    } catch {
      setMessage({ type: "error", text: "Trình duyệt không cho lưu độ lệch. Giá trị hiện tại vẫn dùng được trong lần mở này." });
    }
  }

  const machinePlans = useMemo(() => {
    const plans = new Map<string, ShiftReportPlanRow[]>();
    for (const row of rows) {
      const machine = row.machine?.trim();
      const wo = row.wo?.trim();
      if (!machine || !wo || !hasShiftReportWO(row)) continue;
      const options = plans.get(machine) ?? [];
      // Keep the first occurrence and the current plan's order for each WO.
      if (!options.some((option) => option.wo?.trim() === wo)) options.push(row);
      plans.set(machine, options);
    }
    return plans;
  }, [rows]);
  const machineNames = Array.from(machinePlans.entries())
    .filter(([, options]) => options.length > 0)
    .map(([machine]) => machine);
  const selectedCount = machineNames.filter((machine) => selectedMachines.has(machine)).length;
  const allSelected = machineNames.length > 0 && selectedCount === machineNames.length;
  const selections = machineNames
    .filter((machine) => selectedMachines.has(machine))
    .flatMap((machine) => {
      const options = machinePlans.get(machine) ?? [];
      const workOrders = selectedWO[machine] ?? [options[0].wo!.trim()];
      return workOrders.map((wo) => {
        const row = options.find((option) => option.wo?.trim() === wo)!;
        return { id: row.id, machine, wo };
      });
    });
  const tooManyPages = selections.length > MAX_SHIFT_REPORT_PAGES;

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

  useEffect(() => {
    const controller = new AbortController();
    async function loadPlan() {
      try {
        const response = await fetch("/api/planning-inject/shift-report", {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.success || !Array.isArray(result.rows)) {
          throw new Error(result.error ?? "Không thể tải kế hoạch báo ca.");
        }
        if (!controller.signal.aborted) setRows(result.rows);
      } catch (error) {
        if (!controller.signal.aborted) setMessage({
          type: "error",
          text: error instanceof Error ? error.message : "Không thể tải kế hoạch báo ca.",
        });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadPlan();
    return () => controller.abort();
  }, []);

  function closeDialog() {
    if (printing) return;
    dialogRef.current?.close();
    onClose();
  }

  function toggleMachine(machine: string) {
    setSelectedMachines((current) => {
      const next = new Set(current);
      if (next.has(machine)) next.delete(machine);
      else next.add(machine);
      return next;
    });
  }

  function addWO(machine: string) {
    const options = machinePlans.get(machine) ?? [];
    setSelectedWO((current) => {
      const workOrders = current[machine] ?? [options[0].wo!.trim()];
      const next = options.find((option) => !workOrders.includes(option.wo!.trim()));
      return next ? { ...current, [machine]: [...workOrders, next.wo!.trim()] } : current;
    });
  }

  function changeWO(machine: string, index: number, wo: string) {
    setSelectedWO((current) => {
      const workOrders = current[machine] ?? [machinePlans.get(machine)![0].wo!.trim()];
      if (workOrders.some((value, position) => position !== index && value === wo)) return current;
      return { ...current, [machine]: workOrders.map((value, position) => position === index ? wo : value) };
    });
  }

  function removeWO(machine: string, index: number) {
    setSelectedWO((current) => ({
      ...current,
      [machine]: current[machine].filter((_, position) => position !== index),
    }));
  }

  async function printBatch() {
    if (printing || loading || !selectedCount || !date || invalidOffset || tooManyPages) return;
    // Open synchronously from the click, before awaiting the batch API.
    const pdfWindow = window.open("", "_blank");
    if (!pdfWindow) {
      setMessage({ type: "error", text: "Trình duyệt đã chặn tab PDF. Vui lòng cho phép popup và nhấn In báo ca lại." });
      return;
    }
    pdfWindow.document.title = "Đang tạo báo ca";
    pdfWindow.document.body.textContent = "Đang tạo PDF báo ca...";
    setPrinting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/planning-inject/shift-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections, date, mode: printMode, offset: printMode === "without-background" ? offset : { x: 0, y: 0 } }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error ?? "Không thể tạo PDF báo ca.");
      }
      const url = URL.createObjectURL(await response.blob());
      if (pdfWindow.closed) {
        URL.revokeObjectURL(url);
        throw new Error("Tab PDF đã đóng. Vui lòng nhấn In báo ca lại.");
      }
      pdfWindow.location.href = url;
      // Leave enough time for the viewer to load, print or download the batch.
      window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      setMessage({ type: "success", text: `Đã mở PDF gồm ${selections.length} trang. In toàn bộ PDF trong một lần.` });
    } catch (error) {
      pdfWindow.close();
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể tạo PDF báo ca." });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <dialog
      aria-labelledby={titleId}
      className="shift-report-dialog"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      ref={dialogRef}
    >
      <header className="shift-report-header">
        <h2 id={titleId}>In báo ca</h2>
        <div className="shift-report-selection">
          <label className="shift-report-date">
            Ngày báo ca
            <input disabled={printing} onChange={(event) => setDate(event.target.value)} required type="date" value={date} />
          </label>
          <span className="muted small">Đã chọn {selectedCount}/{machineNames.length} máy · {selections.length} WO</span>
          <button
            aria-pressed={allSelected}
            className="button button-secondary"
            disabled={loading || printing || machineNames.length === 0}
            onClick={() => setSelectedMachines(allSelected ? new Set() : new Set(machineNames))}
            type="button"
          >
            {allSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}
          </button>
        </div>
      </header>

      <div className="shift-report-body">
        {message ? <p aria-live="polite" className={`alert alert-${message.type}`}>{message.text}</p> : null}
        {tooManyPages ? <p className="alert alert-error" role="alert">Mỗi lần in tối đa {MAX_SHIFT_REPORT_PAGES} WO. Vui lòng giảm số WO đã chọn.</p> : null}
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
              {loading ? (
                <tr><td className="shift-report-empty" colSpan={6}>Đang tải kế hoạch...</td></tr>
              ) : machineNames.length === 0 ? (
                <tr><td className="shift-report-empty" colSpan={6}>Chưa có máy có WO trong kế hoạch hiện tại.</td></tr>
              ) : machineNames.map((machine) => {
                const options = machinePlans.get(machine) ?? [];
                const workOrders = selectedWO[machine] ?? [options[0].wo!.trim()];
                const checked = selectedMachines.has(machine);
                return (
                  <Fragment key={machine}>
                    {workOrders.map((wo, index) => {
                      const plan = options.find((option) => option.wo?.trim() === wo)!;
                      const child = index > 0;
                      return (
                        <tr className={`${checked ? "is-selected" : ""}${child ? " shift-report-child-row" : ""}`} key={index}>
                          <td>
                            {!child ? <input
                              aria-label={`Chọn máy ${machine}`}
                              checked={checked}
                              disabled={printing}
                              onChange={() => toggleMachine(machine)}
                              type="checkbox"
                            /> : null}
                          </td>
                          <th scope="row">
                            <div className="shift-report-machine-actions">
                              <span>{child ? `↳ ${machine}` : machine}</span>
                              {child ? <button
                                aria-label={`Xóa WO ${wo} của máy ${machine}`}
                                className="button button-secondary"
                                disabled={printing}
                                onClick={() => removeWO(machine, index)}
                                type="button"
                              >Xóa WO</button> : checked && options.length > 1 ? <button
                                aria-label={`Thêm WO cho máy ${machine}`}
                                className="button button-secondary"
                                disabled={printing || workOrders.length >= options.length}
                                onClick={() => addWO(machine)}
                                type="button"
                              >Thêm WO</button> : null}
                            </div>
                          </th>
                          <td>
                            <select
                              aria-label={child ? `WO bổ sung ${index} của máy ${machine}` : `WO của máy ${machine}`}
                              disabled={printing}
                              onChange={(event) => changeWO(machine, index, event.target.value)}
                              value={wo}
                            >
                              {options.map((option) => (
                                <option disabled={option.wo?.trim() !== wo && workOrders.includes(option.wo!.trim())} key={option.wo?.trim()} value={option.wo?.trim()}>{option.wo}</option>
                              ))}
                            </select>
                          </td>
                          <td>{plan?.customer || "—"}</td>
                          <td>{plan?.itemcode || "—"}</td>
                          <td>{plan?.product_name || "—"}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="shift-report-footer">
        <div className="shift-report-print-settings">
          <fieldset className="shift-report-modes">
            <legend>Chế độ in</legend>
            <label title="In cả form và thông tin">
              <input checked={printMode === "with-background"} disabled={printing} name={modeName} onChange={() => setPrintMode("with-background")} type="radio" value="with-background" />
              <span>Có nền <small>In cả form và thông tin</small></span>
            </label>
            <label title="Điền thông tin lên giấy có sẵn form">
              <input checked={printMode === "without-background"} disabled={printing} name={modeName} onChange={() => setPrintMode("without-background")} type="radio" value="without-background" />
              <span>Không nền <small>Điền lên giấy có sẵn form</small></span>
            </label>
          </fieldset>
          {printMode === "without-background" ? <fieldset className="shift-report-offsets" disabled={printing}>
            <legend>Canh vị trí khi không nền</legend>
            <div className="shift-report-offset-inputs">
              <label title="X: + sang phải, − sang trái">
                X (mm)
                <input aria-describedby={offsetNoteId} aria-invalid={invalidOffset} type="number" min={-MAX_SHIFT_REPORT_OFFSET_MM} max={MAX_SHIFT_REPORT_OFFSET_MM} step="0.1" value={offsetInput.x} onChange={(event) => changeOffset("x", event.target.value)} />
              </label>
              <label title="Y: + xuống, − lên">
                Y (mm)
                <input aria-describedby={offsetNoteId} aria-invalid={invalidOffset} type="number" min={-MAX_SHIFT_REPORT_OFFSET_MM} max={MAX_SHIFT_REPORT_OFFSET_MM} step="0.1" value={offsetInput.y} onChange={(event) => changeOffset("y", event.target.value)} />
              </label>
            </div>
            <p className="muted small" id={offsetNoteId}>X: + sang phải, − sang trái. Y: + xuống, − lên. Tự lưu trên trình duyệt.</p>
            {invalidOffset ? <p className="alert alert-error small" role="alert">Nhập X/Y từ -20 đến 20 mm.</p> : null}
          </fieldset> : null}
        </div>
        <div className="shift-report-footer-actions">
          <p className="muted small" id={printNoteId}>
            Mỗi WO một trang. A4 ngang, 100%.
          </p>
          <div className="shift-report-buttons">
            <button aria-describedby={printNoteId} className="button button-primary" disabled={loading || printing || !selectedCount || !date || invalidOffset || tooManyPages} onClick={printBatch} title="Gộp chung một PDF. In A4 ngang, tỉ lệ 100%." type="button">
              {printing ? "Đang tạo PDF..." : "In báo ca"}
            </button>
            <button className="button button-secondary" disabled={printing} onClick={closeDialog} type="button">Cancel</button>
          </div>
        </div>
      </footer>
    </dialog>
  );
}
