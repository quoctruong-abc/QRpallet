"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="form-stack">
      <label>
        Email
        <input
          autoComplete="email"
          autoFocus
          name="email"
          placeholder="nhanvien@congty.com"
          required
          type="email"
        />
      </label>

      <label>
        Mật khẩu
        <input
          autoComplete="current-password"
          minLength={6}
          name="password"
          placeholder="••••••••"
          required
          type="password"
        />
      </label>

      {state.error ? <p className="alert alert-error">{state.error}</p> : null}

      <button className="button button-primary full-width" disabled={pending} type="submit">
        {pending ? "Đang đăng nhập..." : "Đăng nhập"}
      </button>
    </form>
  );
}
