"use client";

import { useActionState, useState } from "react";
import { createEmployee, type AdminActionState } from "./actions";

const initialState: AdminActionState = { error: "", success: "" };

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createEmployee, initialState);
  const [role, setRole] = useState("user");

  return (
    <form action={formAction} className="form-grid">
      <label>
        Họ và tên
        <input name="full_name" required placeholder="Nguyễn Văn A" />
      </label>
      <label>
        Mã nhân viên
        <input name="employee_code" placeholder="SVN001" />
      </label>
      <label>
        Email đăng nhập
        <input name="email" required type="email" placeholder="svn001@company.com" />
      </label>
      <label>
        Mật khẩu tạm
        <input name="password" required type="password" minLength={8} placeholder="Tối thiểu 8 ký tự" />
      </label>
      <label>
        Role
        <select name="role" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <label>
        Position
        <select name="position" disabled={role === "admin"} required={role !== "admin"} defaultValue="scanner">
          <option value="planning">Planning Inject</option>
          <option value="pallet">Xuất tem pallet</option>
          <option value="scanner">Scan QR</option>
          <option value="warehouse">Xử lý data tạm / Nhập kho</option>
        </select>
      </label>

      <div className="form-full">
        {state.error ? <p className="alert alert-error">{state.error}</p> : null}
        {state.success ? <p className="alert alert-success">{state.success}</p> : null}
        <button className="button button-primary" disabled={pending} type="submit">
          {pending ? "Đang tạo..." : "Tạo tài khoản"}
        </button>
      </div>
    </form>
  );
}
