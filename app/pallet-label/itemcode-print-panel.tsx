"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ItemcodeCatalog, ItemcodeWorkOrder } from "@/lib/pallet-label/itemcode-print";

type Props = {
  disabled: boolean;
  onReset: () => void;
  onSelectWo: (wo: string, itemcode: string) => void;
  onBusyChange: (busy: boolean) => void;
};

function number(value: number | null) {
  return value === null ? "—" : value.toLocaleString("vi-VN");
}

function Progress({ value, total }: { value: number; total: number | null }) {
  const percent = total && total > 0 ? value / total * 100 : null;
  return <div className="old-wo-progress">
    <div className="old-wo-progress-copy"><strong>{number(value)}</strong><span>/ {number(total)}</span><small>{percent === null ? "Chưa có order" : `${Math.round(percent)}%`}</small></div>
    <div className="quantity-progress-track" aria-hidden="true"><span style={{ width: `${Math.min(Math.max(percent ?? 0, 0), 100)}%` }} /></div>
  </div>;
}

export function ItemcodePrintPanel({ disabled, onReset, onSelectWo, onBusyChange }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [workOrders, setWorkOrders] = useState<ItemcodeWorkOrder[]>([]);
  const [selectedWo, setSelectedWo] = useState("");
  const [item, setItem] = useState<ItemcodeCatalog | null>(null);
  const [searching, setSearching] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [wo, setWo] = useState("");
  const [workingDay, setWorkingDay] = useState("");
  const [quantity, setQuantity] = useState("");
  const [orderQuantity, setOrderQuantity] = useState("");
  const lookup = useRef<AbortController | null>(null);
  const submitting = useRef(false);

  useEffect(() => () => lookup.current?.abort(), []);

  function clearLookup() {
    lookup.current?.abort();
    setSearching(false);
    setWorkOrders([]);
    setSelectedWo("");
    setItem(null);
    setMessage(null);
    setWo(""); setWorkingDay(""); setQuantity(""); setOrderQuantity("");
    onReset();
  }

  async function searchItem(event: FormEvent) {
    event.preventDefault();
    if (printing || disabled) return;
    clearLookup();
    const controller = new AbortController();
    lookup.current = controller;
    setSearching(true);
    try {
      const response = await fetch(`/api/pallet-label/old-itemcode?${new URLSearchParams({ itemcode: search.trim() })}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể tra cứu itemcode.");
      setSearch(result.itemcode);
      setWorkOrders(result.workOrders);
      setItem(result.item);
    } catch (error) {
      if (!controller.signal.aborted) setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể tra cứu itemcode." });
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  async function printItem(event: FormEvent) {
    event.preventDefault();
    if (!item || submitting.current || disabled) return;
    const qty = Number(quantity), total = Number(orderQuantity);
    if (!wo.trim() || wo.trim().length > 120 || !workingDay || !Number.isInteger(qty) || qty <= 0 || qty > 2147483647 || !Number.isFinite(total) || total <= 0) {
      setMessage({ type: "error", text: "Vui lòng nhập đầy đủ WO, ngày sản xuất, số lượng và số lượng đơn hàng hợp lệ." });
      return;
    }
    const pdfWindow = window.open("", "_blank");
    submitting.current = true;
    setPrinting(true); onBusyChange(true); setMessage(null);
    try {
      const response = await fetch("/api/pallet-label/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "old-itemcode", itemcode: item.itemcode, wo: wo.trim(), working_day: workingDay, quantity: qty, quanorder: total }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error ?? "Không thể tạo tem pallet.");
      const pdfUrl = `/api/pallet-label/pdf?palletId=${encodeURIComponent(result.pallet.pallet_id)}`;
      if (pdfWindow) pdfWindow.location.href = pdfUrl;
      else window.location.href = pdfUrl;
      setMessage({ type: "success", text: `Đã tạo pallet ${result.pallet.pallet_id}. File PDF đã được mở.` });
      // The item now has a WO: continue with the existing history/reprint flow.
      setWorkOrders([{
        ...item, wo: wo.trim(), machine: "", quanorder: total,
        produced_quantity: qty, warehouse_quantity: 0, pallet_count: 1, last_created_at: result.pallet.created_at,
      }]);
      setItem(null);
      setSelectedWo(wo.trim());
      onSelectWo(wo.trim(), item.itemcode);
      router.refresh();
    } catch (error) {
      pdfWindow?.close();
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không thể tạo tem pallet." });
    } finally {
      submitting.current = false;
      setPrinting(false); onBusyChange(false);
    }
  }

  return <section aria-label="In tem theo itemcode">
    <form className="old-wo-search" onSubmit={(event) => void searchItem(event)}>
      <label><span>Itemcode</span><input autoFocus required maxLength={200} disabled={printing} value={search} onChange={(event) => { setSearch(event.target.value); clearLookup(); }} placeholder="Nhập chính xác itemcode" /></label>
      <button className="button button-primary" disabled={searching || printing || disabled} type="submit">{searching ? "Đang tìm..." : "Tìm kiếm"}</button>
    </form>
    {message ? <p role="status" className={`alert alert-${message.type}`}>{message.text}</p> : null}
    {workOrders.length ? <>
      <p className="muted">Các WO đã có của itemcode. Chọn WO để xem pallet, in lại hoặc in bù tem.</p>
      <div className="old-wo-item-table-wrap"><table className="old-wo-item-table">
        <thead><tr><th>WO</th><th>Tên sản phẩm</th><th>Khách hàng</th><th>SL đơn hàng</th><th>Đã sản xuất</th><th>Đã nhập kho</th><th>Thao tác</th></tr></thead>
        <tbody>{workOrders.map((row) => <tr key={row.wo} className={selectedWo === row.wo ? "old-wo-selected-row" : undefined}>
          <td><strong>{row.wo}</strong></td><td>{row.product_name || "—"}</td><td>{row.customer || "—"}</td><td>{number(row.quanorder)}</td>
          <td><Progress value={row.produced_quantity} total={row.quanorder} /></td><td><Progress value={row.warehouse_quantity} total={row.quanorder} /></td>
          <td><button aria-pressed={selectedWo === row.wo} className="button button-primary button-small" disabled={disabled || printing} onClick={() => { setSelectedWo(row.wo); onSelectWo(row.wo, row.itemcode); }} type="button">{selectedWo === row.wo ? "Đã chọn" : "Chọn WO"}</button></td>
        </tr>)}</tbody>
      </table></div>
    </> : null}
    {item ? <>
      <p className="muted">Chưa có WO trong dữ liệu pallet. Nhập thông tin bên dưới để tạo tem.</p>
      <div className="old-wo-info-grid">
        <div className="old-wo-info-item"><span>Itemcode</span><strong>{item.itemcode}</strong></div>
        <div className="old-wo-info-item old-wo-info-item-product"><span>Tên sản phẩm</span><strong>{item.product_name}</strong></div>
        <div className="old-wo-info-item"><span>Khách hàng</span><strong>{item.customer}</strong></div>
      </div>
      <form onSubmit={(event) => void printItem(event)}>
        <fieldset className="old-wo-item-fields" disabled={printing || disabled}>
          <label>WO *<input required maxLength={120} value={wo} onChange={(event) => setWo(event.target.value)} /></label>
          <label>Ngày sản xuất *<input required type="date" value={workingDay} onChange={(event) => setWorkingDay(event.target.value)} /></label>
          <label>Số lượng trên tem *<input required type="number" min="1" max="2147483647" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label>Số lượng đơn hàng *<input required type="number" min="0.000001" step="any" value={orderQuantity} onChange={(event) => setOrderQuantity(event.target.value)} /></label>
        </fieldset>
        {Number(orderQuantity) > 0 && Number(quantity) > Number(orderQuantity) ? <p role="alert" className="alert alert-error">Đã vượt số lượng WO, hãy xác nhận kĩ</p> : null}
        <div className="modal-actions"><button className="button button-primary" disabled={printing || disabled} type="submit">{printing ? "Đang tạo tem..." : "Xác nhận & in tem"}</button></div>
      </form>
    </> : null}
    {!searching && !message && !item && !workOrders.length ? <div className="old-wo-empty">Nhập itemcode để tìm WO đã in hoặc tạo tem từ thông tin cấu hình.</div> : null}
  </section>;
}
