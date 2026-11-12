"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";

type CatalogItem = { product_name: string | null; customer: string | null; erp_name: string | null };
type Children = [string | null, string | null, string | null];
type Recipe = { id: string; children: Children };
type Lookup = { catalog: CatalogItem | null; recipes: Recipe[] };
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
  const code = input.trim();
  const valid = validCode(code);
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
  return { code, data: current?.data, error: code && !valid ? "Itemcode không hợp lệ." : current?.error,
    loading: valid && !current };
}

function CatalogDialog({ title, Editor, onSaved }: {
  title: string;
  Editor: ComponentType<EditorProps>;
  onSaved: OnSaved;
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
    <dialog ref={ref} aria-labelledby={id} className="modal-card warehouse-opening-dialog warehouse-catalog-dialog"
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
  const [customer, setCustomer] = useState<string | null>(null);
  const [customerList, setCustomerList] = useState<{ data?: string[]; error?: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const item = useCatalogLookup(input);
  const productName = name ?? item.data?.catalog?.product_name ?? item.data?.catalog?.erp_name ?? "";
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

  const canSave = !busy && Boolean(item.data && productName.trim() && customerList?.data);
  async function save() {
    if (!canSave) return;
    setBusy(true); setNotice(null);
    try {
      await catalogRequest("save_item", { itemcode: item.code, product_name: productName.trim(), customer: chosenCustomer || null });
      onSaved(item.code);
      setNotice({ text: `Đã cập nhật itemcode ${item.code}.` });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : "Không lưu được itemcode.", error: true });
    } finally { setBusy(false); }
  }

  return <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="warehouse-catalog-fields">
      <label>Itemcode <input value={input} required maxLength={200} disabled={busy} onChange={(event) => {
        setInput(event.target.value); setName(null); setCustomer(null); setNotice(null);
      }} /></label>
      <label>Tên sản phẩm <input value={productName} required maxLength={500} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
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

function ChildCodeRow({ index, code, disabled, onChange }: {
  index: number; code: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const item = useCatalogLookup(code);
  const name = item.data?.catalog?.product_name ?? item.data?.catalog?.erp_name;
  return <div className="warehouse-catalog-code-row">
    <label>{`Itemcode con ${index + 1}`}<input value={code} maxLength={200} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>
    <label>{`Tên sản phẩm con ${index + 1}`}<input readOnly value={name ?? ""} placeholder={item.loading ? "Đang tra…" : code.trim() ? item.error || "Chưa có tên sản phẩm" : "Tự hiện theo itemcode"} /></label>
  </div>;
}

function BuildUpEditor({ busy, setBusy, close, onSaved }: EditorProps) {
  const [parent, setParent] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [editedChildren, setEditedChildren] = useState<[string, string, string] | null>(null);
  const [recipeId, setRecipeId] = useState("");
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const item = useCatalogLookup(parent, true, revision);
  const recipes = item.data?.recipes ?? [];
  const replacement = recipes.length === 1 ? recipes[0] : recipes.find((recipe) => recipe.id === recipeId);
  const childInputs = editedChildren ?? (replacement ? replacement.children.map((child) => child ?? "") as [string, string, string] : emptyChildren);
  const children = childInputs.map((child) => child.trim() || null) as Children;
  const parentName = item.data?.catalog?.product_name;
  const productName = parentName ?? name ?? item.data?.catalog?.erp_name ?? "";
  const canSave = !busy && Boolean(item.data && productName.trim() && (recipes.length === 0 || replacement))
    && children.some((child) => child !== null) && children.every((child) => child === null || validCode(child));

  function changeParent(value: string) {
    setParent(value); setName(null); setRecipeId(""); setEditedChildren(null); setConfirming(false); setNotice(null);
  }

  async function save() {
    if (!canSave || (replacement && !confirming)) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await catalogRequest<{ replaced: boolean }>("save_build_up", {
        itemcode: item.code, product_name: productName.trim(), children,
        replace_id: replacement?.id ?? null, expected_children: replacement?.children ?? null,
      });
      onSaved(item.code);
      setConfirming(false);
      setNotice({ text: saved.replaced ? `Đã thay tổ hợp của mã mẹ ${item.code}.` : `Đã lưu tổ hợp cho mã mẹ ${item.code}.` });
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
      <div className="warehouse-catalog-code-row">
        <label>Itemcode mẹ <input value={parent} required maxLength={200} disabled={busy || confirming} onChange={(event) => changeParent(event.target.value)} /></label>
        <label>Tên sản phẩm mẹ <input value={productName} required maxLength={500} readOnly={Boolean(parentName)} disabled={busy || confirming}
          placeholder={item.loading ? "Đang tra…" : "Nhập tên nếu mã mẹ chưa có tên"}
          onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {recipes.length > 1 ? <label>Tổ hợp cần thay
        <select value={recipeId} disabled={busy || confirming} required onChange={(event) => {
          setRecipeId(event.target.value); setEditedChildren(null); setNotice(null);
        }}>
          <option value="">Chọn tổ hợp đang có</option>
          {recipes.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipeLabel(recipe.children)}</option>)}
        </select>
      </label> : null}
      {replacement && !confirming ? <p className="muted small">Tổ hợp đang lưu: {recipeLabel(replacement.children)}. Hệ thống sẽ hỏi xác nhận trước khi thay.</p> : null}
      {childInputs.map((code, index) => <ChildCodeRow key={index} index={index} code={code} disabled={busy || confirming || (recipes.length > 1 && !replacement)}
        onChange={(value) => setEditedChildren(childInputs.map((child, i) => i === index ? value : child) as [string, string, string])} />)}
    </div>
    {item.error ? <p className="alert alert-error" role="alert">{item.error}</p> : null}
    {notice ? <p className={`alert ${notice.error ? "alert-error" : "alert-success"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
    {confirming && replacement ? <div className="alert warehouse-bulk-warning" role="alert">
      <strong>Xác nhận thay thế tổ hợp của {item.code}?</strong><br />
      Đang lưu: {recipeLabel(replacement.children)}<br />Thay bằng: {recipeLabel(children)}
    </div> : null}
    <div className="modal-actions">
      <button type="button" className="button button-secondary" disabled={busy} onClick={close}>Đóng</button>
      {notice?.error ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => {
        setNotice(null); setRecipeId(""); setRevision((value) => value + 1);
      }}>Tra lại mã mẹ</button> : null}
      {confirming ? <>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirming(false)}>Quay lại</button>
        <button type="button" className="button button-primary" disabled={!canSave} onClick={() => { void save(); }}>{busy ? "Đang lưu…" : "Xác nhận thay thế"}</button>
      </> : <button type="submit" className="button button-primary" disabled={!canSave}>{busy ? "Đang lưu…" : "Lưu ghép cặp"}</button>}
    </div>
  </form>;
}

export function WarehouseCatalogEditors({ onSaved }: { onSaved: OnSaved }) {
  return <>
    <CatalogDialog title="Cập nhật itemcode" Editor={ItemCodeEditor} onSaved={onSaved} />
    <CatalogDialog title="Cập nhật ghép cặp" Editor={BuildUpEditor} onSaved={onSaved} />
  </>;
}
