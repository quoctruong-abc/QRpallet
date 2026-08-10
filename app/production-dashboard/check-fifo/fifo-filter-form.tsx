"use client";

import { FormEvent, useState } from "react";

type PeriodMode = "day" | "range" | "all";

type Props = {
  period: PeriodMode;
  day: string;
  from: string;
  to: string;
  includeProduction: boolean;
  includeScan: boolean;
  pageSize: number;
};

export function FifoFilterForm({
  period,
  day,
  from,
  to,
  includeProduction,
  includeScan,
  pageSize,
}: Props) {
  const [productionChecked, setProductionChecked] = useState(includeProduction);
  const [scanChecked, setScanChecked] = useState(includeScan);
  const hasProcess = productionChecked || scanChecked;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!hasProcess) event.preventDefault();
  }

  return (
    <form
      action="/production-dashboard/check-fifo"
      className="panel fifo-filter-panel"
      method="get"
      onSubmit={handleSubmit}
    >
      <input name="filter_applied" type="hidden" value="1" />
      <div>
        <p className="eyebrow">THỜI GIAN</p>
        <div className="fifo-period-options">
          <label className="fifo-period-option">
            <span><input defaultChecked={period === "day"} name="period" type="radio" value="day" /> Theo ngày</span>
            <input defaultValue={day} name="day" type="date" />
          </label>

          <label className="fifo-period-option">
            <span><input defaultChecked={period === "range"} name="period" type="radio" value="range" /> Khoảng ngày</span>
            <div className="fifo-range-inputs">
              <input aria-label="Từ ngày" defaultValue={from} name="from" type="date" />
              <input aria-label="Đến ngày" defaultValue={to} name="to" type="date" />
            </div>
          </label>

          <label className="fifo-period-option">
            <span><input defaultChecked={period === "all"} name="period" type="radio" value="all" /> Tất cả</span>
            <small className="muted">Không giới hạn ngày; tải tối đa {pageSize} pallet mỗi trang.</small>
          </label>
        </div>
      </div>

      <div>
        <p className="eyebrow">PROCESS ĐANG CHỜ</p>
        <div className="fifo-stage-row">
          <label className="fifo-stage-option">
            <input
              checked={productionChecked}
              name="stage"
              onChange={(event) => setProductionChecked(event.target.checked)}
              type="checkbox"
              value="production"
            />
            Sản xuất
          </label>
          <label className="fifo-stage-option">
            <input
              checked={scanChecked}
              name="stage"
              onChange={(event) => setScanChecked(event.target.checked)}
              type="checkbox"
              value="scan"
            />
            Scan
          </label>
        </div>
        {!hasProcess ? (
          <p className="alert alert-error fifo-process-guard" role="alert">
            Chọn ít nhất một process: Sản xuất hoặc Scan.
          </p>
        ) : null}
      </div>

      <div className="fifo-filter-actions">
        <button className="button button-primary" disabled={!hasProcess} type="submit">
          Kiểm tra FIFO
        </button>
      </div>
    </form>
  );
}
