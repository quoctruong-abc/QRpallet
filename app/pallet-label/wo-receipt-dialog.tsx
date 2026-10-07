"use client";

import { Fragment, useMemo, useState, type MouseEvent } from "react";

type SearchMode = "wo" | "item";

type WoReceiptPallet = {
  wo: string;
  pallet_id: string;
  itemcode: string;
  product_name: string;
  quantity: number;
  working_day: string | null;
  created_at: string;
};

type WoItemSummary = {
  wo: string;
  totalQuantity: number;
  palletCount: number;
  firstWorkingDay: string | null;
  lastWorkingDay: string | null;
};

type SearchResult = {
  success?: boolean;
  error?: string;
  requestedWos?: string[];
  requestedItemcode?: string;
  missingWos?: string[];
  pallets?: WoReceiptPallet[];
  woSummaries?: WoItemSummary[];
};

type Props = {
  onClose: () => void;
};

const MAX_ITEM_WO_SELECTION = 5;

const vietnamDateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parseWorkOrders(value: string) {
  const unique = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const wo = line.trim().toLocaleUpperCase("en-US");
    if (!wo) continue;
    if (!unique.has(wo)) unique.set(wo, wo);
  }
  return Array.from(unique.values());
}

function formatNumber(value: number) {
  return Number(value).toLocaleString("vi-VN");
}

function formatWorkingDay(value: string | null) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : vietnamDateTimeFormatter.format(date);
}

export function WoReceiptDialog({ onClose }: Props) {
  const [mode, setMode] = useState<SearchMode>("wo");
  const [woInput, setWoInput] = useState("");
  const [itemInput, setItemInput] = useState("");
  const [itemSearched, setItemSearched] = useState(false);
  const [itemSummaries, setItemSummaries] = useState<WoItemSummary[]>([]);
  const [selectedItemWos, setSelectedItemWos] = useState<string[]>([]);
  const [requestedWos, setRequestedWos] = useState<string[]>([]);
  const [missingWos, setMissingWos] = useState<string[]>([]);
  const [pallets, setPallets] = useState<WoReceiptPallet[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const palletGroups = useMemo(() => {
    const groups = new Map<string, WoReceiptPallet[]>();
    for (const pallet of pallets) {
      const group = groups.get(pallet.wo) ?? [];
      group.push(pallet);
      groups.set(pallet.wo, group);
    }
    return Array.from(groups, ([wo, rows]) => ({
      wo,
      pallets: rows,
      totalQuantity: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    }));
  }, [pallets]);

  function clearPalletResults() {
    setRequestedWos([]);
    setMissingWos([]);
    setPallets([]);
    setSearched(false);
  }

  function changeMode(nextMode: SearchMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setItemSearched(false);
    setItemSummaries([]);
    setSelectedItemWos([]);
    clearPalletResults();
    setMessage(null);
  }

  async function loadPallets(wos: string[]) {
    if (!wos.length) return;
    setSearching(true);
    clearPalletResults();
    setMessage(null);

    try {
      const response = await fetch("/api/pallet-label/wo-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "search", wos }),
      });
      const result = await response.json().catch(() => null) as SearchResult | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.error ?? "Không thể tải dữ liệu WO receipt.");
      }

      setRequestedWos(result.requestedWos ?? wos);
      setMissingWos(result.missingWos ?? []);
      setPallets(result.pallets ?? []);
      setSearched(true);
    } catch (error) {
      setSearched(true);
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể tải dữ liệu WO receipt.",
      });
    } finally {
      setSearching(false);
    }
  }

  async function searchWorkOrders() {
    const wos = parseWorkOrders(woInput);
    if (!wos.length) {
      setMessage({ type: "error", text: "Vui lòng nhập ít nhất một WO, mỗi WO trên một dòng." });
      return;
    }
    await loadPallets(wos);
  }

  async function searchItem() {
    const itemcode = itemInput.trim().toLocaleUpperCase("en-US");
    if (!itemcode) {
      setMessage({ type: "error", text: "Vui lòng nhập itemcode." });
      return;
    }

    setSearching(true);
    setItemSearched(false);
    setItemSummaries([]);
    setSelectedItemWos([]);
    clearPalletResults();
    setMessage(null);

    try {
      const response = await fetch("/api/pallet-label/wo-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "search-item", itemcode }),
      });
      const result = await response.json().catch(() => null) as SearchResult | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.error ?? "Không thể tải danh sách WO theo item.");
      }

      setItemInput(result.requestedItemcode ?? itemcode);
      setItemSummaries(result.woSummaries ?? []);
      setItemSearched(true);
    } catch (error) {
      setItemSearched(true);
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể tải danh sách WO theo item.",
      });
    } finally {
      setSearching(false);
    }
  }

  function toggleItemWo(wo: string) {
    if (selectedItemWos.includes(wo)) {
      setSelectedItemWos((current) => current.filter((value) => value !== wo));
      clearPalletResults();
      setMessage(null);
      return;
    }
    if (selectedItemWos.length >= MAX_ITEM_WO_SELECTION) {
      setMessage({ type: "error", text: `Chỉ được chọn tối đa ${MAX_ITEM_WO_SELECTION} WO.` });
      return;
    }
    setSelectedItemWos((current) => [...current, wo]);
    clearPalletResults();
    setMessage(null);
  }

  async function printReceipt() {
    if (!requestedWos.length || !pallets.length) return;
    const pdfWindow = window.open("", "_blank");
    setPrinting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/pallet-label/wo-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pdf", wos: requestedWos }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => null) as SearchResult | null;
        throw new Error(result?.error ?? "Không thể tạo PDF WO receipt.");
      }

      const pdfBlob = await response.blob();
      const pdfUrl = URL.createObjectURL(pdfBlob);
      if (pdfWindow) {
        pdfWindow.location.href = pdfUrl;
      } else {
        window.location.href = pdfUrl;
      }
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
      setMessage({ type: "success", text: "Đã tạo PDF WO receipt." });
    } catch (error) {
      pdfWindow?.close();
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Không thể tạo PDF WO receipt.",
      });
    } finally {
      setPrinting(false);
    }
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !searching && !printing) onClose();
  }

  return (
    <div className="modal-backdrop wo-receipt-backdrop" onMouseDown={handleBackdropMouseDown}>
      <style>{`
        .wo-receipt-backdrop { z-index: 1060; }
        .wo-receipt-modal { width: min(1240px, calc(100% - 24px)); max-height: 92vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; }
        .wo-receipt-controls { margin-bottom: 14px; }
        .wo-receipt-modes { display: inline-grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 12px; padding: 4px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .wo-receipt-mode { min-width: 130px; padding: 8px 14px; border: 0; border-radius: 9px; color: var(--muted); background: transparent; font: inherit; font-weight: 800; cursor: pointer; }
        .wo-receipt-mode-active { color: #fff; background: var(--primary); box-shadow: 0 1px 3px rgba(16, 24, 40, .15); }
        .wo-receipt-search { display: grid; grid-template-columns: minmax(280px, 1fr) auto; gap: 12px; align-items: end; }
        .wo-receipt-search label { display: grid; gap: 6px; }
        .wo-receipt-search label > span { color: var(--muted); font-size: .76rem; font-weight: 850; letter-spacing: .04em; text-transform: uppercase; }
        .wo-receipt-search textarea { width: 100%; min-height: 112px; padding: 10px 12px; resize: vertical; border: 1px solid #d0d5dd; border-radius: 10px; outline: none; color: var(--text); background: #fff; font: inherit; }
        .wo-receipt-search textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(21, 94, 239, .12); }
        .wo-receipt-search-actions { display: grid; gap: 8px; }
        .wo-receipt-result { min-height: 0; overflow: auto; }
        .wo-receipt-summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: #f8fafc; }
        .wo-receipt-summary-copy { display: flex; gap: 18px; flex-wrap: wrap; color: var(--muted); }
        .wo-receipt-summary-copy strong { color: var(--text); }
        .wo-receipt-missing { margin: 0 0 10px; padding: 9px 12px; border: 1px solid #fedf89; border-radius: 10px; color: #93370d; background: #fffaeb; overflow-wrap: anywhere; }
        .wo-receipt-item-panel { margin-bottom: 14px; }
        .wo-receipt-item-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
        .wo-receipt-item-heading p { margin: 0; color: var(--muted); }
        .wo-receipt-item-table-wrap, .wo-receipt-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
        .wo-receipt-item-table-wrap { max-height: 260px; }
        .wo-receipt-table-wrap { max-height: 440px; }
        .wo-receipt-item-table { min-width: 760px; margin: 0; }
        .wo-receipt-table { min-width: 1120px; margin: 0; }
        .wo-receipt-item-table thead, .wo-receipt-table thead { position: sticky; top: 0; z-index: 1; }
        .wo-receipt-item-table th, .wo-receipt-table th { background: #f2f4f7; }
        .wo-receipt-item-table td, .wo-receipt-table td { vertical-align: top; }
        .wo-receipt-check { width: 52px; text-align: center; }
        .wo-receipt-check input { width: 18px; height: 18px; cursor: pointer; }
        .wo-receipt-product { min-width: 240px; white-space: normal; }
        .wo-receipt-subtotal td { font-weight: 850; background: #eef4fb; border-top: 2px solid #98a2b3; }
        .wo-receipt-subtotal-label { text-align: right; }
        .wo-receipt-empty { padding: 38px 16px; color: var(--muted); text-align: center; }
        .wo-receipt-footer { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
        @media (max-width: 720px) {
          .wo-receipt-modal { max-height: 94vh; padding: 18px; }
          .wo-receipt-modes { display: grid; }
          .wo-receipt-mode { min-width: 0; }
          .wo-receipt-search { grid-template-columns: 1fr; }
          .wo-receipt-search-actions .button { width: 100%; }
          .wo-receipt-summary .button, .wo-receipt-item-heading .button { width: 100%; }
          .wo-receipt-footer .button { flex: 1; }
        }
      `}</style>

      <div className="modal-card wo-receipt-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><p className="eyebrow">PALLET</p><h2>In WO receipt</h2></div>
          <button className="modal-close" disabled={searching || printing} onClick={onClose} type="button">×</button>
        </div>

        <div className="wo-receipt-controls">
          <div className="wo-receipt-modes" role="tablist" aria-label="Chế độ tìm kiếm">
            <button className={`wo-receipt-mode ${mode === "wo" ? "wo-receipt-mode-active" : ""}`} disabled={searching || printing} onClick={() => changeMode("wo")} role="tab" aria-selected={mode === "wo"} type="button">Theo WO</button>
            <button className={`wo-receipt-mode ${mode === "item" ? "wo-receipt-mode-active" : ""}`} disabled={searching || printing} onClick={() => changeMode("item")} role="tab" aria-selected={mode === "item"} type="button">Theo item</button>
          </div>

          {mode === "wo" ? <div className="wo-receipt-search">
            <label>
              <span>Danh sách WO</span>
              <textarea
                autoFocus
                value={woInput}
                onChange={(event) => setWoInput(event.target.value)}
                placeholder={'Nhập mỗi WO trên một dòng\nVí dụ:\nWO260001\nWO260002'}
              />
            </label>
            <div className="wo-receipt-search-actions">
              <button className="button button-primary" disabled={searching || printing} onClick={() => void searchWorkOrders()} type="button">
                {searching ? "Đang tìm..." : "Tìm kiếm"}
              </button>
            </div>
          </div> : <div className="wo-receipt-search">
            <label>
              <span>Itemcode</span>
              <input
                autoFocus
                value={itemInput}
                onChange={(event) => setItemInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void searchItem(); }}
                placeholder="Nhập itemcode"
              />
            </label>
            <div className="wo-receipt-search-actions">
              <button className="button button-primary" disabled={searching || printing} onClick={() => void searchItem()} type="button">
                {searching ? "Đang tìm..." : "Tìm item"}
              </button>
            </div>
          </div>}
        </div>

        <div className="wo-receipt-result">
          {message ? <p className={`alert alert-${message.type}`}>{message.text}</p> : null}

          {mode === "item" && itemSearched ? <div className="wo-receipt-item-panel">
            {itemSummaries.length ? <>
              <div className="wo-receipt-item-heading">
                <p>Tìm thấy <strong>{itemSummaries.length}</strong> WO · Đã chọn <strong>{selectedItemWos.length}/{MAX_ITEM_WO_SELECTION}</strong></p>
                <button className="button button-primary" disabled={!selectedItemWos.length || searching || printing} onClick={() => void loadPallets(selectedItemWos)} type="button">
                  {searching ? "Đang tải..." : "Tìm pallet đã chọn"}
                </button>
              </div>
              <div className="wo-receipt-item-table-wrap">
                <table className="wo-receipt-item-table">
                  <thead><tr><th className="wo-receipt-check">Chọn</th><th>WO</th><th>Tổng số lượng</th><th>Số pallet</th><th>Ngày bắt đầu</th><th>Ngày cuối</th></tr></thead>
                  <tbody>{itemSummaries.map((summary) => {
                    const selected = selectedItemWos.includes(summary.wo);
                    return <tr key={summary.wo}>
                      <td className="wo-receipt-check"><input aria-label={`Chọn ${summary.wo}`} checked={selected} disabled={!selected && selectedItemWos.length >= MAX_ITEM_WO_SELECTION} onChange={() => toggleItemWo(summary.wo)} type="checkbox" /></td>
                      <td><strong>{summary.wo}</strong></td>
                      <td>{formatNumber(summary.totalQuantity)}</td>
                      <td>{formatNumber(summary.palletCount)}</td>
                      <td>{formatWorkingDay(summary.firstWorkingDay)}</td>
                      <td>{formatWorkingDay(summary.lastWorkingDay)}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            </> : <div className="wo-receipt-empty">Không tìm thấy WO còn hiệu lực của item này.</div>}
          </div> : null}

          {searched ? <>
            <div className="wo-receipt-summary">
              <div className="wo-receipt-summary-copy">
                <span>WO đã tìm: <strong>{requestedWos.length}</strong></span>
                <span>Pallet: <strong>{pallets.length}</strong></span>
                <span>Tổng số lượng: <strong>{formatNumber(pallets.reduce((sum, pallet) => sum + Number(pallet.quantity || 0), 0))}</strong></span>
              </div>
              <button className="button button-primary" disabled={!pallets.length || printing} onClick={() => void printReceipt()} type="button">
                {printing ? "Đang tạo PDF..." : "In"}
              </button>
            </div>

            {missingWos.length ? <p className="wo-receipt-missing"><strong>Không tìm thấy pallet:</strong> {missingWos.join(", ")}</p> : null}

            {pallets.length ? <div className="wo-receipt-table-wrap">
              <table className="wo-receipt-table">
                <thead><tr><th>WO</th><th>Pallet ID</th><th>Itemcode</th><th>Tên sản phẩm</th><th>Số lượng</th><th>Working day</th><th>Thời gian in tem</th></tr></thead>
                <tbody>{palletGroups.map((group) => <Fragment key={group.wo}>
                  {group.pallets.map((pallet) => <tr key={`${pallet.pallet_id}-${pallet.created_at}`}>
                    <td><strong>{pallet.wo}</strong></td>
                    <td>{pallet.pallet_id}</td>
                    <td>{pallet.itemcode || "—"}</td>
                    <td className="wo-receipt-product">{pallet.product_name || "—"}</td>
                    <td>{formatNumber(pallet.quantity)}</td>
                    <td>{formatWorkingDay(pallet.working_day)}</td>
                    <td>{formatDateTime(pallet.created_at)}</td>
                  </tr>)}
                  <tr className="wo-receipt-subtotal"><td className="wo-receipt-subtotal-label" colSpan={4}>Subtotal {group.wo}</td><td>{formatNumber(group.totalQuantity)}</td><td colSpan={2} /></tr>
                </Fragment>)}</tbody>
              </table>
            </div> : <div className="wo-receipt-empty">Không tìm thấy pallet còn hiệu lực của các WO đã nhập.</div>}
          </> : !searching && !message && mode === "wo" ? <div className="wo-receipt-empty">Nhập danh sách WO, mỗi WO trên một dòng, sau đó nhấn Tìm kiếm.</div> : !searching && !message && mode === "item" && !itemSearched ? <div className="wo-receipt-empty">Nhập itemcode để xem danh sách WO và chọn tối đa 5 WO.</div> : null}
        </div>

        <div className="modal-actions wo-receipt-footer">
          <button className="button button-secondary" disabled={searching || printing} onClick={onClose} type="button">Đóng</button>
        </div>
      </div>
    </div>
  );
}
