"use client";

import { useRef, useState, type ChangeEvent } from "react";

type UploadMode = "standard" | "audit";

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShiftReportReviewClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>("standard");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function selectMode(mode: UploadMode) {
    setUploadMode(mode);
    setSelectedFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFile(event.target.files?.[0] ?? null);
  }

  return (
    <>
      <section className="panel shift-upload-panel">
        <div className="section-heading shift-review-heading">
          <div>
            <p className="eyebrow">DỮ LIỆU ERP · BÁO CA</p>
            <h2>Nạp dữ liệu báo ca</h2>
            <p className="muted small">Chọn chế độ trước khi nạp file. Logic đọc file và ghi database sẽ được kết nối ở bước tiếp theo.</p>
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
              accept=".xlsx,.xls,.csv"
              className="shift-upload-input"
              onChange={handleFileChange}
              ref={inputRef}
              type="file"
            />
            <button className="button button-primary shift-upload-button" onClick={() => inputRef.current?.click()} type="button">
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              </svg>
              Upload báo ca
            </button>
            <span className="muted small">Hỗ trợ Excel và CSV</span>
          </div>
        </div>

        {selectedFile ? (
          <div className="shift-selected-file">
            <div className="shift-file-icon" aria-hidden="true">XLS</div>
            <div>
              <strong>{selectedFile.name}</strong>
              <span>{formatFileSize(selectedFile.size)} · {uploadMode === "audit" ? "Up audit" : "Up thường"}</span>
            </div>
            <span className="shift-file-pending">Chờ kết nối logic upload</span>
          </div>
        ) : null}
      </section>

      <div className="shift-review-summary">
        <div className="stat-card"><span className="muted small">Dòng báo ca</span><span className="stat-number">—</span></div>
        <div className="stat-card"><span className="muted small">Khớp dữ liệu App</span><span className="stat-number">—</span></div>
        <div className="stat-card"><span className="muted small">Có chênh lệch</span><span className="stat-number">—</span></div>
      </div>

      <section className="panel shift-comparison-panel">
        <div className="section-heading shift-review-heading">
          <div>
            <p className="eyebrow">SO SÁNH APP / ERP</p>
            <h2>Rà soát dữ liệu báo ca</h2>
            <p className="muted small">Bảng sẽ đối chiếu số lượng báo ca ERP với số lượng đã ghi nhận trong App.</p>
          </div>
        </div>

        <div className="table-wrap">
          <table className="shift-comparison-table">
            <thead>
              <tr>
                <th>Ngày báo ca</th>
                <th>Ca</th>
                <th>Máy</th>
                <th>WO</th>
                <th>Itemcode</th>
                <th>ERP báo ca</th>
                <th>App đã in</th>
                <th>Chênh lệch</th>
                <th>Kết quả</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="shift-comparison-empty" colSpan={9}>Chưa có dữ liệu. Chọn chế độ và upload báo ca để bắt đầu rà soát.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
