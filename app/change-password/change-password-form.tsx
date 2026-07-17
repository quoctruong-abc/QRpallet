"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "./actions";

const initialState: ChangePasswordState = { error: "", success: "" };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePassword, initialState);

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

      <button className="button button-primary" disabled={pending} type="submit">
        {pending ? "Đang cập nhật..." : "Đổi mật khẩu"}
      </button>
    </form>
  );
}
