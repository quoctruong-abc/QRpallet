"use client";

import { useEffect, useRef, useState } from "react";

export type WarehousePosition = {
  code: string;
  name: string;
};

type Props = {
  selectedPosition: WarehousePosition | null;
  onSelect: (position: WarehousePosition) => void;
  onInteractionChange: (active: boolean) => void;
};

export function ScanPositionPicker({ selectedPosition, onSelect, onInteractionChange }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState(selectedPosition?.code ?? "");
  const [positions, setPositions] = useState<WarehousePosition[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    if (!expanded) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setLoading(true);
      setSearchError("");
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/scan-qr/positions?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error ?? "Không thể tải danh sách vị trí.");
        }
        setPositions(result.positions as WarehousePosition[]);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setPositions([]);
        setSearchError(fetchError instanceof Error ? fetchError.message : "Không thể tải danh sách vị trí.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [expanded, query]);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setExpanded(false);
      onInteractionChange(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expanded, onInteractionChange]);

  function selectPosition(position: WarehousePosition) {
    setQuery(position.code);
    setExpanded(false);
    onInteractionChange(false);
    onSelect(position);
  }

  return (
    <div ref={rootRef} className={`camera-position-picker ${selectedPosition ? "camera-position-picker-ready" : ""}`}>
      <div className="camera-position-current">
        <span>Vị trí đang quét</span>
        <strong>{selectedPosition ? selectedPosition.code : "Chưa chọn vị trí"}</strong>
        {selectedPosition ? <small>{selectedPosition.name}</small> : <small>Chọn vị trí trước khi đưa QR vào khung</small>}
      </div>

      <div className="camera-position-search">
        <input
          aria-autocomplete="list"
          aria-controls="camera-position-results"
          aria-expanded={expanded}
          aria-label="Tìm vị trí kho"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setExpanded(true);
            onInteractionChange(true);
          }}
          onFocus={() => {
            setExpanded(true);
            onInteractionChange(true);
          }}
          placeholder="Tìm mã hoặc tên vị trí"
          role="combobox"
          type="search"
          value={query}
        />
        {expanded ? (
          <div className="camera-position-results" id="camera-position-results" role="listbox" aria-label="Danh sách vị trí">
            {loading ? <div className="camera-position-state">Đang tìm vị trí...</div> : null}
            {!loading && searchError ? <div className="camera-position-state camera-position-state-error">{searchError}</div> : null}
            {!loading && !searchError && !positions.length ? <div className="camera-position-state">Không tìm thấy vị trí phù hợp.</div> : null}
            {!loading && !searchError ? positions.map((position) => (
              <button
                aria-selected={selectedPosition?.code === position.code}
                className={selectedPosition?.code === position.code ? "camera-position-result-selected" : ""}
                key={position.code}
                onClick={() => selectPosition(position)}
                role="option"
                type="button"
              >
                <strong>{position.code}</strong>
                <span>{position.name}</span>
              </button>
            )) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
