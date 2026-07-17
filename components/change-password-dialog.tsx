"use client";

import { useActionState, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { changePassword, type ChangePasswordState } from "@/app/change-password/actions";

const initialState: ChangePasswordState = { error: "", success: "" };

function PasswordForm({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(changePassword, initialState);

  useEffect(() => {
    if (!state.success) return;
    const timeout = window.setTimeout(onClose, 700);
    return () => window.clearTimeout(timeout);
  }, [state.success, onClose]);

  return (
    <form action={formAction} className="form-stack">
      <label>
        Mật khẩu mới
        <input
          autoComplete="new-password"
          minLength={8}
          name="password"
          placeholder="Tối thiểu 8 ký tự"
          required
          type="password"
        />
      </label>

      <label>
        Xác nhận mật khẩu mới
        <input
          autoComplete="new-password"
          minLength={8}
          name="confirm_password"
          placeholder="Nhập lại mật khẩu mới"
          required
          type="password"
        />
      </label>

      {state.error ? <p className="alert alert-error">{state.error}</p> : null}
      {state.success ? <p className="alert alert-success">{state.success}</p> : null}

      <div className="modal-actions">
        <button className="button button-secondary" disabled={pending} onClick={onClose} type="button">
          Hủy
        </button>
        <button className="button button-primary" disabled={pending || Boolean(state.success)} type="submit">
          {pending ? "Đang cập nhật..." : "Đổi mật khẩu"}
        </button>
      </div>
    </form>
  );
}

export function ChangePasswordDialog() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  function closeDialog() {
    setOpen(false);
    setFormKey((current) => current + 1);
  }

  const modal = open && mounted ? createPortal(
    <div
      onMouseDown={closeDialog}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        overflowY: "auto",
        background: "rgba(15, 23, 42, 0.58)",
      }}
    >
      <div
        className="modal-card"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(100%, 520px)",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
          margin: "auto",
        }}
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">ACCOUNT SECURITY</p>
            <h2>Đổi mật khẩu</h2>
          </div>
          <button aria-label="Đóng" className="modal-close" onClick={closeDialog} type="button">×</button>
        </div>
        <PasswordForm key={formKey} onClose={closeDialog} />
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button className="button button-secondary" onClick={() => setOpen(true)} type="button">
        Đổi mật khẩu
      </button>
      {modal}
    </>
  );
}
