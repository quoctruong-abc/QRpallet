"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { WoPalletHistoryDialog } from "@/app/pallet-label/wo-pallet-history-dialog";

type UploadMode = "standard" | "audit";

type AuditConflict = {
  key: string;
  reportDate: string;
  machine: string;
  itemcode: string;
  wo: string;
  oldOkGoods: number;
  newOkGoods: number;
  oldReportId: string;
  newReportId: string;
};

type UploadResult = {
  parsed: number;
  imported: number;
  updated: number;
  skipped: number;
  firstDate: string;
  lastDate: string;
  databaseLastDate?: string | null;
};

type AuditPreview = {
  parsed: number;
  missing: number;
  unchanged: number;
  conflicts: AuditConflict[];
  firstDate: string;
  lastDate: string;
};

type ComparisonRow = {
  wo: string;
  machine: string;
  itemcode: string;
  productName: string;
  orderQuantity: number;
  appQuantity: number;
  erpQuantity: number;
  totalAppQuantity: number;
  totalErpQuantity: number;
  difference: number;
  itemcodeMatches: boolean;
  quantityMatches: boolean;
  result: string;
  status: "matched" | "mismatch";
};

type ComparisonSummary = {
  total: number;
  matched: number;
  mismatched: number;
};

type WoDailyHistoryRow = {
  date: string;
  appQuantity: number;
  palletCount: number;
  erpQuantity: number;
  difference: number;
  warning: boolean;
};

type WoDailyHistoryTotal = {
  appQuantity: number;
  palletCount: number;
  erpQuantity: number;
  difference: number;
};

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Chưa có dữ liệu";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function getCurrentWorkingDay() {
  const shifted = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M2.8 12s3.3-6 9.2-6 9.2 6 9.2 6-3.3 6-9.2 6-9.2-6-9.2-6Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function ShiftReportReviewClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>("standard");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [auditPreview, setAuditPreview] = useState<AuditPreview | null>(null);
  const [auditDecisions, setAuditDecisions] = useState<Record<string, boolean>>({});
  const [selectedDate, setSelectedDate] = useState(getCurrentWorkingDay);
  const [comparedDate, setComparedDate] = useState("");
  const [comparisonRows, setComparisonRows] = useState<ComparisonRow[]>([]);
  const [comparisonSummary, setComparisonSummary] = useState<ComparisonSummary>({ total: 0, matched: 0, mismatched: 0 });
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const [historyWo, setHistoryWo] = useState("");
  const [woHistoryRows, setWoHistoryRows] = useState<WoDailyHistoryRow[]>([]);
  const [woHistoryTotal, setWoHistoryTotal] = useState<WoDailyHistoryTotal | null>(null);
  const [woHistoryLoading, setWoHistoryLoading] = useState(false);
  const [woHistoryError, setWoHistoryError] = useState("");
  const [selectedPalletDay, setSelectedPalletDay] = useState<{ wo: string; date: string } | null>(null);

  async function loadComparison(date: string) {
    setComparisonLoading(true);
    setComparisonError("");
    try {
      const response = await fetch(`/api/production-dashboard/shift-report?date=${encodeURIComponent(date)}`, {
        cache: "no-store",
      });
      const responseBody = await response.json();
      if (!response.ok || !responseBody.success) {
        throw new Error(responseBody.error ?? "Không thể tải dữ liệu rà soát.");
      }
      setComparisonRows(responseBody.rows as ComparisonRow[]);
      setComparisonSummary(responseBody.summary as ComparisonSummary);
      setComparedDate(responseBody.reportDate as string);
    } catch (comparisonLoadError) {
      setComparisonRows([]);
      setComparisonSummary({ total: 0, matched: 0, mismatched: 0 });
      setComparedDate(date);
      setComparisonError(comparisonLoadError instanceof Error ? comparisonLoadError.message : "Không thể tải dữ liệu rà soát.");
    } finally {
      setComparisonLoading(false);
    }
  }

  async function openWoHistory(wo: string) {
    setHistoryWo(wo);
    setWoHistoryRows([]);
    setWoHistoryTotal(null);
    setWoHistoryError("");
    setWoHistoryLoading(true);
    setSelectedPalletDay(null);

    try {
      const response = await fetch(`/api/production-dashboard/shift-report?wo=${encodeURIComponent(wo)}`, {
        cache: "no-store",
      });
      const responseBody = await response.json();
      if (!response.ok || !responseBody.success) {
        throw new Error(responseBody.error ?? "Không thể tải chi tiết WO.");
      }
      setWoHistoryRows(responseBody.rows as WoDailyHistoryRow[]);
      setWoHistoryTotal(responseBody.total as WoDailyHistoryTotal);
    } catch (historyError) {
      setWoHistoryError(historyError instanceof Error ? historyError.message : "Không thể tải chi tiết WO.");
    } finally {
      setWoHistoryLoading(false);
    }
  }

  function closeWoHistory() {
    setHistoryWo("");
    setWoHistoryRows([]);
    setWoHistoryTotal(null);
    setWoHistoryError("");
    setSelectedPalletDay(null);
  }

  function selectMode(mode: UploadMode) {
    setUploadMode(mode);
    setSelectedFile(null);
    setError("");
    setResult(null);
    setAuditPreview(null);
    setAuditDecisions({});
    if (inputRef.current) inputRef.current.value = "";
  }

  async function sendFile(
    file: File,
    mode: UploadMode,
    phase: "preview" | "apply",
    confirmedKeys: string[] = [],
  ) {
    const formData = new FormData();
    formData.set("file", file);
    formData.set("mode", mode);
    formData.set("phase", phase);
    formData.set("confirmedKeys", JSON.stringify(confirmedKeys));
    const response = await fetch("/api/production-dashboard/shift-report", {
      method: "POST",
      body: formData,
    });
    const responseBody = await response.json();
    if (!response.ok || !responseBody.success) {
      throw new Error(responseBody.error ?? "Không thể upload báo ca.");
    }
    return responseBody;
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError("");
    setResult(null);
    setAuditPreview(null);
    setAuditDecisions({});
    if (!file) return;

    setUploading(true);
    try {
      if (uploadMode === "standard") {
        const responseBody = await sendFile(file, "standard", "apply");
        setResult(responseBody as UploadResult);
        return;
      }

      const responseBody = await sendFile(file, "audit", "preview") as AuditPreview;
      if (responseBody.conflicts.length) {
        setAuditPreview(responseBody);
        setAuditDecisions(Object.fromEntries(
          responseBody.conflicts.map((conflict) => [conflict.key, false]),
        ));
      } else {
        const applied = await sendFile(file, "audit", "apply");
        setResult(applied as UploadResult);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Không thể upload báo ca.");
    } finally {
      setUploading(false);
    }
  }

  async function applyAudit(confirmedKeys: string[]) {
    if (!selectedFile) return;
    setUploading(true);
    setError("");
    try {
      const responseBody = await sendFile(selectedFile, "audit", "apply", confirmedKeys);
      setResult(responseBody as UploadResult);
      setAuditPreview(null);
      setAuditDecisions({});
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Không thể cập nhật audit.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <section className="panel shift-upload-panel">
        <div className="section-heading shift-review-heading">
          <div>
            <p className="eyebrow">DỮ LIỆU ERP · BÁO CA</p>
            <h2>Nạp dữ liệu báo ca</h2>
            <p className="muted small">Chọn chế độ trước khi nạp file. Hệ thống chỉ đọc các cột A, B, C, D, E, F, I trong sheet upsever.</p>
          </div>
        </div>

        <div className="shift-upload-layout">
          <div className="shift-upload-modes" role="radiogroup" aria-label="Chế độ upload báo ca">
            <button
              aria-checked={uploadMode === "standard"}
              className={`shift-upload-mode ${uploadMode === "standard" ? "shift-upload-mode-active" : ""}`}
              onClick={() => selectMode("standard")}
              role="radio"
              type="button"
            >
              <span className="shift-upload-mode-dot" aria-hidden="true" />
              <span><strong>Up thường</strong><small>Nạp dữ liệu báo ca để so sánh với App</small></span>
            </button>
            <button
              aria-checked={uploadMode === "audit"}
              className={`shift-upload-mode ${uploadMode === "audit" ? "shift-upload-mode-active" : ""}`}
              onClick={() => selectMode("audit")}
              role="radio"
              type="button"
            >
              <span className="shift-upload-mode-dot" aria-hidden="true" />
              <span><strong>Up audit</strong><small>Nạp dữ liệu dùng cho lần rà soát audit</small></span>
            </button>
          </div>

          <div className="shift-upload-action">
            <input
              accept=".xlsx"
              className="shift-upload-input"
              onChange={handleFileChange}
              ref={inputRef}
              type="file"
            />
            <button className="button button-primary shift-upload-button" disabled={uploading} onClick={() => { if (inputRef.current) { inputRef.current.value = ""; inputRef.current.click(); } }} type="button">
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              </svg>
              {uploading ? "Đang xử lý..." : "Upload báo ca"}
            </button>
            <span className="muted small">File .xlsx · sheet upsever</span>
          </div>
        </div>

        {selectedFile ? (
          <div className="shift-selected-file">
            <div className="shift-file-icon" aria-hidden="true">XLS</div>
            <div>
              <strong>{selectedFile.name}</strong>
              <span>{formatFileSize(selectedFile.size)} · {uploadMode === "audit" ? "Up audit" : "Up thường"}</span>
            </div>
            <span className={`shift-file-pending ${result ? "shift-file-done" : error ? "shift-file-error" : ""}`}>{uploading ? "Đang xử lý" : result ? "Hoàn tất" : error ? "Có lỗi" : auditPreview ? "Chờ xác nhận" : "Đã chọn file"}</span>
          </div>
        ) : null}

        {error ? <p className="alert alert-error">{error}</p> : null}
        {result ? (
          <p className="alert alert-success">
            Đã xử lý {formatNumber(result.parsed)} dòng từ {formatDate(result.firstDate)} đến {formatDate(result.lastDate)}: thêm mới {formatNumber(result.imported)}, cập nhật audit {formatNumber(result.updated)}, bỏ qua {formatNumber(result.skipped)}.
            {uploadMode === "standard" ? ` Ngày cuối database trước khi upload: ${formatDate(result.databaseLastDate)}.` : ""}
          </p>
        ) : null}
      </section>

      <div className="shift-review-summary">
        <div className="stat-card"><span className="muted small">Dòng báo ca</span><span className="stat-number">{result ? formatNumber(result.parsed) : "—"}</span></div>
        <div className="stat-card"><span className="muted small">Đã thêm database</span><span className="stat-number">{result ? formatNumber(result.imported) : "—"}</span></div>
        <div className="stat-card"><span className="muted small">Đã cập nhật audit</span><span className="stat-number">{result ? formatNumber(result.updated) : "—"}</span></div>
      </div>

      <section className="panel shift-comparison-panel">
        <div className="section-heading shift-review-heading">
          <div>
            <p className="eyebrow">SO SÁNH APP / ERP</p>
            <h2>Rà soát dữ liệu báo ca</h2>
            <p className="muted small">Đối chiếu theo WO giữa số lượng pallet đã in và OK goods trong báo ca.</p>
          </div>
          <div className="shift-comparison-controls">
            <label className="shift-comparison-date">
              <span>Ngày sản xuất</span>
              <input
                aria-label="Ngày sản xuất cần rà soát"
                onChange={(event) => setSelectedDate(event.target.value)}
                type="date"
                value={selectedDate}
              />
            </label>
            <button className="button button-primary" disabled={comparisonLoading || !selectedDate} onClick={() => void loadComparison(selectedDate)} type="button">
              {comparisonLoading ? "Đang rà soát..." : "Rà soát"}
            </button>
          </div>
        </div>

        <div className="shift-comparison-summary">
          <span>Ngày rà soát: <strong>{formatDate(comparedDate || selectedDate)}</strong></span>
          <span>Tổng WO: <strong>{formatNumber(comparisonSummary.total)}</strong></span>
          <span className="shift-summary-matched">Khớp: <strong>{formatNumber(comparisonSummary.matched)}</strong></span>
          <span className="shift-summary-mismatch">Cần kiểm tra: <strong>{formatNumber(comparisonSummary.mismatched)}</strong></span>
        </div>

        {comparisonError ? <p className="alert alert-error">{comparisonError}</p> : null}

        <div className="table-wrap shift-comparison-table-wrap">
          <table className="shift-comparison-table">
            <thead>
              <tr>
                <th>Máy</th>
                <th>WO</th>
                <th>Itemcode</th>
                <th className="shift-product-name-column">Tên sản phẩm</th>
                <th className="shift-number-column">SL đơn hàng</th>
                <th className="shift-total-quantity-column">Tổng SL<br /><small>App/Báo ca</small></th>
                <th className="shift-number-column">App đã in</th>
                <th className="shift-number-column">ERP báo ca</th>
                <th className="shift-number-column">Chênh lệch<br /><small>App - ERP</small></th>
                <th>Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {comparisonLoading ? (
                <tr><td className="shift-comparison-empty" colSpan={10}>Đang tải dữ liệu rà soát...</td></tr>
              ) : comparisonRows.length ? comparisonRows.map((row) => (
                <tr className={row.status === "mismatch" ? "shift-comparison-row-mismatch" : ""} key={row.wo}>
                  <td>{row.machine || "—"}</td>
                  <td>
                    <span className="shift-wo-cell">
                      <strong>{row.wo}</strong>
                      <button
                        aria-label={`Xem chi tiết WO ${row.wo}`}
                        className="shift-eye-button"
                        onClick={() => void openWoHistory(row.wo)}
                        title="Xem chi tiết theo ngày"
                        type="button"
                      >
                        <EyeIcon />
                      </button>
                    </span>
                  </td>
                  <td>{row.itemcode || "—"}</td>
                  <td className="shift-product-name-column">{row.productName || "—"}</td>
                  <td className="number-cell shift-number-column">{formatNumber(row.orderQuantity)}</td>
                  <td className="number-cell shift-total-quantity-column"><strong>{formatNumber(row.totalAppQuantity)} / {formatNumber(row.totalErpQuantity)}</strong></td>
                  <td className="number-cell shift-number-column"><strong>{formatNumber(row.appQuantity)}</strong></td>
                  <td className="number-cell shift-number-column"><strong>{formatNumber(row.erpQuantity)}</strong></td>
                  <td className={`number-cell shift-number-column shift-difference ${row.difference === 0 ? "shift-difference-zero" : ""}`}>{row.difference > 0 ? "+" : ""}{formatNumber(row.difference)}</td>
                  <td><span className={`shift-result shift-result-${row.status}`}>{row.result}</span></td>
                </tr>
              )) : (
                <tr><td className="shift-comparison-empty" colSpan={10}>{comparedDate ? "Không có dữ liệu pallet hoặc báo ca trong ngày đã chọn." : "Chọn ngày sản xuất và nhấn Rà soát để tải dữ liệu."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {historyWo ? (
        <div className="modal-backdrop shift-wo-history-backdrop" onMouseDown={closeWoHistory}>
          <div className="modal-card shift-wo-history-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-heading">
              <div><p className="eyebrow">CHI TIẾT THEO NGÀY</p><h2>WO {historyWo}</h2></div>
              <button className="modal-close" onClick={closeWoHistory} type="button">×</button>
            </div>

            {woHistoryLoading ? <p className="alert alert-success">Đang tải chi tiết WO...</p> : null}
            {woHistoryError ? <p className="alert alert-error">{woHistoryError}</p> : null}

            {!woHistoryLoading && !woHistoryError ? (
              <div className="table-wrap">
                <table className="shift-wo-history-table">
                  <thead>
                    <tr><th>Ngày</th><th>SL App (Pallet)</th><th>SL báo ca</th><th>Số lượng lệch</th></tr>
                  </thead>
                  <tbody>
                    {woHistoryRows.length ? woHistoryRows.map((row) => (
                      <tr key={row.date}>
                        <td>
                          <span className="shift-history-date-cell">
                            <strong>{formatDate(row.date)}</strong>
                            <button
                              aria-label={`Xem pallet WO ${historyWo} ngày ${formatDate(row.date)}`}
                              className="shift-eye-button shift-date-eye-button"
                              onClick={() => setSelectedPalletDay({ wo: historyWo, date: row.date })}
                              title="Xem danh sách pallet của ngày"
                              type="button"
                            >
                              <EyeIcon />
                              {row.warning ? <span aria-hidden="true" className="shift-history-warning">!</span> : null}
                            </button>
                          </span>
                        </td>
                        <td className="number-cell"><strong>{formatNumber(row.appQuantity)}</strong> ({formatNumber(row.palletCount)} pallet)</td>
                        <td className="number-cell">{formatNumber(row.erpQuantity)}</td>
                        <td className={`number-cell shift-difference ${row.difference === 0 ? "shift-difference-zero" : ""}`}>{row.difference > 0 ? "+" : ""}{formatNumber(row.difference)}</td>
                      </tr>
                    )) : (
                      <tr><td className="shift-comparison-empty" colSpan={4}>Không có dữ liệu theo ngày của WO này.</td></tr>
                    )}
                    {woHistoryRows.length && woHistoryTotal ? (
                      <tr className="shift-wo-history-total">
                        <td>TOTAL</td>
                        <td className="number-cell">{formatNumber(woHistoryTotal.appQuantity)} ({formatNumber(woHistoryTotal.palletCount)} pallet)</td>
                        <td className="number-cell">{formatNumber(woHistoryTotal.erpQuantity)}</td>
                        <td className={`number-cell shift-difference ${woHistoryTotal.difference === 0 ? "shift-difference-zero" : ""}`}>{woHistoryTotal.difference > 0 ? "+" : ""}{formatNumber(woHistoryTotal.difference)}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {selectedPalletDay ? (
        <WoPalletHistoryDialog
          date={selectedPalletDay.date}
          key={`${selectedPalletDay.wo}-${selectedPalletDay.date}`}
          onClose={() => setSelectedPalletDay(null)}
          wo={selectedPalletDay.wo}
        />
      ) : null}

      {auditPreview ? (
        <div className="modal-backdrop shift-audit-backdrop" onMouseDown={() => { if (!uploading) setAuditPreview(null); }}>
          <div className="modal-card shift-audit-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-heading">
              <div><p className="eyebrow">AUDIT OK GOODS</p><h2>Xác nhận số lượng thay đổi</h2></div>
              <button className="modal-close" disabled={uploading} onClick={() => setAuditPreview(null)} type="button">×</button>
            </div>
            <p className="muted small">Tìm thấy {formatNumber(auditPreview.conflicts.length)} dòng có cùng Date + Machine + WO nhưng OK goods đã đổi. Chỉ các dòng được chọn mới ghi đè.</p>
            <div className="table-wrap">
              <table className="shift-audit-table">
                <thead><tr><th>Cập nhật</th><th>Date</th><th>Machine</th><th>WO</th><th>Itemcode</th><th>OK cũ</th><th>OK mới</th></tr></thead>
                <tbody>{auditPreview.conflicts.map((conflict) => (
                  <tr key={conflict.key}>
                    <td><input aria-label={`Cập nhật ${conflict.wo}`} checked={Boolean(auditDecisions[conflict.key])} onChange={(event) => setAuditDecisions((current) => ({ ...current, [conflict.key]: event.target.checked }))} type="checkbox" /></td>
                    <td>{formatDate(conflict.reportDate)}</td><td>{conflict.machine}</td><td><strong>{conflict.wo}</strong></td><td>{conflict.itemcode}</td><td>{formatNumber(conflict.oldOkGoods)}</td><td><strong>{formatNumber(conflict.newOkGoods)}</strong></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="muted small">Ngoài các dòng trên: {formatNumber(auditPreview.missing)} dòng mới sẽ được thêm; {formatNumber(auditPreview.unchanged)} dòng không đổi sẽ được bỏ qua.</p>
            <div className="modal-actions">
              <button className="button button-secondary" disabled={uploading} onClick={() => void applyAudit([])} type="button">Bỏ qua tất cả thay đổi</button>
              <button className="button button-primary" disabled={uploading} onClick={() => void applyAudit(Object.entries(auditDecisions).filter(([, accepted]) => accepted).map(([key]) => key))} type="button">{uploading ? "Đang cập nhật..." : "Cập nhật đã chọn"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
