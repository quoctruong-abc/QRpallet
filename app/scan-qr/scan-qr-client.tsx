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
type LiveScanState = "loading" | "success" | "error" | "duplicate";
type LiveScanItem = {
  scanKey: string;
  palletId: string;
  state: LiveScanState;
  message: string;
  palletStatus?: string;
  wo?: string;
  quantity?: number;
  itemcode?: string;
};
type PalletDetails = {
  palletStatus?: string;
  wo?: string;
  quantity?: number;
  itemcode?: string;
};
type QrPoint = { x: number; y: number };
type DetailedScanResult = {
  data: string;
  cornerPoints: QrPoint[];
};
type ScanApiResult = {
  success?: boolean;
  error?: string;
  code?: string;
  palletStatus?: string;
  pallet?: ScannedPallet;
};

const CAMERA_CAPTURE_DELAY_MS = 10_000;
const DUPLICATE_LOG_COOLDOWN_MS = 900;
const MAX_SCAN_PALLETS = 200;
const SCAN_LIMIT_WARNING_AT = 150;

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
    return "Thiết bị đang chặn quyền camera. Hãy cho phép camera rồi mở lại ứng dụng.";
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

  return message || "Không thể mở camera live.";
}

function palletStatusResult(status?: string) {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "pendingwh") return "Đã scan";
  if (normalized === "processingwh") return "Đang nhập kho";
  if (normalized === "whdone") return "Đã nhập kho";
  if (normalized === "production") return "Chưa scan";
  return status || null;
}

function scanStateBackground(state: LiveScanState) {
  if (state === "loading" || state === "success") return "rgba(2,122,72,.94)";
  if (state === "duplicate") return "rgba(181,71,8,.94)";
  return "rgba(180,35,24,.94)";
}

export function ScanQrClient({ initialRows, isAdmin }: { initialRows: ScannedPallet[]; isAdmin: boolean }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const scanSequenceRef = useRef(0);
  const nextCaptureAllowedAtRef = useRef(0);
  const scannedIdsRef = useRef(new Set(initialRows.map((row) => row.pallet_id)));
  const duplicateLoggedAtRef = useRef(new Map<string, number>());
  const palletDetailsRef = useRef(new Map<string, PalletDetails>(initialRows.map((row) => [
    row.pallet_id,
    {
      palletStatus: row.status,
      wo: row.wo,
      quantity: Number(row.quantity),
      itemcode: row.itemcode,
    },
  ])));
  const qrOutlineSvgRef = useRef<SVGSVGElement | null>(null);
  const qrOutlinePolygonRef = useRef<SVGPolygonElement | null>(null);
  const qrOutlineLabelRef = useRef<HTMLDivElement | null>(null);
  const qrOutlineTimerRef = useRef<number | null>(null);
  const [rows, setRows] = useState(initialRows);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [liveScans, setLiveScans] = useState<LiveScanItem[]>(() => initialRows.map((row, index) => ({
    scanKey: `initial-${index}-${row.pallet_id}`,
    palletId: row.pallet_id,
    state: "error",
    message: palletStatusResult(row.status) || "Đã scan",
    palletStatus: row.status,
    wo: row.wo,
    quantity: Number(row.quantity),
    itemcode: row.itemcode,
  })));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelRow, setCancelRow] = useState<ScannedPallet | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const showScanLimitIndicator = rows.length >= SCAN_LIMIT_WARNING_AT;
  const scanLimitReached = rows.length >= MAX_SCAN_PALLETS;

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

  function nextScanKey(palletId: string) {
    scanSequenceRef.current += 1;
    return `${Date.now()}-${scanSequenceRef.current}-${palletId}`;
  }

  function hideQrOutline() {
    if (qrOutlineTimerRef.current !== null) {
      window.clearTimeout(qrOutlineTimerRef.current);
      qrOutlineTimerRef.current = null;
    }
    if (qrOutlineSvgRef.current) qrOutlineSvgRef.current.style.display = "none";
    if (qrOutlineLabelRef.current) qrOutlineLabelRef.current.style.display = "none";
  }

  function destroyScanner() {
    hideQrOutline();
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    try {
      scanner.destroy();
    } catch {
      // Safari can already have released the media stream when the PWA is hidden.
    }
  }

  function addLiveScan(item: LiveScanItem) {
    setLiveScans((current) => [item, ...current]);
  }

  function updateLiveScan(scanKey: string, patch: Partial<Omit<LiveScanItem, "scanKey" | "palletId">>) {
    setLiveScans((current) => current.map((scan) => (
      scan.scanKey === scanKey ? { ...scan, ...patch } : scan
    )));
  }

  function updatePalletDetails(palletId: string, details: PalletDetails) {
    const mergedDetails = {
      ...palletDetailsRef.current.get(palletId),
      ...details,
    };
    palletDetailsRef.current.set(palletId, mergedDetails);
    setLiveScans((current) => current.map((scan) => (
      scan.palletId === palletId ? { ...scan, ...mergedDetails } : scan
    )));
  }

  function showQrOutline(cornerPoints: QrPoint[], palletId: string, duplicate: boolean) {
    const video = videoRef.current;
    const svg = qrOutlineSvgRef.current;
    const polygon = qrOutlinePolygonRef.current;
    const label = qrOutlineLabelRef.current;
    if (!video || !svg || !polygon || !label || cornerPoints.length < 4) return;

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const displayWidth = video.clientWidth;
    const displayHeight = video.clientHeight;
    if (!videoWidth || !videoHeight || !displayWidth || !displayHeight) return;

    const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight);
    const offsetX = (displayWidth - videoWidth * scale) / 2;
    const offsetY = (displayHeight - videoHeight * scale) / 2;
    const projectedPoints = cornerPoints.map((point) => ({
      x: offsetX + point.x * scale,
      y: offsetY + point.y * scale,
    }));

    svg.setAttribute("viewBox", `0 0 ${displayWidth} ${displayHeight}`);
    svg.style.display = "block";
    polygon.setAttribute("points", projectedPoints.map((point) => `${point.x},${point.y}`).join(" "));

    const stroke = duplicate ? "#fdb022" : "#32d583";
    const fill = duplicate ? "rgba(253,176,34,.16)" : "rgba(50,213,131,.16)";
    polygon.setAttribute("stroke", stroke);
    polygon.setAttribute("fill", fill);

    const minX = Math.min(...projectedPoints.map((point) => point.x));
    const minY = Math.min(...projectedPoints.map((point) => point.y));
    label.style.display = "block";
    label.style.left = `${Math.max(10, Math.min(minX, displayWidth - 180))}px`;
    label.style.top = `${Math.max(74, minY - 42)}px`;
    label.style.background = duplicate ? "rgba(181,71,8,.94)" : "rgba(2,122,72,.94)";
    label.textContent = duplicate ? `↻ Scan trùng: ${palletId}` : `✓ Đã nhận: ${palletId}`;

    if (qrOutlineTimerRef.current !== null) window.clearTimeout(qrOutlineTimerRef.current);
    qrOutlineTimerRef.current = window.setTimeout(hideQrOutline, 520);
  }

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      destroyScanner();
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
    nextCaptureAllowedAtRef.current = 0;
    setCameraOpen(false);
    if (clearNotice) setNotice(null);
  }

  async function openCamera() {
    if (scannerRef.current) return;
    if (scannedIdsRef.current.size >= MAX_SCAN_PALLETS) {
      setNotice({ type: "error", text: "Đã đạt giới hạn tối đa 200 pallet. Hãy tạo phiếu trước khi scan thêm." });
      return;
    }

    const ios = isIosDevice();
    nextCaptureAllowedAtRef.current = 0;
    setCameraOpen(true);
    setNotice({ type: "loading", text: "Đang mở camera live..." });

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
        (result) => void handleDetected(result as DetailedScanResult),
        {
          preferredCamera: "environment",
          maxScansPerSecond: ios ? 10 : 16,
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

  async function handleDetected(result: DetailedScanResult) {
    const palletId = cleanQrValue(result.data);
    if (!palletId) return;

    const now = Date.now();
    if (now < nextCaptureAllowedAtRef.current) return;
    nextCaptureAllowedAtRef.current = now + CAMERA_CAPTURE_DELAY_MS;

    const alreadyScanned = scannedIdsRef.current.has(palletId);

    if (alreadyScanned) {
      showQrOutline(result.cornerPoints, palletId, true);
      const lastLoggedAt = duplicateLoggedAtRef.current.get(palletId) ?? 0;
      if (now - lastLoggedAt >= DUPLICATE_LOG_COOLDOWN_MS) {
        duplicateLoggedAtRef.current.set(palletId, now);
        const details = palletDetailsRef.current.get(palletId) ?? {};
        addLiveScan({
          scanKey: nextScanKey(palletId),
          palletId,
          state: "duplicate",
          message: "Scan trùng",
          ...details,
        });
      }
      return;
    }

    if (scannedIdsRef.current.size >= MAX_SCAN_PALLETS) {
      setNotice({ type: "error", text: "Đã đạt giới hạn tối đa 200 pallet. Hãy tạo phiếu trước khi scan thêm." });
      addLiveScan({
        scanKey: nextScanKey(palletId),
        palletId,
        state: "error",
        message: "Đã đủ 200 pallet",
        palletStatus: "Chưa scan",
      });
      return;
    }

    showQrOutline(result.cornerPoints, palletId, false);
    scannedIdsRef.current.add(palletId);
    palletDetailsRef.current.set(palletId, { palletStatus: "Đang kiểm tra" });
    if (typeof navigator.vibrate === "function") navigator.vibrate(55);

    const scanKey = nextScanKey(palletId);
    addLiveScan({
      scanKey,
      palletId,
      state: "loading",
      message: "Đang kiểm tra",
      palletStatus: "Đang kiểm tra",
    });

    try {
      const response = await fetch("/api/scan-qr/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletId }),
      });
      const apiResult = await response.json().catch(() => null) as ScanApiResult | null;

      if (!response.ok || !apiResult?.success || !apiResult.pallet) {
        const palletStatus = apiResult?.palletStatus;
        if (palletStatus) {
          updatePalletDetails(palletId, { palletStatus });
        } else {
          scannedIdsRef.current.delete(palletId);
          duplicateLoggedAtRef.current.delete(palletId);
          palletDetailsRef.current.delete(palletId);
        }

        if (apiResult?.code === "MAX_SCAN_PALLETS") {
          setNotice({ type: "error", text: "Đã đạt giới hạn tối đa 200 pallet. Hãy tạo phiếu trước khi scan thêm." });
        }

        const conciseResult = palletStatusResult(palletStatus)
          || (apiResult?.code === "PALLET_NOT_FOUND"
            ? "Không tìm thấy"
            : apiResult?.code === "MAX_SCAN_PALLETS"
              ? "Đã đủ 200 pallet"
              : "Không thể scan");

        updateLiveScan(scanKey, {
          state: "error",
          message: conciseResult,
          palletStatus: palletStatus || "Chưa xác nhận",
        });
        return;
      }

      const pallet = apiResult.pallet;
      setRows((current) => [pallet, ...current.filter((row) => row.pallet_id !== pallet.pallet_id)]);
      updatePalletDetails(palletId, {
        palletStatus: pallet.status,
        wo: pallet.wo,
        quantity: Number(pallet.quantity),
        itemcode: pallet.itemcode,
      });
      updateLiveScan(scanKey, {
        state: "success",
        message: "Thành công",
      });
    } catch {
      scannedIdsRef.current.delete(palletId);
      duplicateLoggedAtRef.current.delete(palletId);
      palletDetailsRef.current.delete(palletId);
      updateLiveScan(scanKey, {
        state: "error",
        message: "Mất kết nối",
        palletStatus: "Chưa xác nhận",
      });
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
      setLiveScans((current) => current.filter((scan) => scan.palletId !== cancelRow.pallet_id));
      scannedIdsRef.current.delete(cancelRow.pallet_id);
      duplicateLoggedAtRef.current.delete(cancelRow.pallet_id);
      palletDetailsRef.current.delete(cancelRow.pallet_id);
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
    if (rows.length > MAX_SCAN_PALLETS) {
      setNotice({ type: "error", text: "Mỗi phiếu chỉ được xác nhận tối đa 200 pallet." });
      setConfirmOpen(false);
      return;
    }

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
      setLiveScans([]);
      scannedIdsRef.current.clear();
      duplicateLoggedAtRef.current.clear();
      palletDetailsRef.current.clear();
      nextCaptureAllowedAtRef.current = 0;
      hideQrOutline();
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
            {isAdmin ? "Admin đang xem tối đa 200 pallet đã scan gần nhất" : "Chỉ hiển thị pallet do tài khoản này scan"}: <strong>{rows.length}</strong> pallet
          </p>
        </div>
      </div>

      <div className="scan-actions">
        <button className="scan-main-button scan-camera-button" type="button" disabled={scanLimitReached} onClick={() => void openCamera()}>
          ▣<span>{scanLimitReached ? "Đã đủ 200 pallet" : "Mở camera live"}</span>
        </button>
        <button className="scan-main-button scan-confirm-button" type="button" disabled={!rows.length || rows.length > MAX_SCAN_PALLETS} onClick={() => setConfirmOpen(true)}>
          ✓<span>Tạo phiếu ({rows.length})</span>
        </button>
      </div>

      {showScanLimitIndicator ? (
        <div
          aria-live="polite"
          role="status"
          style={{
            padding: "11px 14px",
            border: `1px solid ${scanLimitReached ? "#fecdca" : "#fedf89"}`,
            borderRadius: "12px",
            color: scanLimitReached ? "#b42318" : "#93370d",
            background: scanLimitReached ? "#fef3f2" : "#fffaeb",
            fontWeight: 800,
          }}
        >
          {scanLimitReached
            ? `200/200 pallet · Đã đạt giới hạn. Hãy tạo phiếu trước khi scan thêm.`
            : `${rows.length}/200 pallet · Còn ${MAX_SCAN_PALLETS - rows.length} pallet trước khi đạt giới hạn.`}
        </div>
      ) : null}

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

          <svg
            ref={qrOutlineSvgRef}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 3,
              width: "100%",
              height: "100%",
              display: "none",
              pointerEvents: "none",
            }}
          >
            <polygon
              ref={qrOutlinePolygonRef}
              strokeWidth="7"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <div
            ref={qrOutlineLabelRef}
            aria-live="polite"
            style={{
              position: "absolute",
              zIndex: 4,
              display: "none",
              maxWidth: "calc(100% - 20px)",
              padding: "8px 12px",
              border: "1px solid rgba(255,255,255,.8)",
              borderRadius: "10px",
              color: "white",
              boxShadow: "0 8px 24px rgba(0,0,0,.3)",
              fontSize: ".82rem",
              fontWeight: 850,
              overflowWrap: "anywhere",
              pointerEvents: "none",
            }}
          />

          <div className="camera-topbar">
            <strong>
              Quét QR pallet liên tục
              {showScanLimitIndicator ? ` · ${rows.length}/200` : ""}
            </strong>
            <button type="button" onClick={() => closeCamera()}>✕</button>
          </div>

          <div className="camera-guide" style={{ top: "70px", bottom: "34vh" }}>
            <span />
            <p>Đưa lần lượt các QR vào giữa khung</p>
          </div>

          <div
            style={{
              position: "absolute",
              zIndex: 5,
              left: "50%",
              right: "auto",
              bottom: "max(14px, env(safe-area-inset-bottom))",
              transform: "translateX(-50%)",
              width: "min(720px, calc(100% - 20px))",
              height: "min(31vh, 250px)",
              display: "grid",
              gridTemplateRows: "auto minmax(0, 1fr)",
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,.34)",
              borderRadius: "16px",
              color: "white",
              background: "rgba(15,23,42,.88)",
              boxShadow: "0 14px 42px rgba(0,0,0,.38)",
              backdropFilter: "blur(12px)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,.18)" }}>
              <strong style={{ fontSize: ".88rem" }}>Lịch sử scan trong phiên</strong>
              <span style={{ fontSize: ".78rem", opacity: .82 }}>{liveScans.length} lượt • kéo để xem</span>
            </div>

            <div style={{ overflow: "auto", overscrollBehavior: "contain" }}>
              {!liveScans.length ? (
                <div style={{ padding: "20px 12px", textAlign: "center", opacity: .72 }}>Chưa có pallet nào.</div>
              ) : (
                <table style={{ minWidth: "690px", width: "100%", color: "white", background: "transparent" }}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "rgba(15,23,42,.97)" }}>
                    <tr>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>Kết quả scan</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>ID pallet</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>WO / Item</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>SL</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>Trạng thái pallet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveScans.map((scan) => (
                      <tr
                        key={scan.scanKey}
                        style={{
                          background: scan.state === "error"
                            ? "rgba(180,35,24,.16)"
                            : scan.state === "duplicate"
                              ? "rgba(181,71,8,.14)"
                              : "transparent",
                        }}
                      >
                        <td title={scan.message} style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>
                          <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            maxWidth: "150px",
                            padding: "4px 8px",
                            borderRadius: "999px",
                            color: "white",
                            background: scanStateBackground(scan.state),
                            fontSize: ".72rem",
                            fontWeight: 800,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}>
                            {scan.message}
                          </span>
                        </td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}><strong>{scan.palletId}</strong></td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>
                          <span>{scan.wo || "—"}</span>
                          <small style={{ display: "block", marginTop: "2px", opacity: .68 }}>{scan.itemcode || "—"}</small>
                        </td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>{scan.quantity === undefined ? "—" : scan.quantity.toLocaleString("vi-VN")}</td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>
                          <span style={{
                            display: "inline-flex",
                            maxWidth: "130px",
                            padding: "4px 7px",
                            borderRadius: "999px",
                            color: "white",
                            background: "rgba(71,84,103,.92)",
                            fontSize: ".72rem",
                            fontWeight: 800,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}>
                            {scan.palletStatus || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {notice ? (
            <div
              className={`camera-notice camera-notice-${notice.type}`}
              style={{ top: "82px", bottom: "auto", left: "14px", right: "14px", zIndex: 6 }}
            >
              <span className={notice.type === "loading" ? "camera-spinner" : ""}>
                {notice.type === "success" ? "✓" : notice.type === "error" ? "!" : ""}
              </span>
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
            <p className="muted">Sau khi xác nhận, hệ thống tạo phiếu nhập kho và chuyển pallet sang WHdone. Mỗi phiếu tối đa 200 pallet. PDF chỉ in lại tại module Xem phiếu nhập kho.</p>
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
