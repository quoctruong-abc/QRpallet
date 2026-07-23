"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { AppRole, Position } from "@/lib/types";
import { createEmployee, type AdminActionState } from "./actions";

const initialState: AdminActionState = { error: "", success: "" };

export function CreateUserForm({
  actorRole,
  actorPosition,
}: {
  actorRole: AppRole;
  actorPosition: Position | null;
}) {
  const [state, formAction, pending] = useActionState(createEmployee, initialState);
  const [role, setRole] = useState<AppRole>("user");
  const formRef = useRef<HTMLFormElement | null>(null);
  const isSuperadmin = actorRole === "superadmin";

  useEffect(() => {
    if (!state.success) return;
    formRef.current?.reset();
    setRole("user");
  }, [state.success]);

  return (
    <form action={formAction} className="form-grid" ref={formRef}>
      <label>
        Họ và tên
        <input disabled={pending} name="full_name" required placeholder="Nguyễn Văn A" />
      </label>
      <label>
        Mã nhân viên
        <input disabled={pending} name="employee_code" placeholder="SVN001" />
      </label>
      <label>
        Tên đăng nhập
        <input
          disabled={pending}
          name="username"
          required
          minLength={3}
          maxLength={32}
          pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
          title="3-32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang."
          placeholder="svn001"
        />
      </label>
      <label>
        Mật khẩu tạm
        <input disabled={pending} name="password" required type="password" minLength={8} placeholder="Tối thiểu 8 ký tự" />
      </label>
      <label>
        Role
        <select
          disabled={pending || !isSuperadmin}
          name="role"
          value={isSuperadmin ? role : "user"}
          onChange={(event) => setRole(event.target.value as AppRole)}
        >
          <option value="user">User</option>
          {isSuperadmin ? <option value="admin">Admin</option> : null}
          {isSuperadmin ? <option value="superadmin">Superadmin</option> : null}
        </select>
        {!isSuperadmin ? <input type="hidden" name="role" value="user" /> : null}
      </label>
      <label>
        Position
        {isSuperadmin ? (
          <select name="position" disabled={pending || role === "superadmin"} required={role !== "superadmin"} defaultValue="warehouse">
            <option value="planning">Planning</option>
            <option value="production">Production</option>
            <option value="warehouse">Warehouse</option>
          </select>
        ) : (
          <>
            <input value={actorPosition ?? ""} disabled />
            <input type="hidden" name="position" value={actorPosition ?? ""} />
          </>
        )}
      </label>

      <div className="form-full" aria-live="polite">
        <p className="muted small">Tài khoản user mới mặc định chưa có permission nào.</p>
        {pending ? <p className="alert">Đang tạo tài khoản, vui lòng không đóng trang...</p> : null}
        {!pending && state.error ? <p className="alert alert-error">{state.error}</p> : null}
        {!pending && state.success ? <p className="alert alert-success">{state.success}</p> : null}
        <button className="button button-primary" disabled={pending} type="submit">
          {pending ? "Đang tạo tài khoản..." : "Tạo tài khoản"}
        </button>
      </div>
    </form>
  );
}
