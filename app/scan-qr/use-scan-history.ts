"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { restoreScanHistory, scanHistoryStorageKey, serializeScanHistory, type LiveScanItem } from "@/lib/scan-qr/history";

export function useScanHistory(userId: string) {
  const storageKey = scanHistoryStorageKey(userId);
  const cache = useRef<{ key: string; loaded: boolean; items: LiveScanItem[] }>({ key: storageKey, loaded: false, items: [] });
  const [liveScans, setLiveScans] = useState<LiveScanItem[]>([]);
  const [storageError, setStorageError] = useState(false);

  const loadHistory = useCallback(() => {
    if (cache.current.key === storageKey && cache.current.loaded) return cache.current.items;
    let items: LiveScanItem[] = [];
    try {
      items = restoreScanHistory(window.localStorage.getItem(storageKey));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    cache.current = { key: storageKey, loaded: true, items };
    return items;
  }, [storageKey]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setLiveScans(loadHistory()), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadHistory]);

  const updateLiveScans = useCallback((update: (current: LiveScanItem[]) => LiveScanItem[]) => {
    const items = update(loadHistory());
    cache.current = { key: storageKey, loaded: true, items };
    // Write during the scan/action itself, without waiting for a React effect.
    // A phone can close or suspend the page immediately after the response.
    try {
      if (items.length) window.localStorage.setItem(storageKey, serializeScanHistory(items));
      else window.localStorage.removeItem(storageKey);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    setLiveScans(items);
  }, [loadHistory, storageKey]);

  return { liveScans, updateLiveScans, storageError };
}
