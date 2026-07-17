import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { hasPermission, requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PalletLabelClient, type ActivePallet, type PlanItem } from "./pallet-label-client";

type PlanDbRow = {
  machine: string | null;
  itemcode: string | null;
  product_name: string | null;
  customer: string | null;
  wo: string | null;
  quanorder: number | null;
};

type PalletDbRow = ActivePallet;
type ConfigDbRow = { itemcode: string; quantity_per_pallet: number };

export default async function PalletLabelPage() {
  const profile = await requirePermission("pallet.create");
  const canEditPallet = hasPermission(profile, "pallet.edit");
  const supabase = await createClient();

  const [planResult, palletResult, configResult] = await Promise.all([
    supabase
      .from("planning_inject")
      .select("machine,itemcode,product_name,customer,wo,quanorder")
      .not("machine", "is", null)
      .not("itemcode", "is", null)
      .not("wo", "is", null)
      .order("machine", { ascending: true }),
    supabase
      .from("pallet_data")
      .select("pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,note,created_at")
      .is("effect_to", null)
      .order("created_at", { ascending: false }),
    supabase.from("item_pallet_config").select("itemcode,quantity_per_pallet"),
  ]);

  const databaseReady = !planResult.error && !palletResult.error && !configResult.error;
  const planRows = (planResult.data ?? []) as PlanDbRow[];
  const palletRows = (palletResult.data ?? []) as PalletDbRow[];
  const configs = new Map(
    ((configResult.data ?? []) as ConfigDbRow[]).map((row) => [row.itemcode, Number(row.quantity_per_pallet)]),
  );

  const totals = new Map<string, { produced: number; warehouse: number }>();
  for (const pallet of palletRows) {
    const current = totals.get(pallet.wo) ?? { produced: 0, warehouse: 0 };
    const quantity = Number(pallet.quantity) || 0;
    current.produced += quantity;
    if (pallet.status.toLowerCase() !== "production") current.warehouse += quantity;
    totals.set(pallet.wo, current);
  }

  const uniquePlan = new Map<string, PlanItem>();
  for (const row of planRows) {
    if (!row.machine || !row.itemcode || !row.wo) continue;
    const key = `${row.machine}::${row.wo}::${row.itemcode}`;
    if (uniquePlan.has(key)) continue;
    const total = totals.get(row.wo) ?? { produced: 0, warehouse: 0 };
    uniquePlan.set(key, {
      machine: row.machine,
      itemcode: row.itemcode,
      product_name: row.product_name ?? "",
      customer: row.customer ?? "",
      wo: row.wo,
      quanorder: row.quanorder === null ? null : Number(row.quanorder),
      produced_quantity: total.produced,
      warehouse_quantity: total.warehouse,
      quantity_per_pallet: configs.get(row.itemcode) ?? null,
    });
  }

  return (
    <PageShell profile={profile} title="Xuất tem pallet">
      <div className="hero-row">
        <div>
          <p className="eyebrow">MODULE 02</p>
          <h1>Xuất tem pallet</h1>
          <p className="muted">Chọn máy, tạo tem và quản lý các pallet đang hiệu lực.</p>
        </div>
        {profile.role === "superadmin" || profile.role === "admin" ? (
          <Link className="text-link" href="/admin">Quản lý tài khoản →</Link>
        ) : null}
      </div>

      {!databaseReady ? (
        <section className="alert alert-error">
          Chưa đủ bảng database. Kiểm tra các migration Planning Inject và Pallet Label trong Supabase.
        </section>
      ) : (
        <div className={canEditPallet ? undefined : "pallet-create-only"}>
          {!canEditPallet ? (
            <style>{`.pallet-create-only .pallet-main-toolbar > button:first-child { display: none; }`}</style>
          ) : null}
          <PalletLabelClient
            rows={Array.from(uniquePlan.values())}
            pallets={palletRows}
          />
        </div>
      )}
    </PageShell>
  );
}
