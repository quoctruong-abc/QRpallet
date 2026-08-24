"use client";

import { useState, type MouseEvent } from "react";

type ProgressMode = "wo" | "item";

type ProgressData = {
  mode: ProgressMode;
  key: string;
  orderQuantity: number;
  palletCount: number;
  producedQuantity: number;
  scannedQuantity: number;
  warehouseQuantity: number;
};

type Props = {
  palletId: string;
  wo: string | null;
  itemcode: string | null;
  period: "day" | "range" | "all";
  day: string;
  from: string;
  to: string;
};

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function ProgressMetric({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  const width = Math.min(Math.max(percent, 0), 100);

  return (
    <div className="fifo-progress-metric">
      <span className="muted small">{label}</span>
      <strong>{formatNumber(value)}</strong>
      <span className="muted small">/ {total > 0 ? formatNumber(total) : "—"} · {total > 0 ? `${percent}%` : "Chưa có order"}</span>
      <div className="fifo-progress-track"><span style={{ width: `${width}%` }} /></div>
    </div>
  );
}

export function FifoProgressButton({ palletId, wo, itemcode, period, day, from, to }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ProgressMode | null>(null);
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadProgress(nextMode: ProgressMode) {
    const key = nextMode === "wo" ? wo?.trim() : itemcode?.trim();
    if (!key) return;

    setMode(nextMode);
    setData(null);
    setError("");
    setLoading(true);

    try {
      const params = new URLSearchParams({ mode: nextMode, key, period });
      if (period === "day") {
        params.set("from", day);
        params.set("to", day);
      } else if (period === "range") {
        params.set("from", from);
        params.set("to", to);
      }

      const response = await fetch(`/api/production-dashboard/progress?${params.toString()}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể tải tiến độ.");
      }
      setData(result.progress as ProgressData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không thể tải tiến độ.");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    setOpen(false);
    setMode(null);
    setData(null);
    setError("");
    setLoading(false);
  }

  return (
    <>
      <button className="button button-secondary button-small fifo-progress-button" onClick={() => setOpen(true)} type="button">
        Xem tiến độ
      </button>

      {open ? (
        <div className="modal-backdrop fifo-progress-backdrop" onMouseDown={close}>
          <div
            aria-modal="true"
            className="modal-card fifo-progress-modal"
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">TIẾN ĐỘ PALLET</p>
                <h2>{palletId}</h2>
              </div>
              <button className="modal-close" onClick={close} type="button">×</button>
            </div>

            <p className="muted">Chọn cách kiểm tra tiến độ tương tự Dashboard.</p>

            <div className="fifo-progress-mode-row">
              <button
                className={`button ${mode === "wo" ? "button-primary" : "button-secondary"}`}
                disabled={!wo}
                onClick={() => loadProgress("wo")}
                type="button"
              >
                Theo WO{wo ? ` · ${wo}` : ""}
              </button>
              <button
                className={`button ${mode === "item" ? "button-primary" : "button-secondary"}`}
                disabled={!itemcode}
                onClick={() => loadProgress("item")}
                type="button"
              >
                Theo Item{itemcode ? ` · ${itemcode}` : ""}
              </button>
            </div>

            {loading ? <p className="alert alert-success">Đang kiểm tra tiến độ...</p> : null}
            {error ? <p className="alert alert-error">{error}</p> : null}

            {data ? (
              <div className="fifo-progress-result">
                <div className="fifo-progress-heading">
                  <div>
                    <span className="muted small">{data.mode === "wo" ? "WO" : "ITEM"}</span>
                    <strong>{data.key}</strong>
                  </div>
                  <span className="fifo-progress-pallet-count">{formatNumber(data.palletCount)} pallet</span>
                </div>

                <div className="fifo-progress-order-card">
                  <span className="muted small">Quan order</span>
                  <strong>{formatNumber(data.orderQuantity)}</strong>
                </div>

                <div className="fifo-progress-grid">
                  <ProgressMetric label="Đã sản xuất" total={data.orderQuantity} value={data.producedQuantity} />
                  <ProgressMetric label="Đã scan" total={data.orderQuantity} value={data.scannedQuantity} />
                  <ProgressMetric label="Đã nhập kho" total={data.orderQuantity} value={data.warehouseQuantity} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <style>{`
        .fifo-progress-button { white-space: nowrap; }
        .fifo-progress-backdrop { z-index: 1200; }
        .fifo-progress-modal { width: min(720px, calc(100% - 24px)); max-height: 88vh; overflow: auto; }
        .fifo-progress-mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0; }
        .fifo-progress-result { display: grid; gap: 14px; margin-top: 16px; }
        .fifo-progress-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
        .fifo-progress-heading strong { display: block; font-size: 1.05rem; }
        .fifo-progress-pallet-count { padding: 6px 10px; border-radius: 999px; background: #eff8ff; color: #175cd3; font-weight: 850; }
        .fifo-progress-order-card { display: grid; gap: 3px; padding: 14px; border: 1px solid var(--border); border-radius: 14px; background: #f8fafc; }
        .fifo-progress-order-card strong { font-size: 1.4rem; }
        .fifo-progress-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        .fifo-progress-metric { display: grid; gap: 5px; padding: 13px; border: 1px solid var(--border); border-radius: 14px; background: white; }
        .fifo-progress-metric strong { font-size: 1.2rem; }
        .fifo-progress-track { height: 7px; overflow: hidden; border-radius: 999px; background: #eaecf0; }
        .fifo-progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
        @media (max-width: 640px) {
          .fifo-progress-mode-row, .fifo-progress-grid { grid-template-columns: 1fr; }
          .fifo-progress-heading { align-items: flex-start; flex-direction: column; }
        }
      `}</style>
    </>
  );
}
