"use client";

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";

export type WarehousePosition = {
  code: string;
  name: string;
};

type Props = {
  palletId: string;
  defaultPosition: WarehousePosition | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (position: WarehousePosition) => void;
};

export function ScanPositionDialog({
  palletId,
  defaultPosition,
  saving,
  error,
  onClose,
  onSave,
}: Props) {
  const [query, setQuery] = useState(defaultPosition?.code ?? "");
  const [positions, setPositions] = useState<WarehousePosition[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<WarehousePosition | null>(defaultPosition);
  const [loading, setLoading] = useState(true);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
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

        const nextPositions = result.positions as WarehousePosition[];
        setPositions(nextPositions);
        const exactPosition = nextPositions.find(
          (position) => position.code.toLocaleLowerCase("vi") === query.trim().toLocaleLowerCase("vi"),
        );
        if (exactPosition) setSelectedPosition(exactPosition);
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
  }, [query]);

  function selectPosition(position: WarehousePosition) {
    setSelectedPosition(position);
    setQuery(position.code);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && !saving) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && selectedPosition && !saving) {
      event.preventDefault();
      onSave(selectedPosition);
    }
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !saving) onClose();
  }

  return (
    <div className="modal-backdrop scan-position-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div className="modal-card scan-position-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">VỊ TRÍ PALLET</p>
            <h2>{palletId}</h2>
          </div>
          <button className="modal-close" disabled={saving} onClick={onClose} type="button">×</button>
        </div>

        <p className="muted scan-position-help">
          Chọn vị trí trong danh mục. Có thể bấm ra ngoài để bỏ qua và tiếp tục scan.
        </p>

        <label className="scan-position-search">
          <span>Tìm vị trí</span>
          <input
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedPosition(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Nhập mã hoặc tên vị trí"
            type="search"
          />
        </label>

        <div className="scan-position-options" role="listbox" aria-label="Danh sách vị trí">
          {loading ? <div className="scan-position-state">Đang tìm vị trí...</div> : null}
          {!loading && searchError ? <div className="scan-position-state scan-position-state-error">{searchError}</div> : null}
          {!loading && !searchError && !positions.length ? <div className="scan-position-state">Không tìm thấy vị trí phù hợp.</div> : null}
          {!loading && !searchError ? positions.map((position) => {
            const selected = selectedPosition?.code === position.code;
            return (
              <button
                aria-selected={selected}
                className={`scan-position-option ${selected ? "scan-position-option-selected" : ""}`}
                key={position.code}
                onClick={() => selectPosition(position)}
                role="option"
                type="button"
              >
                <strong>{position.code}</strong>
                <span>{position.name}</span>
                {selected ? <small>Đã chọn</small> : null}
              </button>
            );
          }) : null}
        </div>

        {defaultPosition ? (
          <p className="scan-position-default">Mặc định phiên hiện tại: <strong>{defaultPosition.code}</strong></p>
        ) : null}
        {error ? <p className="alert alert-error">{error}</p> : null}

        <div className="modal-actions">
          <button className="button button-secondary" disabled={saving} onClick={onClose} type="button">Bỏ qua</button>
          <button
            className="button button-primary"
            disabled={!selectedPosition || saving}
            onClick={() => selectedPosition && onSave(selectedPosition)}
            type="button"
          >
            {saving ? "Đang lưu..." : "Lưu vị trí"}
          </button>
        </div>
      </div>
    </div>
  );
}
