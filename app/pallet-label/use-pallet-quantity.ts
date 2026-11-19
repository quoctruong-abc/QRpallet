"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { palletQuantity } from "@/lib/pallet-label/quantity";

type QuantityState = { status: "idle" | "loading" | "ready" | "error"; itemcode: string; quantity: number | null; error: string };
const empty: QuantityState = { status: "idle", itemcode: "", quantity: null, error: "" };

export function usePalletQuantity() {
  const [state, setState] = useState<QuantityState>(empty);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const clear = useCallback(() => { request.current?.abort(); setState(empty); }, []);
  const load = useCallback(async (value: string) => {
    const itemcode = value.trim();
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setState({ status: "loading", itemcode, quantity: null, error: "" });
    try {
      const response = await fetch(`/api/pallet-label/quantity?${new URLSearchParams({ itemcode })}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || !result.success || result.itemcode !== itemcode) throw new Error(result.error ?? "Chưa tải được số lượng pallet chẵn. Vui lòng thử lại.");
      setState({ status: "ready", itemcode, quantity: palletQuantity(result.quantity_per_pallet), error: "" });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error", itemcode, quantity: null, error: error instanceof Error ? error.message : "Chưa tải được số lượng pallet chẵn." });
    }
  }, []);
  return { ...state, load, clear };
}
