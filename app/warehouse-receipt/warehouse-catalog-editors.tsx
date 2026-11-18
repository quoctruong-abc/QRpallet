"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { MAX_MASTER_WEIGHT } from "@/lib/warehouse-receipt/master-data";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";

type CatalogItem = { product_name: string | null; customer: string | null; erp_name: string | null; netweight: number | null };
type Children = [string | null, string | null, string | null];
type Recipe = { id: string; active: boolean; children: Children };
type Lookup = { catalog: CatalogItem | null; recipes: Recipe[];
  resolved?: { product_name: string | null; customer: string | null; declared: boolean; lookup_error: string | null } };
type OnSaved = (itemcode: string) => void;
type EditorProps = { busy: boolean; setBusy: (busy: boolean) => void; close: () => void; onSaved: OnSaved };

const emptyChildren: [string, string, string] = ["", "", ""];
const validCode = (code: string) => /^[^\s*\u0000]{1,200}$/u.test(code);
const recipeLabel = (children: Children) => children.map((child) => child ?? "—").join(" / ");

async function catalogRequest<T>(action: string, payload: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/warehouse-receipt/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }), signal,
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || "Không xử lý được dữ liệu danh mục.");
  return data;
}

function useCatalogLookup(input: string, recipes = false, revision = 0) {
  let code = input.trim();
  let codeError = "";
  if (code) {
    try { code = normalizeWarehouseItemcode(code); }
    catch (error) { codeError = error instanceof Error ? error.message : "Itemcode không hợp lệ."; }
  }
  const valid = !codeError && validCode(code);
  const key = valid ? JSON.stringify([code, recipes, revision]) : "";
  const [result, setResult] = useState<{ key: string; data?: Lookup; error?: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void catalogRequest<Lookup>("lookup", { itemcode: code, recipes }, controller.signal).then(
        (data) => { if (!controller.signal.aborted) setResult({ key, data }); },
        (error: Error) => { if (!controller.signal.aborted) setResult({ key, error: error.message }); },
      );
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [code, recipes, key]);
  const current = key && key === result?.key ? result : null;
  return { code, data: current?.data, error: codeError || (code && !valid ? "Itemcode không hợp lệ." : current?.error),
    loading: valid && !current };
}

function CatalogDialog({ title, Editor, onSaved, wide = false }: {
  title: string;
  Editor: ComponentType<EditorProps>;
  onSaved: OnSaved;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => ref.current?.close();
  return <>
    <button aria-haspopup="dialog" type="button" className="button button-secondary" onClick={() => {
      setOpen(true);
      ref.current?.showModal();
    }}>{title}</button>
    <dialog ref={ref} aria-labelledby={id} className={`modal-card warehouse-opening-dialog warehouse-catalog-dialog${wide ? " warehouse-build-up-dialog" : ""}`}
      onClose={() => setOpen(false)} onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button type="button" className="modal-close" aria-label="Đóng" onClick={close} disabled={busy}>×</button>
      </div>
      {open ? <Editor busy={busy} setBusy={setBusy} close={close} onSaved={onSaved} /> : null}
    </dialog>
  </>;
}

function ItemCodeEditor({ busy, setBusy, close, onSaved }: EditorProps) {
  const [input, setInput] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [erpName, setErpName] = useState<string | null>(null);
  const [weight, setWeight] = useState<string | null>(null);
  const [customer, setCustomer] = useState<string | null>(null);
  const [customerList, setCustomerList] = useState<{ data?: string[]; error?: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const item = useCatalogLookup(input);
  const productName = name ?? item.data?.catalog?.product_name ?? item.data?.catalog?.erp_name ?? "";
  const displayedErpName = erpName ?? item.data?.catalog?.erp_name ?? "";
  const displayedWeight = weight ?? String(item.data?.catalog?.netweight ?? "");
  const chosenWeight = displayedWeight === "" ? null : Number(displayedWeight);
  const chosenCustomer = customer ?? item.data?.catalog?.customer ?? "";
  const customers = customerList?.data ?? [];
  useEffect(() => {
    const controller = new AbortController();
    void catalogRequest<{ customers: string[] }>("customers", {}, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setCustomerList({ data: data.customers }); },
      (error: Error) => { if (!controller.signal.aborted) setCustomerList({ error: error.message }); },
    );
    return () => controller.abort();
  }, []);

  const canSave = !busy && Boolean(item.data && productName.trim() && customerList?.data)
    && (chosenWeight === null || (Number.isFinite(chosenWeight) && chosenWeight >= 0 && chosenWeight <= MAX_MASTER_WEIGHT));
  async function save() {
    if (!canSave) return;
    setBusy(true); setNotice(null);
    try {
      await catalogRequest("save_item", {
        itemcode: item.code, product_name: productName.trim(), customer: chosenCustomer || null,
        ...(erpName !== null ? { erp_name: erpName.trim() || null } : {}),
        ...(weight !== null ? { netweight: chosenWeight } : {}),
      });
      onSaved(item.code);
      setNotice({ text: `Đã cập nhật itemcode ${item.code}.` });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : "Không lưu được itemcode.", error: true });
    } finally { setBusy(false); }
  }

  return <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="warehouse-catalog-fields">
      <label>Itemcode <input value={input} required maxLength={200} disabled={busy} onChange={(event) => {
        setInput(event.target.value); setName(null); setErpName(null); setWeight(null); setCustomer(null); setNotice(null);
      }} /></label>
      <label>Tên sản phẩm <input value={productName} required maxLength={500} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label>Tên ERP <input value={displayedErpName} maxLength={500} disabled={busy}
        placeholder="Không bắt buộc" onChange={(event) => setErpName(event.target.value)} /></label>
      <label>Khối lượng <input type="number" inputMode="decimal" min={0} max={MAX_MASTER_WEIGHT} step="any"
        value={displayedWeight} disabled={busy} placeholder="Không bắt buộc" onChange={(event) => setWeight(event.target.value)} /></label>
      <label>Khách hàng
        <select value={chosenCustomer} disabled={busy || !customerList?.data} onChange={(event) => setCustomer(event.target.value)}>
          <option value="">{customerList ? "Không chọn khách hàng" : "Đang tải khách hàng…"}</option>
          {chosenCustomer && !customers.includes(chosenCustomer) ? <option value={chosenCustomer}>{chosenCustomer}</option> : null}
          {customers.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </label>
    </div>
    {item.loading ? <p className="muted small" role="status">Đang tra itemcode…</p> : null}
    {item.error || customerList?.error ? <p className="alert alert-error" role="alert">{item.error || customerList?.error}</p> : null}
    {notice ? <p className={`alert ${notice.error ? "alert-error" : "alert-success"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
    <div className="modal-actions">
      <button type="button" className="button button-secondary" disabled={busy} onClick={close}>Đóng</button>
      <button type="submit" className="button button-primary" disabled={!canSave}>{busy ? "Đang lưu…" : "Lưu itemcode"}</button>
    </div>
  </form>;
}

function buildUpName(lookup: ReturnType<typeof useCatalogLookup>) {
  return lookup.error || lookup.data?.resolved?.lookup_error ? "" : lookup.data?.resolved?.product_name ?? "";
}

function BuildUpCodeRow({ label, code, lookup, disabled, required, onChange }: {
  label: string; code: string; lookup: ReturnType<typeof useCatalogLookup>;
  disabled: boolean; required?: boolean; onChange: (value: string) => void;
}) {
  const errorId = useId();
  const name = buildUpName(lookup);
  const error = lookup.error || lookup.data?.resolved?.lookup_error || "";
  return <div className="warehouse-catalog-code-row">
    <label>{`Itemcode ${label}`}<input value={code} maxLength={200} disabled={disabled} required={required}
      aria-label={`Itemcode ${label}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      onChange={(event) => onChange(event.target.value)} />
      {error ? <span id={errorId} className="warehouse-required small" role="alert">{error}</span> : null}
    </label>
    <label>{`Tên sản phẩm ${label}`}<output className="warehouse-catalog-display" aria-label={`Tên sản phẩm ${label}`} aria-live="polite">{lookup.loading ? "Đang tra…" : name || "—"}</output></label>
    <label>{`Khách hàng ${label}`}<output className="warehouse-catalog-display" aria-label={`Khách hàng ${label}`} aria-live="polite">
      {lookup.loading ? "Đang tra…" : lookup.data?.resolved?.customer || (name ? "Chưa có tên khách hàng" : "—")}
    </output></label>
  </div>;
}

function BuildUpEditor({ busy, setBusy, close }: EditorProps) {
  const [parent, setParent] = useState("");
  const [editedChildren, setEditedChildren] = useState<[string, string, string] | null>(null);
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const item = useCatalogLookup(parent, true, revision);
  const recipes = item.data?.recipes ?? [];
  const selectedId = recipeId ?? recipes.find((recipe) => recipe.active)?.id ?? (recipes.length === 1 ? recipes[0].id : "");
  const replacement = recipes.find((recipe) => recipe.id === selectedId);
  const childInputs = editedChildren ?? (replacement ? replacement.children.map((child) => child ?? "") as [string, string, string] : emptyChildren);
  const childOne = useCatalogLookup(childInputs[0], false, revision);
  const childTwo = useCatalogLookup(childInputs[1], false, revision);
  const childThree = useCatalogLookup(childInputs[2], false, revision);
  const childLookups = [childOne, childTwo, childThree];
  const children = childInputs.map((child, index) => child.trim() ? childLookups[index].code : null) as Children;
  const canSave = !busy && Boolean(buildUpName(item)) && (recipes.length === 0 || selectedId === "new" || Boolean(replacement))
    && children.some((child) => child !== null)
    && children.every((child, index) => child === null || Boolean(buildUpName(childLookups[index])));

  function changeParent(value: string) {
    if (editedChildren || children.some((child) => child !== null)) setEditedChildren(childInputs);
    setParent(value); setRecipeId(null); setConfirming(false); setNotice(null);
  }

  async function save() {
    if (!canSave || (replacement && !confirming)) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await catalogRequest<{ replaced: boolean; recipe_id: string }>("save_build_up", {
        itemcode: item.code, children,
        create_new: !replacement,
        replace_id: replacement?.id ?? null, expected_children: replacement?.children ?? null,
      });
      setConfirming(false);
      setEditedChildren(childInputs);
      setRecipeId(saved.recipe_id);
      setNotice({ text: saved.replaced ? `Đã cập nhật và đặt active tổ hợp của mã mẹ ${item.code}.` : `Đã thêm bộ mới và đặt active cho mã mẹ ${item.code}.` });
      setRevision((value) => value + 1);
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : "Không lưu được tổ hợp.", error: true });
      setConfirming(false);
    } finally { setBusy(false); }
  }

  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!canSave || confirming) return;
    if (replacement) { setConfirming(true); setNotice(null); }
    else void save();
  }}>
    <div className="warehouse-catalog-fields">
      <BuildUpCodeRow label="mẹ" code={parent} lookup={item} disabled={busy || confirming} required onChange={changeParent} />
      {recipes.length > 0 ? <label>Tổ hợp ghép cặp
        <select value={selectedId} disabled={busy || confirming} required onChange={(event) => {
          setRecipeId(event.target.value); setEditedChildren(null); setNotice(null); setConfirming(false);
        }}>
          <option value="">Chọn tổ hợp hoặc thêm mới</option>
          <option value="new">Thêm bộ mới</option>
          {recipes.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.active ? "Active" : "Deactive"} · {recipeLabel(recipe.children)}</option>)}
        </select>
      </label> : null}
      {replacement && !confirming ? <p className="muted small">Tổ hợp đang lưu ({replacement.active ? "Active" : "Deactive"}): {recipeLabel(replacement.children)}. Xác nhận lưu sẽ đặt bộ này active và các bộ khác của mã mẹ deactive.</p> : null}
      {!replacement && (selectedId === "new" || !recipes.length) ? <p className="muted small">Bộ mới sẽ active sau khi lưu thành công; các bộ khác của mã mẹ sẽ deactive.</p> : null}
      {childInputs.map((code, index) => <BuildUpCodeRow key={index} label={`con ${index + 1}`} code={code} lookup={childLookups[index]} disabled={busy || confirming}
        onChange={(value) => setEditedChildren(childInputs.map((child, i) => i === index ? value : child) as [string, string, string])} />)}
    </div>
    {notice ? <p className={`alert ${notice.error ? "alert-error" : "alert-success"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
    {confirming && replacement ? <div className="alert warehouse-bulk-warning" role="alert">
      <strong>Xác nhận cập nhật và đặt active tổ hợp của {item.code}?</strong><br />
      Đang lưu: {recipeLabel(replacement.children)}<br />Thay bằng: {recipeLabel(children)}
    </div> : null}
    <div className="modal-actions">
      <button type="button" className="button button-secondary" disabled={busy} onClick={close}>Đóng</button>
      {notice?.error ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => {
        setNotice(null); setRecipeId(null); setRevision((value) => value + 1);
      }}>Tra lại mã mẹ</button> : null}
      {confirming ? <>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirming(false)}>Quay lại</button>
        <button type="button" className="button button-primary" disabled={!canSave} onClick={() => { void save(); }}>{busy ? "Đang lưu…" : "Xác nhận lưu và đặt active"}</button>
      </> : <button type="submit" className="button button-primary" disabled={!canSave}>{busy ? "Đang lưu…" : replacement ? "Lưu và đặt active" : "Thêm bộ và đặt active"}</button>}
    </div>
  </form>;
}

export function WarehouseCatalogEditors({ onSaved }: { onSaved: OnSaved }) {
  return <>
    <CatalogDialog title="Cập nhật itemcode" Editor={ItemCodeEditor} onSaved={onSaved} />
    <CatalogDialog title="Cập nhật ghép cặp" Editor={BuildUpEditor} onSaved={onSaved} wide />
  </>;
}
