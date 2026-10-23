"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "pallet-label:machine-wo-selection:v1";
const CHANGE_EVENT = "pallet-label:machine-wo-selection-change";
let memorySnapshot = "";
let useMemorySnapshot = false;

type Selection = { machine: string | null; wos: Record<string, string> };
type PlanRow = { machine: string; wo: string };

function getSnapshot() {
  if (useMemorySnapshot) return memorySnapshot;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return memorySnapshot;
  }
}

function getServerSnapshot() {
  return null;
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function saveSelection(selection: Selection) {
  memorySnapshot = JSON.stringify(selection);
  try {
    window.localStorage.setItem(STORAGE_KEY, memorySnapshot);
  } catch {
    // Keep the current selection usable when browser storage is unavailable.
    useMemorySnapshot = true;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function readSelection(snapshot: string | null, rows: PlanRow[]): Selection {
  const empty: Selection = { machine: null, wos: {} };
  if (!snapshot) return empty;
  try {
    const stored: unknown = JSON.parse(snapshot);
    if (!stored || typeof stored !== "object") return empty;
    const { machine, wos } = stored as { machine?: unknown; wos?: unknown };
    const validPairs = new Set(rows.map((row) => JSON.stringify([row.machine, row.wo])));
    return {
      machine: typeof machine === "string" && rows.some((row) => row.machine === machine) ? machine : null,
      wos: wos && typeof wos === "object" && !Array.isArray(wos)
        ? Object.fromEntries(Object.entries(wos).filter(([key, wo]) =>
          typeof wo === "string" && validPairs.has(JSON.stringify([key, wo]))))
        : {},
    };
  } catch {
    return empty;
  }
}

export function useMachineWoSelection(rows: PlanRow[]) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const selection = useMemo(() => readSelection(snapshot, rows), [snapshot, rows]);

  useEffect(() => {
    // Reconcile only after hydration, so SSR cannot overwrite saved choices.
    if (snapshot !== null && snapshot !== JSON.stringify(selection)) {
      saveSelection(selection);
    }
  }, [snapshot, selection]);

  function selectMachine(machine: string | null) {
    saveSelection({ ...readSelection(getSnapshot(), rows), machine });
  }

  function selectWo(machine: string, wo: string) {
    const current = readSelection(getSnapshot(), rows);
    saveSelection({ ...current, wos: { ...current.wos, [machine]: wo } });
  }

  return { selectedMachine: selection.machine, selectedWos: selection.wos, selectMachine, selectWo };
}
