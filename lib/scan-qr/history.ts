export type LiveScanState = "loading" | "success" | "error" | "duplicate" | "unknown";

export type LiveScanItem = {
  scanKey: string;
  palletId: string;
  scannedAt: string;
  state: LiveScanState;
  message: string;
  palletStatus?: string;
  wo?: string;
  quantity?: number;
  itemcode?: string;
};

export function scanHistoryStorageKey(userId: string) {
  return `scan-qr-history-v1:${userId}`;
}

export function serializeScanHistory(items: LiveScanItem[]) {
  return JSON.stringify({ version: 1, items });
}

export function restoreScanHistory(serialized: string | null): LiveScanItem[] {
  if (!serialized) return [];
  try {
    const stored = JSON.parse(serialized);
    if (stored?.version !== 1 || !Array.isArray(stored.items)) return [];
    const items: LiveScanItem[] = [];
    const keys = new Set<string>();
    const states: LiveScanState[] = ["loading", "success", "error", "duplicate", "unknown"];
    for (const entry of stored.items) {
      if (!entry || typeof entry !== "object"
        || typeof entry.scanKey !== "string" || !entry.scanKey || keys.has(entry.scanKey)
        || typeof entry.palletId !== "string" || !entry.palletId
        || typeof entry.scannedAt !== "string" || !Number.isFinite(Date.parse(entry.scannedAt))
        || !states.includes(entry.state) || typeof entry.message !== "string") continue;
      keys.add(entry.scanKey);
      const interrupted = entry.state === "loading";
      const item: LiveScanItem = {
        scanKey: entry.scanKey,
        palletId: entry.palletId,
        scannedAt: entry.scannedAt,
        state: interrupted ? "unknown" : entry.state,
        message: interrupted ? "Chưa xác định" : entry.message,
      };
      for (const field of ["palletStatus", "wo", "itemcode"] as const) {
        if (typeof entry[field] === "string") item[field] = entry[field];
      }
      if (typeof entry.quantity === "number" && Number.isFinite(entry.quantity)) item.quantity = entry.quantity;
      if (interrupted) item.palletStatus = "Chưa xác nhận";
      items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}
