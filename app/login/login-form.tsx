"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="form-stack">
      <label>
        Tên đăng nhập
        <input
          autoComplete="username"
          autoFocus
          name="username"
          placeholder="svn001"
          required
          minLength={3}
          maxLength={32}
          pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
          title="3-32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang."
          type="text"
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
