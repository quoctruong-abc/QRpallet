"use client";

import { Fragment, useActionState, useState } from "react";
import {
  updateUserPermissions,
  type AdminActionState,
} from "./actions";
import type { PermissionKey } from "@/lib/types";

const initialState: AdminActionState = { error: "", success: "" };

type PermissionOption = {
  key: PermissionKey;
  label: string;
  roleGranted?: boolean;
};

export function UserPermissionEditor({
  userId,
  username,
  permissions,
  granted,
}: {
  userId: string;
  username: string;
  permissions: PermissionOption[];
  granted: PermissionKey[];
}) {
  const [state, formAction, pending] = useActionState(
    updateUserPermissions,
    initialState,
  );
  const [selected, setSelected] = useState<PermissionKey[]>(granted);

  function togglePermission(permission: PermissionKey, checked: boolean) {
    setSelected((current) => checked
      ? Array.from(new Set([...current, permission]))
      : current.filter((item) => item !== permission));
  }

  return (
    <Fragment>
      {permissions.map((permission) => (
        <td data-label={permission.label} key={permission.key} className="admin-permission-cell">
          <label className="admin-checkbox-label">
            <span className="admin-mobile-permission-label">{permission.label}</span>
            <input
              aria-label={`${username} - ${permission.label}`}
              className="admin-checkbox"
              checked={permission.roleGranted || selected.includes(permission.key)}
              disabled={pending || permission.roleGranted}
              onChange={(event) => togglePermission(permission.key, event.target.checked)}
              readOnly={permission.roleGranted}
              type="checkbox"
            />
            {permission.roleGranted ? <small>Theo role</small> : null}
          </label>
        </td>
      ))}
      <td data-label="Lưu quyền" className="admin-save-cell">
        <form action={formAction} className="admin-permission-save">
          <input name="user_id" type="hidden" value={userId} />
          {selected.map((permission) => (
            <input key={permission} name="permissions" type="hidden" value={permission} />
          ))}
          <button className="button button-small button-primary" disabled={pending} type="submit">
            {pending ? "Đang lưu..." : "Lưu quyền"}
          </button>
          <div aria-live="polite" className="admin-inline-feedback">
            {pending ? <span className="muted small">Đang xử lý...</span> : null}
            {!pending && state.error ? <span className="alert alert-error small">{state.error}</span> : null}
            {!pending && state.success ? <span className="alert alert-success small">{state.success}</span> : null}
          </div>
        </form>
      </td>
    </Fragment>
  );
}
