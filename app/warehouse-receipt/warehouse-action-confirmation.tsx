"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

type Props = {
  open: boolean; title: string; confirmLabel: string; children: ReactNode;
  disabled?: boolean; busy?: boolean;
  onCancel: () => void; onConfirm: () => void | Promise<void>;
};

export function WarehouseActionConfirmation({ open, title, confirmLabel, children, disabled, busy, onCancel, onConfirm }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const blocked = busy || acting;
  function cancelConfirmation() {
    if (busy || running.current) return;
    setError("");
    onCancel();
  }

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      cancel.current?.focus();
    } else if (!open && node.open) node.close();
  }, [open]);

  async function confirm() {
    if (!open || disabled || busy || running.current) return;
    running.current = true;
    setActing(true);
    setError("");
    try { await onConfirm(); }
    catch { setError("Chưa hoàn tất thao tác. Vui lòng quay lại kiểm tra kết quả trước khi thử lại."); }
    finally { running.current = false; setActing(false); }
  }

  return <dialog ref={dialog} className="modal-card warehouse-opening-dialog warehouse-action-confirmation"
    aria-labelledby={id} aria-describedby={`${id}-summary`}
    onCancel={(event) => { event.preventDefault(); cancelConfirmation(); }}
    onClose={() => { if (open) cancelConfirmation(); }}>
    <div className="modal-heading">
      <h2 id={id}>{title}</h2>
      <button aria-label="Đóng xác nhận" className="modal-close" type="button" disabled={blocked} onClick={cancelConfirmation}>×</button>
    </div>
    <div id={`${id}-summary`}>{children}</div>
    {disabled && !blocked ? <p className="alert alert-error" role="alert">Danh sách không còn đủ điều kiện. Vui lòng quay lại kiểm tra.</p> : null}
    {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
    <div className="modal-actions">
      <button ref={cancel} className="button button-secondary" type="button" disabled={blocked} onClick={cancelConfirmation}>Quay lại</button>
      <button className="button button-primary" type="button" disabled={disabled || blocked} onClick={() => { void confirm(); }}>
        {blocked ? "Đang xử lý…" : confirmLabel}
      </button>
    </div>
  </dialog>;
}
