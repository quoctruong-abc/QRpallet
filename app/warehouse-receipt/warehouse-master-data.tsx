"use client";

import { useId, useRef, useState } from "react";
import type { MasterDataCounts, MasterDataPreview } from "@/lib/warehouse-receipt/master-data";

const number = (value: number) => value.toLocaleString("vi-VN", { maximumSignificantDigits: 15 });
type ImportError = { error: string; errors?: { row: number; message: string }[]; errorCount?: number };

export function WarehouseMasterData() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MasterDataPreview | null>(null);
  const [result, setResult] = useState<MasterDataCounts | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  async function submit(action: "preview" | "import") {
    if (!file || submitting.current || (action === "import" && (!preview || result))) return;
    submitting.current = true;
    setBusy(action);
    setError(null);
    setResult(null);
    if (action === "preview") setPreview(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("action", action);
      if (action === "import" && preview) body.set("fingerprint", preview.fingerprint);
      const response = await fetch("/api/warehouse-receipt/master-data", { method: "POST", body });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setError({
          error: data?.error || (response.status === 413 ? "File Excel vượt quá 4 MB." : "Không thể xử lý file. Vui lòng thử lại."),
          errors: data?.errors, errorCount: data?.errorCount,
        });
        return;
      }
      if (action === "preview") setPreview(data);
      else { setResult(data.counts); setPreview(null); }
    } catch {
      setError({ error: action === "import" ? "Chưa xác nhận được kết quả. Có thể nạp lại cùng file mà không tạo mã trùng."
        : "Không thể kiểm tra file. Kiểm tra kết nối rồi thử lại." });
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  return <>
    <button aria-haspopup="dialog" className="button button-secondary" type="button" onClick={() => dialog.current?.showModal()}>
      Nạp master data
    </button>
    <dialog ref={dialog} aria-labelledby={`${id}-title`} className="modal-card warehouse-opening-dialog warehouse-master-dialog"
      onCancel={(event) => { if (submitting.current) event.preventDefault(); }}>
      <div className="modal-heading">
        <div>
          <h2 id={`${id}-title`}>Nạp master data</h2>
          <p className="muted small">Sheet <strong>data</strong>: cột A mã sản phẩm, B tên ERP, F khối lượng.</p>
        </div>
        <button aria-label="Đóng nạp master data" className="modal-close" type="button" disabled={Boolean(busy)}
          onClick={() => dialog.current?.close()}>×</button>
      </div>
      <label>File Excel
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={Boolean(busy)}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null); setPreview(null); setError(null); setResult(null);
          }} />
      </label>
      <p className="muted small">Mã có số 0 đầu cần lưu dạng văn bản trong Excel. Nếu cột F trống, khối lượng đã có được giữ nguyên.</p>
      {error ? <div role="alert" className="alert alert-error warehouse-opening-errors">
        {error.error}
        {error.errors?.length ? <ul>{error.errors.map((issue) => <li key={issue.row}>Dòng {issue.row}: {issue.message}</li>)}</ul> : null}
        {error.errorCount && error.errors && error.errorCount > error.errors.length
          ? <p>Hiển thị {number(error.errors.length)} trên {number(error.errorCount)} dòng lỗi.</p> : null}
      </div> : null}
      {result ? <p className="alert alert-success" role="status">
        Đã đồng bộ: {number(result.inserted)} mã mới · {number(result.updated)} mã cập nhật · {number(result.unchanged)} mã không đổi.
      </p> : null}
      {preview ? <section className="warehouse-opening-preview" aria-label="Xem trước master data">
        <p role="status"><strong>{number(preview.counts.inserted)} mã mới</strong> · {number(preview.counts.updated)} mã sẽ cập nhật · {number(preview.counts.unchanged)} mã không đổi.
          {preview.duplicateCount > 0 ? ` Đã gộp ${number(preview.duplicateCount)} dòng trùng hoàn toàn.` : ""}</p>
        <div className="scan-table-wrap"><table className="warehouse-table">
          <thead><tr><th>Dòng Excel</th><th>Mã sản phẩm</th><th>Tên ERP</th><th>Khối lượng</th></tr></thead>
          <tbody>{preview.rows.map((row) => <tr key={row.itemcode}>
            <td>{row.excel_row}</td><td>{row.itemcode}</td><td>{row.erp_name}</td>
            <td>{row.netweight === null ? "—" : number(row.netweight)}</td>
          </tr>)}</tbody>
        </table></div>
        {preview.counts.inserted + preview.counts.updated + preview.counts.unchanged > preview.rows.length
          ? <p className="muted small">Bảng hiển thị {preview.rows.length} mã đầu. Các số ở trên tính cho cả file.</p> : null}
      </section> : null}
      <div className="modal-actions">
        <button className="button button-secondary" type="button" disabled={Boolean(busy)} onClick={() => dialog.current?.close()}>Đóng</button>
        <button className="button button-secondary" type="button" disabled={!file || Boolean(busy)}
          onClick={() => { void submit("preview"); }}>{busy === "preview" ? "Đang kiểm tra…" : "Kiểm tra file"}</button>
        <button className="button button-primary" type="button" disabled={!preview || Boolean(busy) || Boolean(result)}
          onClick={() => { void submit("import"); }}>{busy === "import" ? "Đang đồng bộ…" : "Xác nhận nạp master data"}</button>
      </div>
    </dialog>
  </>;
}
