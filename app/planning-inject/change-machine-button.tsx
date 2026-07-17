"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

export function ChangeMachineButton({
  rowId,
  currentMachine,
  machines,
}: {
  rowId: number;
  currentMachine: string | null;
  machines: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [machine, setMachine] = useState(currentMachine ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function closeDialog() {
    if (pending) return;
    setOpen(false);
    setError("");
    setMachine(currentMachine ?? "");
  }

  async function confirmChange() {
    if (!machine.trim()) {
      setError("Vui lòng chọn máy.");
      return;
    }

    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/planning-inject/change-machine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rowId, machine }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể đổi máy.");
      }
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể đổi máy.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button className="button button-secondary button-small" onClick={() => setOpen(true)} type="button">
        Đổi máy
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="modal-backdrop"
              onMouseDown={closeDialog}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                display: "grid",
                placeItems: "center",
                padding: "1rem",
              }}
            >
              <div
                className="modal-card"
                onMouseDown={(event) => event.stopPropagation()}
                style={{ width: "min(100%, 460px)", margin: 0 }}
              >
                <div className="modal-heading">
                  <div>
                    <p className="eyebrow">CHANGE MACHINE</p>
                    <h2>Đổi máy</h2>
                  </div>
                  <button aria-label="Đóng" className="modal-close" onClick={closeDialog} type="button">×</button>
                </div>

                <label>
                  Máy mới
                  <select value={machine} onChange={(event) => setMachine(event.target.value)}>
                    <option value="">Chọn máy</option>
                    {machines.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>

                {error ? <p className="alert alert-error">{error}</p> : null}

                <div className="modal-actions">
                  <button className="button button-secondary" disabled={pending} onClick={closeDialog} type="button">Hủy</button>
                  <button className="button button-primary" disabled={pending || !machine.trim()} onClick={confirmChange} type="button">
                    {pending ? "Đang cập nhật..." : "Xác nhận"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
