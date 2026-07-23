"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QrScanner from "qr-scanner";

export type ScannedPallet = {
  pallet_id: string;
  wo: string;
  quantity: number;
  product_name: string | null;
  customer: string | null;
  itemcode: string;
  status: string;
  updated_at?: string;
  scanned_by?: string | null;
};

type Notice = { type: "success" | "error" | "loading"; text: string } | null;
type SummaryRow = {
  itemcode: string;
  product_name: string;
  customer: string;
  palletCount: number;
  totalQuantity: number;
};

function cleanQrValue(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get("palletId") || parsed.searchParams.get("id") || trimmed;
  } catch {
    return trimmed;
  }
}

function isIosDevice() {
  const userAgent = navigator.userAgent;
  return /iPad|iPhone|iPod/i.test(userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function waitForVideoElement() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : "";

  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(message)) {
    return "iPhone đang chặn quyền camera. Hãy mở Cài đặt > Safari > Camera và chọn Cho phép, sau đó mở lại ứng dụng.";
  }
  if (name === "NotFoundError" || /not found|no camera/i.test(message)) {
    return "Không tìm thấy camera trên thiết bị.";
  }
  if (name === "NotReadableError" || /in use|could not start|not readable/i.test(message)) {
    return "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng camera rồi thử lại.";
  }
  if (name === "OverconstrainedError") {
    return "Không chọn được camera sau. Hãy đóng ứng dụng và mở lại.";
  }

  return message || "Không thể mở camera. Bạn có thể dùng nút Chụp ảnh QR bên dưới.";
}

export function ScanQrClient({ initialRows, isAdmin }: { initialRows: ScannedPallet[]; isAdmin: boolean }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const scanLockedRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState(initialRows);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [iosMode, setIosMode] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelRow, setCancelRow] = useState<ScannedPallet | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const summary = useMemo<SummaryRow[]>(() => {
    const map = new Map<string, SummaryRow>();
    for (const row of rows) {
      const key = `${row.itemcode}||${row.product_name ?? ""}||${row.customer ?? ""}`;
      const current = map.get(key);
      if (current) {
        current.palletCount += 1;
        current.totalQuantity += Number(row.quantity);
      } else {
        map.set(key, {
          itemcode: row.itemcode,
          product_name: row.product_name ?? "—",
          customer: row.customer ?? "—",
          palletCount: 1,
          totalQuantity: Number(row.quantity),
        });
      }
    }
    return Array.from(map.values());
  }, [rows]);

  function destroyScanner() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    try {
      scanner.destroy();
    } catch {
      // Safari can already have released the media stream when the PWA is hidden.
    }
  }

  useEffect(() => {
    setIosMode(isIosDevice());

    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      destroyScanner();
      scanLockedRef.current = false;
      setCameraOpen(false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      destroyScanner();
    };
  }, []);

  function closeCamera(clearNotice = true) {
    destroyScanner();
    scanLockedRef.current = false;
    setCameraOpen(false);
    if (clearNotice) setNotice(null);
  }

  async function openCamera() {
    if (scannerRef.current) return;

    const ios = isIosDevice();
    setIosMode(ios);
    setCameraOpen(true);
    setNotice({ type: "loading", text: "Đang mở camera..." });

    try {
      await waitForVideoElement();
      const video = videoRef.current;
      if (!video) throw new Error("Không khởi tạo được vùng camera.");

      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");
      video.setAttribute("webkit-playsinline", "true");

      const hasCamera = await QrScanner.hasCamera();
      if (!hasCamera) throw new Error("Thiết bị không có camera khả dụng.");

      const scanner = new QrScanner(
        video,
        (result) => void handleDetected(result.data),
        {
          preferredCamera: "environment",
          maxScansPerSecond: ios ? 8 : 12,
          returnDetailedScanResult: true,
          highlightScanRegion: false,
          highlightCodeOutline: false,
          calculateScanRegion: (cameraVideo) => {
            const smallestSide = Math.min(cameraVideo.videoWidth, cameraVideo.videoHeight);
            const size = Math.max(240, Math.floor(smallestSide * 0.82));
            return {
              x: Math.max(0, Math.floor((cameraVideo.videoWidth - size) / 2)),
              y: Math.max(0, Math.floor((cameraVideo.videoHeight - size) / 2)),
              width: size,
              height: size,
              downScaledWidth: 800,
              downScaledHeight: 800,
            };
          },
        },
      );

      scannerRef.current = scanner;
      scanner.setInversionMode("both");
      await scanner.start();
      setNotice(null);
    } catch (error) {
      destroyScanner();
      setNotice({ type: "error", text: cameraErrorMessage(error) });
    }
  }

  async function handleImagePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    destroyScanner();
    setNotice({ type: "loading", text: "Đang đọc QR từ ảnh..." });

    try {
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
        alsoTryWithoutScanRegion: true,
      });
      setCameraOpen(false);
      await handleDetected(result.data);
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Không đọc được QR trong ảnh.",
      });
    }
  }

  async function handleDetected(decodedText: string) {
    if (scanLockedRef.current) return;
    scanLockedRef.current = true;
    const palletId = cleanQrValue(decodedText);
    setNotice({ type: "loading", text: `Đã nhận ${palletId}. Đang lấy dữ liệu...` });

    try {
      const response = await fetch("/api/scan-qr/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletId }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Không thể xử lý pallet.");

      const pallet = result.pallet as ScannedPallet;
      setRows((current) => [pallet, ...current.filter((row) => row.pallet_id !== pallet.pallet_id)]);
      setNotice({
        type: "success",
        text: `OK: ${pallet.pallet_id} • ${Number(pallet.quantity).toLocaleString("vi-VN")} pcs`,
      });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Lỗi khi quét pallet." });
    } finally {
      window.setTimeout(() => {
        scanLockedRef.current = false;
      }, 1800);
    }
  }

  async function cancelPallet() {
    if (!cancelRow) return;
    setCancelling(true);
    try {
      const response = await fetch("/api/scan-qr/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletId: cancelRow.pallet_id }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Không thể hủy pallet.");
      setRows((current) => current.filter((row) => row.pallet_id !== cancelRow.pallet_id));
      setNotice({ type: "success", text: `Đã trả pallet ${cancelRow.pallet_id} về production.` });
      setCancelRow(null);
      router.refresh();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể hủy pallet." });
      setCancelRow(null);
    } finally {
      setCancelling(false);
    }
  }

  async function confirmAll() {
    if (!rows.length) return;
    setConfirming(true);
    try {
      const response = await fetch("/api/scan-qr/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletIds: rows.map((row) => row.pallet_id) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Không thể tạo phiếu nhập kho.");
      }

      const receiptId = result.receiptId as string;
      setRows([]);
      setConfirmOpen(false);
      setNotice({ type: "success", text: `Tạo phiếu nhập kho thành công. Số phiếu: ${receiptId}` });
      router.refresh();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Không thể tạo phiếu nhập kho." });
      setConfirmOpen(false);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section className="scan-page">
      <div className="scan-heading">
        <div>
          <h1>Scan để nhập kho</h1>
          <p className="muted">
            {isAdmin ? "Admin đang xem toàn bộ pallet đã scan" : "Chỉ hiển thị pallet do tài khoản này scan"}: <strong>{rows.length}</strong> pallet
          </p>
        </div>
      </div>

      <div className="scan-actions">
        <button className="scan-main-button scan-camera-button" type="button" onClick={() => void openCamera()}>
          ▣<span>Mở camera</span>
        </button>
        <button className="scan-main-button scan-confirm-button" type="button" disabled={!rows.length} onClick={() => setConfirmOpen(true)}>
          ✓<span>Tạo phiếu ({rows.length})</span>
        </button>
      </div>

      {notice && !cameraOpen ? <div className={`scan-notice scan-notice-${notice.type}`}>{notice.text}</div> : null}

      <div className="scan-table-card">
        <div className="scan-table-title">
          <h2>Pallet đã scan</h2>
          <span>{rows.reduce((sum, row) => sum + Number(row.quantity), 0).toLocaleString("vi-VN")} pcs</span>
        </div>
        {!rows.length ? (
          <div className="scan-empty">Chưa có pallet nào được scan.</div>
        ) : (
          <div className="scan-table-wrap">
            <table className="scan-table">
              <thead>
                <tr><th>ID pallet</th><th>WO</th><th>Quantity</th><th>Product name</th><th>Customer</th><th>Itemcode</th><th>Thao tác</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.pallet_id}>
                    <td><strong>{row.pallet_id}</strong></td>
                    <td>{row.wo}</td>
                    <td>{Number(row.quantity).toLocaleString("vi-VN")}</td>
                    <td>{row.product_name || "—"}</td>
                    <td>{row.customer || "—"}</td>
                    <td>{row.itemcode}</td>
                    <td><button type="button" className="button button-danger scan-cancel-button" onClick={() => setCancelRow(row)}>Hủy</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <input
        ref={imageInputRef}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleImagePicked(event)}
      />

      {cameraOpen ? (
        <div className="camera-overlay">
          <video
            ref={videoRef}
            className="camera-reader"
            autoPlay
            muted
            playsInline
            style={{ objectFit: "cover" }}
          />
          <div className="camera-topbar">
            <strong>Quét QR pallet</strong>
            <button type="button" onClick={() => closeCamera()}>✕</button>
          </div>
          <div className="camera-guide"><span /><p>Đưa QR vào giữa khung</p></div>
          <div style={{ position: "absolute", zIndex: 4, left: "50%", bottom: "max(94px, calc(env(safe-area-inset-bottom) + 82px))", transform: "translateX(-50%)", width: "min(310px, calc(100% - 28px))", display: "grid", gap: "8px" }}>
            {notice?.type === "error" ? (
              <button className="button button-primary" type="button" onClick={() => void openCamera()}>Thử mở lại camera</button>
            ) : null}
            {(iosMode || notice?.type === "error") ? (
              <button className="button button-secondary" style={{ width: "100%", background: "rgba(255,255,255,.94)", boxShadow: "0 8px 24px rgba(0,0,0,.28)" }} type="button" onClick={() => imageInputRef.current?.click()}>
                Chụp ảnh QR
              </button>
            ) : null}
          </div>
          {notice ? (
            <div className={`camera-notice camera-notice-${notice.type}`}>
              <span className={notice.type === "loading" ? "camera-spinner" : ""}>{notice.type === "success" ? "✓" : notice.type === "error" ? "!" : ""}</span>
              <p>{notice.text}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {cancelRow ? (
        <div className="modal-backdrop" onMouseDown={() => !cancelling && setCancelRow(null)}>
          <div className="modal-card scan-cancel-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><p className="eyebrow">HỦY PALLET</p><h2>Trả pallet về production?</h2></div>
              <button type="button" className="modal-close" disabled={cancelling} onClick={() => setCancelRow(null)}>×</button>
            </div>
            <p className="muted">Pallet <strong>{cancelRow.pallet_id}</strong> sẽ bị loại khỏi danh sách và chuyển về <strong>production</strong>.</p>
            <div className="modal-actions">
              <button className="button button-secondary" disabled={cancelling} onClick={() => setCancelRow(null)}>Không</button>
              <button className="button button-danger" disabled={cancelling} onClick={() => void cancelPallet()}>{cancelling ? "Đang hủy..." : "Có, hủy pallet"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmOpen ? (
        <div className="modal-backdrop" onMouseDown={() => !confirming && setConfirmOpen(false)}>
          <div className="modal-card scan-confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><p className="eyebrow">TẠO PHIẾU NHẬP KHO</p><h2>Xác nhận tạo phiếu?</h2></div>
              <button type="button" className="modal-close" disabled={confirming} onClick={() => setConfirmOpen(false)}>×</button>
            </div>
            <div className="scan-summary-wrap">
              <table className="scan-summary-table">
                <thead><tr><th>Itemcode</th><th>Tên sản phẩm</th><th>KH</th><th>Số pallet</th><th>Tổng SL</th></tr></thead>
                <tbody>
                  {summary.map((row) => (
                    <tr key={`${row.itemcode}-${row.product_name}-${row.customer}`}>
                      <td><strong>{row.itemcode}</strong></td><td>{row.product_name}</td><td>{row.customer}</td><td>{row.palletCount}</td><td><strong>{row.totalQuantity.toLocaleString("vi-VN")}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">Sau khi xác nhận, hệ thống tạo phiếu nhập kho và chuyển pallet sang WHdone. PDF chỉ in lại tại module Xem phiếu nhập kho.</p>
            <div className="modal-actions">
              <button className="button button-secondary" disabled={confirming} onClick={() => setConfirmOpen(false)}>Quay lại</button>
              <button className="button button-primary" disabled={confirming} onClick={() => void confirmAll()}>{confirming ? "Đang tạo phiếu..." : "Xác nhận tạo phiếu"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
