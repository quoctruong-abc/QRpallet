"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PlanItem = {
  machine: string;
  itemcode: string;
  product_name: string;
  customer: string;
  wo: string;
  quanorder: number | null;
  produced_quantity: number;
  warehouse_quantity: number;
  quantity_per_pallet: number | null;
};

export type ActivePallet = {
  pallet_id: string;
  itemcode: string;
  product_name: string | null;
  customer: string | null;
  wo: string;
  quanorder: number | null;
  machine: string | null;
  quantity: number;
  status: string;
  note: string | null;
  created_at: string;
};

type Props = { rows: PlanItem[]; pallets: ActivePallet[] };
type Mode = "full" | "partial";
type Dialog = "create" | "created" | "history" | "edit" | "delete" | "merge" | null;
type FeedbackMessage = { type: "loading" | "success" | "error"; text: string };

const SILENT_PRINT_TIMEOUT_MS = 30_000;

function createPrintJobId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendSilentPrint(pdfUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const jobId = createPrintJobId();
    const printUrl = new URL(pdfUrl, window.location.origin);
    printUrl.searchParams.set("printJobId", jobId);

    const frame = document.createElement("iframe");
    frame.title = "In tem pallet ngầm";
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "800px",
      height: "600px",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearTimeout(timeoutId);
      frame.remove();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      const data = event.data as {
        source?: unknown;
        jobId?: unknown;
        status?: unknown;
        message?: unknown;
      } | null;
      if (data?.source !== "qr-pallet-print-page" || data.jobId !== jobId) return;
      if (data.status === "sent") finish();
      else if (data.status === "error") {
        finish(new Error(typeof data.message === "string" ? data.message : "Không thể gửi lệnh in."));
      }
    };
    const timeoutId = window.setTimeout(() => {
      finish(new Error("Quá thời gian chờ phản hồi từ chức năng in."));
    }, SILENT_PRINT_TIMEOUT_MS);

    window.addEventListener("message", handleMessage);
    frame.addEventListener("error", () => finish(new Error("Không thể tải trang in.")), { once: true });
    frame.src = printUrl.toString();
    document.body.appendChild(frame);
  });
}

function FeedbackAlert({ message }: { message: FeedbackMessage }) {
  const className = message.type === "error" ? "alert alert-error" : "alert alert-success";
  return (
    <p className={className} role="status" aria-live="polite" aria-busy={message.type === "loading"}>
      {message.type === "loading" ? "⏳ " : null}{message.text}
    </p>
  );
}

function formatNumber(value: number | null) {
  return value === null ? "—" : Number(value).toLocaleString("vi-VN");
}

function QuantityProgress({ value, total }: { value: number; total: number | null }) {
  const validTotal = total !== null && total > 0;
  const percent = validTotal ? (value / total) * 100 : 0;
  return (
    <div className="quantity-progress">
      <div className="quantity-progress-label"><strong>{formatNumber(value)}</strong><span>/ {formatNumber(total)}</span></div>
      <div className="quantity-progress-track"><span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} /></div>
      <small>{validTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small>
    </div>
  );
}

export function PalletLabelClient({ rows, pallets: initialPallets }: Props) {
  const router = useRouter();
  const validRows = useMemo(() => rows.filter((row) => row.wo.trim() !== "" && row.wo.trim() !== "0"), [rows]);
  const machines = useMemo(() => Array.from(new Set(validRows.map((row) => row.machine))).sort((a, b) => a.localeCompare(b, "vi")), [validRows]);
  const allWos = useMemo(() => Array.from(new Set(validRows.map((row) => row.wo))).sort((a, b) => a.localeCompare(b, "vi")), [validRows]);

  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<PlanItem | null>(null);
  const [selectedPallet, setSelectedPallet] = useState<ActivePallet | null>(null);
  const [historyPallets, setHistoryPallets] = useState<ActivePallet[]>(initialPallets);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<Mode>("full");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [wo1, setWo1] = useState("");
  const [wo2, setWo2] = useState("");
  const [searchWo, setSearchWo] = useState("");
  const [searchItem, setSearchItem] = useState("");
  const [historyDays, setHistoryDays] = useState(1);
  const [pending, setPending] = useState(false);
  const [reprintingPalletId, setReprintingPalletId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [updatingItemcode, setUpdatingItemcode] = useState<string | null>(null);
  const [message, setMessage] = useState<FeedbackMessage | null>(null);

  const visibleRows = selectedMachine ? validRows.filter((row) => row.machine === selectedMachine) : [];

  useEffect(() => {
    if (dialog !== "created" || message?.type !== "success") return;

    let closeTimer: number | null = null;
    const startCloseTimer = () => {
      if (closeTimer !== null || document.visibilityState !== "visible" || !document.hasFocus()) return;
      closeTimer = window.setTimeout(() => {
        setDialog(null);
        setSelectedPallet(null);
        setMessage(null);
        setQuantity("");
        setReason("");
      }, 3000);
    };

    startCloseTimer();
    document.addEventListener("visibilitychange", startCloseTimer);
    window.addEventListener("focus", startCloseTimer);
    return () => {
      document.removeEventListener("visibilitychange", startCloseTimer);
      window.removeEventListener("focus", startCloseTimer);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
    };
  }, [dialog, message?.type]);

  function closeDialog() {
    if (pending || reprintingPalletId !== null) return;
    setDialog(null);
    setSelectedPallet(null);
    setMessage(null);
    setQuantity("");
    setReason("");
  }

  function openCreate(row: PlanItem) {
    setSelectedRow(row);
    setMode("full");
    setQuantity("");
    setReason("");
    setMessage(null);
    setDialog("create");
  }

  function openEdit(pallet: ActivePallet) {
    setSelectedPallet(pallet);
    setQuantity(String(pallet.quantity));
    setReason("");
    setMessage(null);
    setDialog("edit");
  }

  function openDelete(pallet: ActivePallet) {
    setSelectedPallet(pallet);
    setReason("");
    setMessage(null);
    setDialog("delete");
  }

  async function updatePalletConfig(row: PlanItem) {
    const entered = window.prompt(`Nhập số lượng mỗi pallet cho item ${row.itemcode}:`);
    if (entered === null) return;
    const quantityPerPallet = Number(entered.trim());
    if (!Number.isInteger(quantityPerPallet) || quantityPerPallet <= 0) {
      window.alert("Số lượng mỗi pallet phải là số nguyên lớn hơn 0.");
      return;
    }
    setUpdatingItemcode(row.itemcode);
    try {
      const response = await fetch("/api/pallet-label/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemcode: row.itemcode, quantity_per_pallet: quantityPerPallet }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể cập nhật cấu hình pallet.");
      window.alert(`Đã cập nhật ${row.itemcode}: ${quantityPerPallet.toLocaleString("vi-VN")} pcs/pallet.`);
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Không thể cập nhật cấu hình pallet.");
    } finally {
      setUpdatingItemcode(null);
    }
  }

  async function openHistory(row?: PlanItem) {
    setSelectedRow(row ?? null);
    setSearchWo(row?.wo ?? "");
    setSearchItem(row?.itemcode ?? "");
    setHistoryDays(1);
    setMessage(null);
    setDialog("history");
    await loadPallets(row?.wo ?? "", row?.itemcode ?? "", 1);
  }

  async function loadPallets(wo = searchWo, itemcode = searchItem, days = historyDays) {
    setSearching(true);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (wo.trim()) params.set("wo", wo.trim());
      if (itemcode.trim()) params.set("itemcode", itemcode.trim());
      if (!wo.trim() && !itemcode.trim()) params.set("days", String(days));
      const response = await fetch(`/api/pallet-label/search?${params.toString()}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể tải lịch sử in tem.");
      setHistoryPallets(result.pallets);
      setHistoryDays(days);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể tải lịch sử in tem." });
    } finally {
      setSearching(false);
    }
  }

  async function postAction(body: Record<string, unknown>) {
    const response = await fetch("/api/pallet-label/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể thực hiện thao tác.");
    return result;
  }

  async function savePallet() {
    if (!selectedRow) return;
    const finalQuantity = mode === "full" ? selectedRow.quantity_per_pallet : Number(quantity);
    if (!finalQuantity || !Number.isInteger(finalQuantity) || finalQuantity <= 0) {
      setMessage({ type: "error", text: "Vui lòng nhập số lượng hợp lệ." });
      return;
    }
    let createdPalletId: string | null = null;
    setPending(true);
    try {
      const response = await fetch("/api/pallet-label/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selectedRow, quantity: finalQuantity }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể lưu pallet.");
      createdPalletId = String(result.pallet.pallet_id);
      setDialog("created");
      setMessage({ type: "loading", text: `Đang gửi lệnh in pallet ${createdPalletId}...` });
      setQuantity("");
      router.refresh();
      await sendSilentPrint(`/api/pallet-label/pdf?palletId=${encodeURIComponent(createdPalletId)}`);
      setMessage({ type: "success", text: `Đã gửi lệnh in pallet ${createdPalletId} thành công.` });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Không thể lưu pallet.";
      setMessage({
        type: "error",
        text: createdPalletId
          ? `Đã tạo pallet ${createdPalletId} nhưng gửi lệnh in thất bại: ${detail}`
          : detail,
      });
    } finally {
      setPending(false);
    }
  }

  async function editPallet() {
    if (!selectedPallet) return;
    const newQuantity = Number(quantity);
    if (!Number.isInteger(newQuantity) || newQuantity <= 0) {
      setMessage({ type: "error", text: "Số lượng không hợp lệ." });
      return;
    }
    if (!reason.trim()) {
      setMessage({ type: "error", text: "Vui lòng nhập lý do sửa pallet." });
      return;
    }

    let editedPalletId: string | null = null;
    setPending(true);
    try {
      const result = await postAction({ action: "edit", pallet_id: selectedPallet.pallet_id, quantity: newQuantity, reason: reason.trim() });
      const palletIdToPrint = String(result.pallet?.pallet_id || selectedPallet.pallet_id);
      editedPalletId = palletIdToPrint;
      setDialog("history");
      setSelectedPallet(null);
      setReason("");
      setMessage({ type: "loading", text: `Đang gửi lệnh in pallet ${palletIdToPrint}...` });
      await sendSilentPrint(`/api/pallet-label/pdf?palletId=${encodeURIComponent(palletIdToPrint)}`);
      await loadPallets();
      setMessage({ type: "success", text: `Đã sửa và gửi lệnh in pallet ${palletIdToPrint} thành công.` });
      router.refresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Không thể sửa pallet.";
      setMessage({
        type: "error",
        text: editedPalletId
          ? `Đã sửa pallet ${editedPalletId} nhưng gửi lệnh in thất bại: ${detail}`
          : detail,
      });
    } finally {
      setPending(false);
    }
  }

  async function deletePallet() {
    if (!selectedPallet) return;
    if (!reason.trim()) {
      setMessage({ type: "error", text: "Vui lòng nhập lý do xóa pallet." });
      return;
    }
    setPending(true);
    try {
      await postAction({ action: "delete", pallet_id: selectedPallet.pallet_id, reason: reason.trim() });
      setMessage({ type: "success", text: `Đã xóa hiệu lực ${selectedPallet.pallet_id}.` });
      await loadPallets();
      setDialog("history");
      setSelectedPallet(null);
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể xóa pallet." });
    } finally {
      setPending(false);
    }
  }

  async function mergePallet() {
    const mergeQuantity = Number(quantity);
    if (!wo1 || !wo2 || wo1 === wo2 || !Number.isInteger(mergeQuantity) || mergeQuantity <= 0) {
      setMessage({ type: "error", text: "Chọn 2 WO khác nhau và nhập số lượng hợp lệ." });
      return;
    }
    setPending(true);
    try {
      const result = await postAction({ action: "merge", wo1, wo2, quantity: mergeQuantity });
      setMessage({ type: "success", text: `Đã tạo ${result.pallet.pallet_id}; dữ liệu lấy từ ${wo1}.` });
      router.refresh();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể gộp pallet." });
    } finally {
      setPending(false);
    }
  }

  async function printPallet(palletId: string) {
    setReprintingPalletId(palletId);
    setMessage({ type: "loading", text: `Đang gửi lệnh in lại pallet ${palletId}...` });
    try {
      const response = await fetch("/api/pallet-label/reprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pallet_id: palletId }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "Không thể ghi nhận lần in lại.");
      }

      const reprintCount = Number(result.pallet?.reprint_count ?? 0);
      await sendSilentPrint(`/api/pallet-label/pdf?palletId=${encodeURIComponent(palletId)}`);
      await loadPallets();
      setMessage({
        type: "success",
        text: `Đã gửi lệnh in lại ${palletId} thành công. Số lần in lại: ${reprintCount}.`,
      });
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể in lại pallet.",
      });
    } finally {
      setReprintingPalletId(null);
    }
  }

  return <>
    <div className="feature-toolbar pallet-main-toolbar">
      <button className="button button-secondary" onClick={() => openHistory()}>Lịch sử in tem</button>
    </div>

    <div className="machine-grid">
      {machines.map((machine) => {
        const active = machine === selectedMachine;
        const machineRows = validRows.filter((row) => row.machine === machine);
        const woCount = new Set(machineRows.map((row) => row.wo)).size;
        const hasMissingConfig = machineRows.some((row) => row.quantity_per_pallet === null);
        return <div className="machine-grid-item" key={machine}>
          <button type="button" className={`machine-card machine-card-simple ${active ? "machine-card-active" : ""}`} onClick={() => setSelectedMachine((current) => current === machine ? null : machine)}>
            <span className="machine-icon machine-icon-large" style={{ position: "relative" }}>🏭{hasMissingConfig ? <span aria-label="Có itemcode chưa cấu hình số lượng pallet" title="Có itemcode chưa cấu hình số lượng pallet" style={{ color: "#dc2626", fontSize: "1rem", fontWeight: 800, marginLeft: "0.2rem" }}>!</span> : null}</span>
            <span className="machine-card-copy"><strong>{machine}</strong><small>{woCount} WO</small></span>
          </button>

          {active ? <section className="panel pallet-table-panel machine-detail-panel">
            <div className="section-heading"><div><p className="eyebrow">MACHINE</p><h2>{machine}</h2></div></div>
            <div className="table-wrap"><table className="pallet-table">
              <thead><tr><th>In tem</th><th>Itemcode</th><th>WO</th><th>Product name</th><th>Customer</th><th>Quan order</th><th>Đã chạy</th><th>Đã nhập kho</th></tr></thead>
              <tbody>{visibleRows.map((row) => <tr key={`${row.machine}-${row.wo}-${row.itemcode}`}>
                <td><div className="action-row"><button className="button button-primary button-small" onClick={() => openCreate(row)}>In tem</button>{row.quantity_per_pallet === null ? <button className="button button-secondary button-small" disabled={updatingItemcode === row.itemcode} onClick={() => updatePalletConfig(row)}>{updatingItemcode === row.itemcode ? "Đang cập nhật..." : "Cập nhật"}</button> : null}</div></td>
                <td><strong>{row.itemcode}</strong></td><td><span className="badge">{row.wo}</span></td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td>{formatNumber(row.quanorder)}</td><td><QuantityProgress value={row.produced_quantity} total={row.quanorder} /></td><td><QuantityProgress value={row.warehouse_quantity} total={row.quanorder} /></td>
              </tr>)}</tbody>
            </table></div>
          </section> : null}
        </div>;
      })}
    </div>

    {dialog ? <div className="modal-backdrop" onMouseDown={closeDialog}><div className="modal-card modal-card-wide" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><p className="eyebrow">PALLET</p><h2>{dialog === "created" ? message?.type === "loading" ? "Đang in tem" : message?.type === "error" ? "Tạo tem xong – lỗi in" : "In tem thành công" : dialog === "merge" ? "Gộp WO" : dialog === "delete" ? "Xóa pallet" : dialog === "history" ? "Lịch sử in tem" : selectedRow ? `${selectedRow.wo} · ${selectedRow.itemcode}` : "Pallet"}</h2></div><button className="modal-close" disabled={pending} onClick={closeDialog}>×</button></div>

      {dialog === "create" && selectedRow ? <>
        <div className="pallet-choice-grid">
          <label className={`choice-card ${mode === "full" ? "choice-card-active" : ""}`}><input type="radio" checked={mode === "full"} onChange={() => setMode("full")} /><span><strong>Pallet chẵn</strong><small>Lấy số lượng chuẩn</small></span></label>
          <label className={`choice-card ${mode === "partial" ? "choice-card-active" : ""}`}><input type="radio" checked={mode === "partial"} onChange={() => setMode("partial")} /><span><strong>Pallet lẻ</strong><small>Nhập số lượng thực tế</small></span></label>
        </div>
        <label>Số lượng<input type="number" min="1" disabled={mode === "full"} value={mode === "full" ? selectedRow.quantity_per_pallet ?? "" : quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <div className="modal-actions"><button className="button button-secondary" onClick={closeDialog}>Hủy</button><button className="button button-primary" disabled={pending} onClick={savePallet}>{pending ? "Đang lưu..." : "Xác nhận & lưu"}</button></div>
      </> : null}

      {dialog === "created" ? <>
        {message ? <FeedbackAlert message={message} /> : null}
        <div className="modal-actions"><button className="button button-primary" disabled={pending} onClick={closeDialog}>{pending ? "Đang in..." : "Đóng"}</button></div>
      </> : null}

      {dialog === "history" ? <>
        <div className="form-grid pallet-search-grid">
          <label>Tìm theo WO<input value={searchWo} onChange={(event) => setSearchWo(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") loadPallets(); }} placeholder="Nhập WO" /></label>
          <label>Tìm theo Itemcode<input value={searchItem} onChange={(event) => setSearchItem(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") loadPallets(); }} placeholder="Nhập Itemcode" /></label>
          <div className="pallet-search-actions">
            <button className="button button-primary" disabled={searching} onClick={() => loadPallets()}>{searching ? "Đang tìm..." : "Tìm kiếm"}</button>
            <button className="button button-secondary" disabled={searching} onClick={() => { setSearchWo(""); setSearchItem(""); loadPallets("", "", 1); }}>1 ngày</button>
            <button className="button button-secondary" disabled={searching} onClick={() => { setSearchWo(""); setSearchItem(""); loadPallets("", "", 7); }}>7 ngày</button>
            <button className="button button-secondary" disabled={searching} onClick={() => { setSearchWo(""); setSearchItem(""); loadPallets("", "", 30); }}>30 ngày</button>
          </div>
        </div>
        <p className="muted small">Đang xem dữ liệu {historyDays} ngày gần nhất khi không nhập WO hoặc Itemcode.</p>
        <div className="table-wrap"><table><thead><tr><th>Pallet ID</th><th>WO</th><th>Itemcode</th><th>Số lượng</th><th>Status</th><th>Ngày tạo</th><th>Thao tác</th></tr></thead><tbody>
          {historyPallets.length ? historyPallets.map((pallet) => <tr key={`${pallet.pallet_id}-${pallet.created_at}`}><td><strong>{pallet.pallet_id}</strong></td><td>{pallet.wo}</td><td>{pallet.itemcode}</td><td>{formatNumber(pallet.quantity)}</td><td>{pallet.status}</td><td>{new Date(pallet.created_at).toLocaleString("vi-VN")}</td><td><div className="action-row">
            <button className="button button-secondary button-small" disabled={pallet.status !== "production"} title={pallet.status !== "production" ? "Chỉ sửa được pallet trạng thái production" : undefined} onClick={() => openEdit(pallet)}>Sửa</button>
            <button className="button button-secondary button-small" disabled={pending || pallet.status !== "production"} title={pallet.status !== "production" ? "Chỉ xóa được pallet trạng thái production" : undefined} onClick={() => openDelete(pallet)}>Xóa</button>
            <button className="button button-primary button-small" disabled={pending || reprintingPalletId !== null} onClick={() => void printPallet(pallet.pallet_id)}>{reprintingPalletId === pallet.pallet_id ? "Đang gửi..." : "In lại"}</button>
          </div></td></tr>) : <tr><td colSpan={7}>Không tìm thấy pallet phù hợp.</td></tr>}
        </tbody></table></div>
      </> : null}

      {dialog === "edit" && selectedPallet ? <>
        <div className="pallet-summary"><div><span>Pallet ID</span><strong>{selectedPallet.pallet_id}</strong></div><div><span>Số lượng hiện tại</span><strong>{formatNumber(selectedPallet.quantity)}</strong></div></div>
        <label>Số lượng mới<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Lý do sửa<textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Nhập lý do thay đổi số lượng pallet" /></label>
        <div className="modal-actions"><button className="button button-secondary" onClick={() => { setDialog("history"); setReason(""); }}>Quay lại</button><button className="button button-primary" disabled={pending || !reason.trim()} onClick={editPallet}>{pending ? "Đang lưu..." : "Lưu sửa đổi"}</button></div>
      </> : null}

      {dialog === "delete" && selectedPallet ? <>
        <div className="pallet-summary"><div><span>Pallet ID</span><strong>{selectedPallet.pallet_id}</strong></div><div><span>Số lượng</span><strong>{formatNumber(selectedPallet.quantity)}</strong></div></div>
        <p className="muted">Pallet sẽ bị xóa hiệu lực nhưng dữ liệu gốc và lịch sử vẫn được giữ lại.</p>
        <label>Lý do xóa<textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Nhập lý do xóa pallet" /></label>
        <div className="modal-actions"><button className="button button-secondary" onClick={() => { setDialog("history"); setReason(""); }}>Không xóa</button><button className="button button-danger" disabled={pending || !reason.trim()} onClick={deletePallet}>{pending ? "Đang xóa..." : "Xác nhận xóa"}</button></div>
      </> : null}

      {dialog === "merge" ? <>
        <div className="form-grid"><label>WO thứ nhất<input list="wo-options" value={wo1} onChange={(event) => setWo1(event.target.value)} /></label><label>WO thứ hai<input list="wo-options" value={wo2} onChange={(event) => setWo2(event.target.value)} /></label><label className="form-full">Số lượng<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label></div>
        <datalist id="wo-options">{allWos.map((wo) => <option value={wo} key={wo} />)}</datalist>
        <p className="muted small">Pallet mới lấy toàn bộ thông tin của WO thứ nhất. Note lưu: merge: WO1 + WO2.</p>
        <div className="modal-actions"><button className="button button-secondary" onClick={closeDialog}>Hủy</button><button className="button button-primary" disabled={pending} onClick={mergePallet}>Xác nhận gộp</button></div>
      </> : null}

      {dialog !== "created" && message ? <FeedbackAlert message={message} /> : null}
    </div></div> : null}
  </>;
}
