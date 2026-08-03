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
type LiveScanState = "loading" | "success" | "error";
type LiveScanItem = {
  palletId: string;
  state: LiveScanState;
  message: string;
  wo?: string;
  quantity?: number;
  itemcode?: string;
};
type QrPoint = { x: number; y: number };
type DetailedScanResult = {
  data: string;
  cornerPoints: QrPoint[];
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

export function ScanQrClient({ initialRows, isAdmin }: { initialRows: ScannedPallet[]; isAdmin: boolean }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const scannedIdsRef = useRef(new Set(initialRows.map((row) => row.pallet_id)));
  const freshScanUntilRef = useRef(new Map<string, number>());
  const qrOutlineSvgRef = useRef<SVGSVGElement | null>(null);
  const qrOutlinePolygonRef = useRef<SVGPolygonElement | null>(null);
  const qrOutlineLabelRef = useRef<HTMLDivElement | null>(null);
  const qrOutlineTimerRef = useRef<number | null>(null);
  const [rows, setRows] = useState(initialRows);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [liveScans, setLiveScans] = useState<LiveScanItem[]>(() => initialRows.map((row) => ({
    palletId: row.pallet_id,
    state: "success",
    message: "Đã scan",
    wo: row.wo,
    quantity: Number(row.quantity),
    itemcode: row.itemcode,
  })));
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
    setLiveScans((current) => [
      item,
      ...current.filter((scan) => scan.palletId !== item.palletId),
    ]);
  }

  function updateLiveScan(palletId: string, patch: Partial<Omit<LiveScanItem, "palletId">>) {
    setLiveScans((current) => current.map((scan) => (
      scan.palletId === palletId ? { ...scan, ...patch } : scan
    )));
  }

  function showQrOutline(cornerPoints: QrPoint[], palletId: string, isFreshScan: boolean) {
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

    const stroke = isFreshScan ? "#32d583" : "#fdb022";
    const fill = isFreshScan ? "rgba(50,213,131,.16)" : "rgba(253,176,34,.16)";
    polygon.setAttribute("stroke", stroke);
    polygon.setAttribute("fill", fill);

    const minX = Math.min(...projectedPoints.map((point) => point.x));
    const minY = Math.min(...projectedPoints.map((point) => point.y));
    label.style.display = "block";
    label.style.left = `${Math.max(10, Math.min(minX, displayWidth - 180))}px`;
    label.style.top = `${Math.max(74, minY - 42)}px`;
    label.style.background = isFreshScan ? "rgba(2,122,72,.94)" : "rgba(181,71,8,.94)";
    label.textContent = isFreshScan ? `✓ Đã nhận: ${palletId}` : `↻ Đã scan: ${palletId}`;

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
    setCameraOpen(false);
    if (clearNotice) setNotice(null);
  }

  async function openCamera() {
    if (scannerRef.current) return;

    const ios = isIosDevice();
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
    const alreadyScanned = scannedIdsRef.current.has(palletId);
    const isFreshScan = !alreadyScanned || (freshScanUntilRef.current.get(palletId) ?? 0) > now;
    showQrOutline(result.cornerPoints, palletId, isFreshScan);

    if (alreadyScanned) return;

    scannedIdsRef.current.add(palletId);
    freshScanUntilRef.current.set(palletId, now + 900);
    if (typeof navigator.vibrate === "function") navigator.vibrate(55);
    addLiveScan({
      palletId,
      state: "loading",
      message: "Đang gửi server",
    });

    let receivedServerResponse = false;

    try {
      const response = await fetch("/api/scan-qr/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletId }),
      });
      receivedServerResponse = true;

      const apiResult = await response.json();
      if (!response.ok || !apiResult.success) throw new Error(apiResult.error || "Không thể xử lý pallet.");

      const pallet = apiResult.pallet as ScannedPallet;
      setRows((current) => [pallet, ...current.filter((row) => row.pallet_id !== pallet.pallet_id)]);
      updateLiveScan(palletId, {
        state: "success",
        message: "Đã cập nhật",
        wo: pallet.wo,
        quantity: Number(pallet.quantity),
        itemcode: pallet.itemcode,
      });
    } catch (error) {
      if (!receivedServerResponse) {
        scannedIdsRef.current.delete(palletId);
        freshScanUntilRef.current.delete(palletId);
      }
      updateLiveScan(palletId, {
        state: "error",
        message: error instanceof Error ? error.message : `Lỗi khi quét pallet ${palletId}.`,
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
      freshScanUntilRef.current.delete(cancelRow.pallet_id);
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
      setLiveScans([]);
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
          ▣<span>Mở camera live</span>
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
            <strong>Quét QR pallet liên tục</strong>
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
              width: "min(620px, calc(100% - 20px))",
              height: "min(29vh, 230px)",
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
              <strong style={{ fontSize: ".88rem" }}>Pallet đã scan</strong>
              <span style={{ fontSize: ".78rem", opacity: .82 }}>{liveScans.length} ID • kéo để xem</span>
            </div>

            <div style={{ overflowY: "auto", overscrollBehavior: "contain" }}>
              {!liveScans.length ? (
                <div style={{ padding: "20px 12px", textAlign: "center", opacity: .72 }}>Chưa có pallet nào.</div>
              ) : (
                <table style={{ minWidth: "500px", width: "100%", color: "white", background: "transparent" }}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "rgba(15,23,42,.97)" }}>
                    <tr>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>ID pallet</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>WO / Item</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>SL</th>
                      <th style={{ padding: "8px 10px", color: "rgba(255,255,255,.72)" }}>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveScans.map((scan) => (
                      <tr key={scan.palletId} style={{ background: scan.state === "error" ? "rgba(180,35,24,.16)" : "transparent" }}>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}><strong>{scan.palletId}</strong></td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>
                          <span>{scan.wo || "—"}</span>
                          <small style={{ display: "block", marginTop: "2px", opacity: .68 }}>{scan.itemcode || "—"}</small>
                        </td>
                        <td style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>{scan.quantity === undefined ? "—" : scan.quantity.toLocaleString("vi-VN")}</td>
                        <td title={scan.message} style={{ padding: "9px 10px", borderColor: "rgba(255,255,255,.12)" }}>
                          <span style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            maxWidth: "150px",
                            padding: "4px 7px",
                            borderRadius: "999px",
                            color: "white",
                            background: scan.state === "success" ? "rgba(2,122,72,.94)" : scan.state === "error" ? "rgba(180,35,24,.94)" : "rgba(21,94,239,.94)",
                            fontSize: ".72rem",
                            fontWeight: 800,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}>
                            {scan.state === "success" ? "✓" : scan.state === "error" ? "!" : "…"} {scan.message}
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
