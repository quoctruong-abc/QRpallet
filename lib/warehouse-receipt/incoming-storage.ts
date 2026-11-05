import { parseManualIncomingRequest } from "./incoming";

export const INCOMING_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
export const incomingStorageKey = (profileId: string) => `warehouse-incoming-v2:${profileId}`;

export type StoredIncoming = ReturnType<typeof parseManualIncomingRequest> & {
  status: "draft" | "pending";
  expiresAt: number;
};

export function parseStoredIncoming(raw: string): StoredIncoming {
  const value = JSON.parse(raw);
  if (!value || !["draft", "pending"].includes(value.status) || !Number.isSafeInteger(value.expiresAt)) {
    throw new Error("Invalid saved inventory");
  }
  return { ...parseManualIncomingRequest(value), status: value.status, expiresAt: value.expiresAt };
}
