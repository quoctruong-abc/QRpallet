"use client";

import { useId, useRef, useState } from "react";
import type { OpeningPreview, OpeningResult } from "@/lib/warehouse-receipt/opening-inventory";

type ImportError = { error: string; errors?: { row: number; message: string }[]; errorCount?: number };
const quantity = (value: number) => value.toLocaleString("vi-VN");
const date = (value: string | null) => value ? value.split("-").reverse().join("/") : "—";

export function WarehouseOpeningInventory() {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OpeningPreview | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [result, setResult] = useState<OpeningResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  async function submit(action: "preview" | "import") {
    if (!file || busyRef.current || (action === "import" && (!preview || result))) return;
    busyRef.current = true;
    setBusy(action);
    setError(null);
    setResult(null);
    if (action === "preview") setPreview(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("action", action);
      if (action === "import" && preview) body.set("fingerprint", preview.fingerprint);
      const response = await fetch("/api/warehouse-receipt/opening-inventory", { method: "POST", body });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setError({
          error: data?.error || (response.status === 413 ? "File Excel vượt quá 4 MB." : "Không thể xử lý file. Vui lòng thử lại."),
          errors: data?.errors, errorCount: data?.errorCount,
        });
        return;
      }
      if (action === "preview") setPreview(data);
      else setResult(data.result);
    } catch {
      setError({ error: action === "import"
        ? "Chưa xác nhận được kết quả nạp kho. Có thể thử lại với cùng file mà không ghi trùng."
        : "Không thể kiểm tra file. Kiểm tra kết nối rồi thử lại." });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      <button aria-haspopup="dialog" className="button button-secondary" onClick={() => dialog.current?.showModal()} type="button">
        Nạp nhập kho lần đầu
      </button>
      <dialog aria-labelledby={`${id}-title`} className="modal-card warehouse-opening-dialog" onCancel={(event) => { if (busyRef.current) event.preventDefault(); }} ref={dialog}>
        <div className="modal-heading">
          <div>
            <h2 id={`${id}-title`}>Nạp nhập kho lần đầu</h2>
            <p className="muted small">Chọn file .xlsx có sheet Detail. Tiêu đề ở dòng 5, dữ liệu từ dòng 6.</p>
          </div>
          <button aria-label="Đóng" className="modal-close" disabled={Boolean(busy)} onClick={() => dialog.current?.close()} type="button">×</button>
        </div>
        <label>File Excel<input accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={Boolean(busy)} onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setPreview(null);
          setError(null);
          setResult(null);
        }} type="file" /></label>
        {error ? <div className="alert alert-error warehouse-opening-errors" role="alert">
          {error.error}
          {error.errors?.length ? <ul>{error.errors.map((issue) => <li key={issue.row}>Dòng {issue.row}: {issue.message}</li>)}</ul> : null}
          {error.errorCount && error.errors && error.errorCount > error.errors.length
            ? <p>Hiển thị {error.errors.length} trên {error.errorCount} dòng lỗi.</p> : null}
        </div> : null}
        {result ? <p className="alert alert-success" role="status">
          {result.already_imported ? "Nội dung này đã được nạp trước đó. Hệ thống không ghi trùng." : `Đã ghi ${quantity(result.line_count)} dòng vào tồn kho.`}
          {result.missing_customer_count > 0 ? ` ${quantity(result.missing_customer_count)} dòng để trống khách hàng vì không tìm thấy trong dữ liệu.` : ""}
        </p> : null}
        {preview ? <section aria-label="Xem trước tồn kho" className="warehouse-opening-preview">
          <p role="status"><strong>{quantity(preview.summary.lines)} dòng sẽ ghi</strong> · Tồn đầu: {quantity(preview.summary.opening)} · Nhập: {quantity(preview.summary.received)} · Đã xuất: {quantity(preview.summary.issued)} · Tồn còn: {quantity(preview.summary.balance)}</p>
          <div className="scan-table-wrap"><table className="warehouse-table">
            <thead><tr><th>Dòng Excel</th><th>Nguồn</th><th>Ngày nhập</th><th>Ngày sản xuất</th><th>Mã sản phẩm</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>WO</th><th>Số nhận</th><th>Số xuất</th><th>Tồn</th></tr></thead>
            <tbody>{preview.rows.map((row) => <tr key={`${row.excel_row}-${row.kind}`}>
              <td>{row.excel_row}</td><td>{row.kind === "opening" ? "Tồn đầu (H)" : "Nhập (I–K)"}</td>
              <td>{date(row.received_date)}</td><td>{date(row.production_date)}</td>
              <td>{row.itemcode}</td><td>{row.product_name}</td><td>{row.customer || "—"}</td><td>{row.wo || "—"}</td>
              <td>{quantity(row.received_qty)}</td><td>{quantity(row.issued_qty)}</td><td>{quantity(row.balance_qty)}</td>
            </tr>)}</tbody>
          </table></div>
          {preview.summary.lines > preview.rows.length ? <p className="muted small">Hiển thị {preview.rows.length} dòng đầu. Tổng số ở trên tính cho cả file.</p> : null}
          <p className="muted small">Tên sản phẩm và khách hàng ưu tiên dữ liệu hệ thống. Nếu không tìm thấy tên, dùng cột E; nếu không tìm thấy khách hàng, để trống.</p>
        </section> : null}
        <div className="modal-actions">
          <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => dialog.current?.close()} type="button">Đóng</button>
          <button className="button button-secondary" disabled={!file || Boolean(busy) || Boolean(result)} onClick={() => { void submit("preview"); }} type="button">{busy === "preview" ? "Đang kiểm tra…" : "Kiểm tra file"}</button>
          <button className="button button-primary" disabled={!preview || Boolean(busy) || Boolean(result)} onClick={() => { void submit("import"); }} type="button">{busy === "import" ? "Đang ghi tồn kho…" : "Xác nhận nạp tồn kho"}</button>
        </div>
      </dialog>
    </>
  );
}
