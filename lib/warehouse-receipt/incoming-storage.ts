import { parseManualIncomingRequest } from "./incoming";

export const INCOMING_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
export const incomingStorageKey = (profileId: string) => `warehouse-incoming-v2:${profileId}`;

export type StoredIncoming = ReturnType<typeof parseManualIncomingRequest> & {
  status: "draft" | "pending";
  expiresAt: number;
  selected?: boolean[];
  remaining_rows?: StoredIncoming["rows"];
  action?: "post" | "propose";
};

export function parseStoredIncoming(raw: string): StoredIncoming {
  const value = JSON.parse(raw);
  if (!value || !["draft", "pending"].includes(value.status) || !Number.isSafeInteger(value.expiresAt)) {
    throw new Error("Invalid saved inventory");
  }
  const parsed = parseManualIncomingRequest(value);
  if (value.selected !== undefined && (!Array.isArray(value.selected) || value.selected.length !== parsed.rows.length || !value.selected.every((item: unknown) => typeof item === "boolean"))) throw new Error("Invalid saved selection");
  if (value.action !== undefined && !["post", "propose"].includes(value.action)) throw new Error("Invalid saved action");
  const remaining = value.remaining_rows === undefined ? undefined
    : parseManualIncomingRequest({ request_id: value.request_id, rows: value.remaining_rows }).rows;
  if (remaining && (value.status !== "pending" || remaining.length + parsed.rows.length > 500)) throw new Error("Invalid saved remainder");
  return { ...parsed, status: value.status, expiresAt: value.expiresAt,
    ...(value.selected === undefined ? {} : { selected: value.selected }),
    ...(remaining ? { remaining_rows: remaining } : {}),
    ...(value.action === undefined ? {} : { action: value.action }) };
}

export function incomingStoredRows(saved: StoredIncoming) {
  return saved.rows.map((row, index) => ({ ...row, selected: saved.status === "pending" || saved.selected?.[index] !== false }))
    .concat((saved.remaining_rows ?? []).map((row) => ({ ...row, selected: false })));
}

export function startIncomingSubmission(saved: StoredIncoming, action: "post" | "propose", now = Date.now()): StoredIncoming {
  if (saved.status === "pending") return saved;
  const selected = saved.rows.filter((row, index) => saved.selected?.[index] !== false);
  const remaining = saved.rows.filter((row, index) => saved.selected?.[index] === false);
  if (!selected.length) throw new Error("Hãy chọn ít nhất một dòng nhập kho.");
  return { request_id: saved.request_id, rows: selected, status: "pending", action, expiresAt: now + INCOMING_DRAFT_TTL,
    ...(remaining.length ? { remaining_rows: remaining } : {}) };
}

export function completeIncomingSubmission(saved: StoredIncoming, requestId: string, now = Date.now()): StoredIncoming | null {
  const rows = saved.remaining_rows ?? [];
  return rows.length ? { request_id: requestId, rows, selected: rows.map(() => false), status: "draft", expiresAt: now + INCOMING_DRAFT_TTL } : null;
}
