"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ImportFormProps = {
  databaseReady: boolean;
};

type ImportResult = {
  error?: string;
  success?: boolean;
  imported?: number;
  fileName?: string;
};

export function PlanningImportForm({ databaseReady }: ImportFormProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (!file) {
      setMessage({ type: "error", text: "Vui lòng chọn file Excel .xlsx." });
      return;
    }

    const confirmed = window.confirm(
      "Khi xác nhận, toàn bộ plan hiện tại sẽ được thay bằng dữ liệu trong sheet data. Tiếp tục?",
    );
    if (!confirmed) return;

    setPending(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/planning-inject/import", {
        method: "POST",
        body: formData,
      });
      const result = (await response.json()) as ImportResult;

      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể cập nhật plan.");
      }

      setMessage({
        type: "success",
        text: `Đã thay plan cũ bằng ${Number(result.imported ?? 0).toLocaleString("vi-VN")} dòng từ file ${result.fileName}.`,
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể cập nhật plan.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="planning-upload" onSubmit={handleSubmit}>
      <div className="upload-dropzone">
        <div className="upload-icon" aria-hidden="true">XL</div>
        <div>
          <strong>Chọn file kế hoạch Excel</strong>
          <p className="muted small">
            Hệ thống đọc sheet <b>data</b>, bỏ dòng header đầu tiên và lấy 12 cột A–L.
          </p>
        </div>
        <label className="button button-secondary file-picker">
          Chọn file .xlsx
          <input
            ref={inputRef}
            type="file"
            name="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={!databaseReady || pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setMessage(null);
            }}
          />
        </label>
      </div>

      <div className="upload-selection">
        <div>
          <span className="muted small">File đã chọn</span>
          <strong>{file?.name ?? "Chưa chọn file"}</strong>
        </div>
        <button
          className="button button-primary"
          type="submit"
          disabled={!databaseReady || !file || pending}
        >
          {pending ? "Đang cập nhật..." : "Xóa plan cũ & cập nhật plan mới"}
        </button>
      </div>

      <p className="planning-warning">
        Lưu ý: dữ liệu chỉ được thay thế khi toàn bộ file hợp lệ. Nếu import lỗi, plan cũ vẫn được giữ nguyên.
      </p>

      {message ? (
        <p className={`alert ${message.type === "success" ? "alert-success" : "alert-error"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
