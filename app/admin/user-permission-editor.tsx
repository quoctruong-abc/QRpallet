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
        <td key={permission.key}>
          <input
            aria-label={`${username} - ${permission.label}`}
            checked={permission.roleGranted || selected.includes(permission.key)}
            disabled={pending || permission.roleGranted}
            onChange={(event) => togglePermission(permission.key, event.target.checked)}
            readOnly={permission.roleGranted}
            type="checkbox"
          />
        </td>
      ))}
      <td>
        <form action={formAction} style={{ minWidth: "170px" }}>
          <input name="user_id" type="hidden" value={userId} />
          {selected.map((permission) => (
            <input key={permission} name="permissions" type="hidden" value={permission} />
          ))}
          <button className="button button-small button-primary" disabled={pending} type="submit">
            {pending ? "Đang lưu..." : "Lưu"}
          </button>
          <div aria-live="polite" style={{ marginTop: "0.45rem" }}>
            {pending ? <span className="muted small">Đang xử lý...</span> : null}
            {!pending && state.error ? <span className="alert alert-error small">{state.error}</span> : null}
            {!pending && state.success ? <span className="alert alert-success small">{state.success}</span> : null}
          </div>
        </form>
      </td>
    </Fragment>
  );
}
