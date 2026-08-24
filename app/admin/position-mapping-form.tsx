"use client";

import { useActionState } from "react";
import {
  updatePositionPageAccess,
  type PositionMappingActionState,
} from "@/app/superadmin/actions";
import type { Position } from "@/lib/types";

const initialState: PositionMappingActionState = { error: "", success: "" };

type MappingPage = {
  path: string;
  label: string;
};

type MappingPosition = {
  position: Position;
  label: string;
  enabledPaths: string[];
};

export function PositionMappingForm({
  pages,
  positions,
}: {
  pages: MappingPage[];
  positions: MappingPosition[];
}) {
  const [state, formAction, pending] = useActionState(
    updatePositionPageAccess,
    initialState,
  );

  return (
    <form action={formAction} className="admin-mapping-form">
      <div className="table-wrap admin-table-wrap">
        <table className="admin-mapping-table">
          <thead>
            <tr>
              <th>Position</th>
              {pages.map((page) => <th key={page.path}>{page.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.position}>
                <td data-label="Position" className="admin-mapping-position"><strong>{position.label}</strong></td>
                {pages.map((page) => (
                  <td data-label={page.label} key={page.path} className="admin-permission-cell">
                    <input
                      aria-label={`${position.label} - ${page.label}`}
                      className="admin-checkbox"
                      defaultChecked={position.enabledPaths.includes(page.path)}
                      disabled={pending}
                      name={`position:${position.position}`}
                      type="checkbox"
                      value={page.path}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div aria-live="polite" className="admin-form-actions">
        {pending ? <p className="alert">Đang lưu position mapping...</p> : null}
        {!pending && state.error ? <p className="alert alert-error">{state.error}</p> : null}
        {!pending && state.success ? <p className="alert alert-success">{state.success}</p> : null}
        <button className="button button-primary" disabled={pending} type="submit">
          {pending ? "Đang lưu..." : "Lưu position mapping"}
        </button>
      </div>
    </form>
  );
}
