"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PlanItem = {
  machine: string; itemcode: string; product_name: string; customer: string; wo: string;
  quanorder: number | null; produced_quantity: number; warehouse_quantity: number; quantity_per_pallet: number | null;
};
export type ActivePallet = {
  pallet_id: string; itemcode: string; product_name: string | null; customer: string | null; wo: string;
  quanorder: number | null; machine: string | null; quantity: number; status: string; note: string | null; created_at: string;
};
type Props = { rows: PlanItem[]; pallets: ActivePallet[] };
type Mode = "full" | "partial";
type Dialog = "create" | "features" | "edit" | "merge" | null;

function formatNumber(value: number | null) { return value === null ? "—" : Number(value).toLocaleString("vi-VN"); }
function QuantityProgress({ value, total }: { value: number; total: number | null }) {
  const validTotal = total !== null && total > 0; const percent = validTotal ? (value / total) * 100 : 0;
  return <div className="quantity-progress"><div className="quantity-progress-label"><strong>{formatNumber(value)}</strong><span>/ {formatNumber(total)}</span></div><div className="quantity-progress-track"><span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} /></div><small>{validTotal ? `${Math.round(percent)}%` : "Chưa có order"}</small></div>;
}

export function PalletLabelClient({ rows, pallets: initialPallets }: Props) {
  const router = useRouter();
  const validRows = useMemo(() => rows.filter((r) => r.wo.trim() !== "" && r.wo.trim() !== "0"), [rows]);
  const machines = useMemo(() => Array.from(new Set(validRows.map((r) => r.machine))).sort((a, b) => a.localeCompare(b, "vi")), [validRows]);
  const allWos = useMemo(() => Array.from(new Set(validRows.map((r) => r.wo))).sort((a, b) => a.localeCompare(b, "vi")), [validRows]);
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<PlanItem | null>(null);
  const [selectedPallet, setSelectedPallet] = useState<ActivePallet | null>(null);
  const [featurePallets, setFeaturePallets] = useState<ActivePallet[]>(initialPallets);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<Mode>("full");
  const [quantity, setQuantity] = useState(""); const [wo1, setWo1] = useState(""); const [wo2, setWo2] = useState("");
  const [searchWo, setSearchWo] = useState(""); const [searchItem, setSearchItem] = useState("");
  const [pending, setPending] = useState(false); const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const visibleRows = selectedMachine ? validRows.filter((r) => r.machine === selectedMachine) : [];

  function selectMachine(machine: string) {
    setSelectedMachine((current) => current === machine ? null : machine);
  }

  function closeDialog() { if (pending) return; setDialog(null); setSelectedPallet(null); setMessage(null); setQuantity(""); }
  function openCreate(row: PlanItem) { setSelectedRow(row); setMode("full"); setQuantity(""); setMessage(null); setDialog("create"); }
  async function openFeatures(row?: PlanItem) {
    setSelectedRow(row ?? null); setSearchWo(row?.wo ?? ""); setSearchItem(row?.itemcode ?? ""); setMessage(null); setDialog("features");
    await loadPallets(row?.wo ?? "", row?.itemcode ?? "");
  }
  async function loadPallets(wo = searchWo, itemcode = searchItem) {
    setSearching(true); setMessage(null);
    try {
      const params = new URLSearchParams(); if (wo.trim()) params.set("wo", wo.trim()); if (itemcode.trim()) params.set("itemcode", itemcode.trim());
      const response = await fetch(`/api/pallet-label/search?${params.toString()}`, { cache: "no-store" }); const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể tải danh sách pallet.");
      setFeaturePallets(result.pallets);
    } catch (e) { setMessage({ type: "error", text: e instanceof Error ? e.message : "Không thể tải danh sách pallet." }); }
    finally { setSearching(false); }
  }
  async function postAction(body: Record<string, unknown>) { const response = await fetch("/api/pallet-label/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể thực hiện thao tác."); return result; }
  async function savePallet() {
    if (!selectedRow) return; const finalQuantity = mode === "full" ? selectedRow.quantity_per_pallet : Number(quantity);
    if (!finalQuantity || !Number.isInteger(finalQuantity) || finalQuantity <= 0) { setMessage({ type: "error", text: "Vui lòng nhập số lượng hợp lệ." }); return; }
    const pdfWindow = window.open("", "_blank"); setPending(true);
    try { const response = await fetch("/api/pallet-label/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...selectedRow, quantity: finalQuantity }) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể lưu pallet."); const pdfUrl = `/api/pallet-label/pdf?palletId=${encodeURIComponent(result.pallet.pallet_id)}`; if (pdfWindow) pdfWindow.location.href = pdfUrl; else window.location.href = pdfUrl; setMessage({ type: "success", text: `Đã tạo ${result.pallet.pallet_id} và mở PDF.` }); router.refresh(); }
    catch (e) { pdfWindow?.close(); setMessage({ type: "error", text: e instanceof Error ? e.message : "Không thể lưu pallet." }); } finally { setPending(false); }
  }
  async function editPallet() { if (!selectedPallet) return; const newQuantity = Number(quantity); if (!Number.isInteger(newQuantity) || newQuantity <= 0) { setMessage({ type: "error", text: "Số lượng không hợp lệ." }); return; } setPending(true); try { await postAction({ action: "edit", pallet_id: selectedPallet.pallet_id, quantity: newQuantity }); setMessage({ type: "success", text: `Đã sửa ${selectedPallet.pallet_id}.` }); await loadPallets(); setDialog("features"); setSelectedPallet(null); router.refresh(); } catch (e) { setMessage({ type: "error", text: e instanceof Error ? e.message : "Không thể sửa pallet." }); } finally { setPending(false); } }
  async function deletePallet(pallet: ActivePallet) { if (!window.confirm(`Xóa hiệu lực pallet ${pallet.pallet_id}?`)) return; setPending(true); try { await postAction({ action: "delete", pallet_id: pallet.pallet_id }); setMessage({ type: "success", text: `Đã xóa hiệu lực ${pallet.pallet_id}.` }); await loadPallets(); router.refresh(); } catch (e) { setMessage({ type: "error", text: e instanceof Error ? e.message : "Không thể xóa pallet." }); } finally { setPending(false); } }
  async function mergePallet() { const mergeQuantity = Number(quantity); if (!wo1 || !wo2 || wo1 === wo2 || !Number.isInteger(mergeQuantity) || mergeQuantity <= 0) { setMessage({ type: "error", text: "Chọn 2 WO khác nhau và nhập số lượng hợp lệ." }); return; } setPending(true); try { const result = await postAction({ action: "merge", wo1, wo2, quantity: mergeQuantity }); setMessage({ type: "success", text: `Đã tạo ${result.pallet.pallet_id}; dữ liệu lấy từ ${wo1}.` }); router.refresh(); } catch (e) { setMessage({ type: "error", text: e instanceof Error ? e.message : "Không thể gộp pallet." }); } finally { setPending(false); } }
  function printPallet(palletId: string) { window.open(`/api/pallet-label/pdf?palletId=${encodeURIComponent(palletId)}`, "_blank", "noopener,noreferrer"); }

  return <>
    <div className="feature-toolbar pallet-main-toolbar"><button className="button button-secondary" onClick={() => openFeatures()}>Tính năng pallet</button><button className="button button-primary" onClick={() => { setWo1(""); setWo2(""); setQuantity(""); setDialog("merge"); }}>Gộp WO</button></div>
    <div className="machine-grid">
      {machines.map((machine) => {
        const active = machine === selectedMachine;
        const machineRows = validRows.filter((r) => r.machine === machine);
        const woCount = new Set(machineRows.map((r) => r.wo)).size;
        return <div className="machine-grid-item" key={machine}>
          <button type="button" className={`machine-card machine-card-simple ${active ? "machine-card-active" : ""}`} onClick={() => selectMachine(machine)}>
            <span className="machine-icon machine-icon-large">🏭</span>
            <span className="machine-card-copy"><strong>{machine}</strong><small>{woCount} WO</small></span>
          </button>
          {active ? <section className="panel pallet-table-panel machine-detail-panel"><div className="section-heading"><div><p className="eyebrow">MACHINE</p><h2>{machine}</h2></div></div><div className="table-wrap"><table className="pallet-table"><thead><tr><th>In tem</th><th>Itemcode</th><th>WO</th><th>Product name</th><th>Customer</th><th>Quan order</th><th>Đã chạy</th><th>Đã nhập kho</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={`${row.machine}-${row.wo}-${row.itemcode}`}><td><button className="button button-primary button-small" onClick={() => openCreate(row)}>In tem</button></td><td><strong>{row.itemcode}</strong></td><td><span className="badge">{row.wo}</span></td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td>{formatNumber(row.quanorder)}</td><td><QuantityProgress value={row.produced_quantity} total={row.quanorder} /></td><td><QuantityProgress value={row.warehouse_quantity} total={row.quanorder} /></td></tr>)}</tbody></table></div></section> : null}
        </div>;
      })}
    </div>

    {dialog ? <div className="modal-backdrop" onMouseDown={closeDialog}><div className="modal-card modal-card-wide" onMouseDown={(e) => e.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">PALLET</p><h2>{dialog === "merge" ? "Gộp WO" : selectedRow ? `${selectedRow.wo} · ${selectedRow.itemcode}` : "Tính năng pallet"}</h2></div><button className="modal-close" onClick={closeDialog}>×</button></div>
      {dialog === "create" && selectedRow ? <><div className="pallet-choice-grid"><label className={`choice-card ${mode === "full" ? "choice-card-active" : ""}`}><input type="radio" checked={mode === "full"} onChange={() => setMode("full")} /><span><strong>Pallet chẵn</strong><small>Lấy số lượng chuẩn</small></span></label><label className={`choice-card ${mode === "partial" ? "choice-card-active" : ""}`}><input type="radio" checked={mode === "partial"} onChange={() => setMode("partial")} /><span><strong>Pallet lẻ</strong><small>Nhập số lượng thực tế</small></span></label></div><label>Số lượng<input type="number" min="1" disabled={mode === "full"} value={mode === "full" ? selectedRow.quantity_per_pallet ?? "" : quantity} onChange={(e) => setQuantity(e.target.value)} /></label><div className="modal-actions"><button className="button button-secondary" onClick={closeDialog}>Hủy</button><button className="button button-primary" disabled={pending} onClick={savePallet}>{pending ? "Đang lưu..." : "Xác nhận & lưu"}</button></div></> : null}
      {dialog === "features" ? <><div className="form-grid pallet-search-grid"><label>Tìm theo WO<input value={searchWo} onChange={(e) => setSearchWo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadPallets(); }} placeholder="Nhập WO" /></label><label>Tìm theo Itemcode<input value={searchItem} onChange={(e) => setSearchItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadPallets(); }} placeholder="Nhập Itemcode" /></label><div className="pallet-search-actions"><button className="button button-primary" disabled={searching} onClick={() => loadPallets()}>{searching ? "Đang tìm..." : "Tìm kiếm"}</button><button className="button button-secondary" onClick={() => { setSearchWo(""); setSearchItem(""); loadPallets("", ""); }}>1 ngày gần nhất</button></div></div><p className="muted small">Không nhập điều kiện: hiển thị pallet được tạo trong 24 giờ gần nhất.</p><div className="table-wrap"><table><thead><tr><th>Pallet ID</th><th>WO</th><th>Itemcode</th><th>Số lượng</th><th>Status</th><th>Ngày tạo</th><th>Thao tác</th></tr></thead><tbody>{featurePallets.length ? featurePallets.map((p) => <tr key={`${p.pallet_id}-${p.created_at}`}><td><strong>{p.pallet_id}</strong></td><td>{p.wo}</td><td>{p.itemcode}</td><td>{formatNumber(p.quantity)}</td><td>{p.status}</td><td>{new Date(p.created_at).toLocaleString("vi-VN")}</td><td><div className="action-row"><button className="button button-secondary button-small" disabled={p.status !== "production"} title={p.status !== "production" ? "Chỉ sửa được pallet trạng thái production" : undefined} onClick={() => { setSelectedPallet(p); setQuantity(String(p.quantity)); setDialog("edit"); }}>Sửa</button><button className="button button-secondary button-small" disabled={pending || p.status !== "production"} title={p.status !== "production" ? "Chỉ xóa được pallet trạng thái production" : undefined} onClick={() => deletePallet(p)}>Xóa</button><button className="button button-primary button-small" onClick={() => printPallet(p.pallet_id)}>In lại</button></div></td></tr>) : <tr><td colSpan={7}>Không tìm thấy pallet phù hợp.</td></tr>}</tbody></table></div></> : null}
      {dialog === "edit" && selectedPallet ? <><div className="pallet-summary"><div><span>Pallet ID</span><strong>{selectedPallet.pallet_id}</strong></div><div><span>Số lượng hiện tại</span><strong>{formatNumber(selectedPallet.quantity)}</strong></div></div><label>Số lượng mới<input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setDialog("features")}>Quay lại</button><button className="button button-primary" disabled={pending} onClick={editPallet}>Lưu sửa đổi</button></div></> : null}
      {dialog === "merge" ? <><div className="form-grid"><label>WO thứ nhất<input list="wo-options" value={wo1} onChange={(e) => setWo1(e.target.value)} /></label><label>WO thứ hai<input list="wo-options" value={wo2} onChange={(e) => setWo2(e.target.value)} /></label><label className="form-full">Số lượng<input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label></div><datalist id="wo-options">{allWos.map((wo) => <option value={wo} key={wo} />)}</datalist><p className="muted small">Pallet mới lấy toàn bộ thông tin của WO thứ nhất. Note lưu: merge: WO1 + WO2.</p><div className="modal-actions"><button className="button button-secondary" onClick={closeDialog}>Hủy</button><button className="button button-primary" disabled={pending} onClick={mergePallet}>Xác nhận gộp</button></div></> : null}
      {message ? <p className={`alert alert-${message.type}`}>{message.text}</p> : null}
    </div></div> : null}
  </>;
}
