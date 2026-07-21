import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ScanQrClient, type ScannedPallet } from "./scan-qr-client";

export default async function ScanQrPage() {
  const profile = await requirePermission("scan.standard");
  const supabase = await createClient();
  const isAdmin = profile.role === "admin" || profile.role === "superadmin";

  let query = supabase
    .from("pallet_data")
    .select("pallet_id,wo,quantity,product_name,customer,itemcode,status,updated_at,scanned_by")
    .eq("status", "pendingWH")
    .is("effect_to", null)
    .order("updated_at", { ascending: false });

  if (!isAdmin) query = query.eq("scanned_by", profile.id);

  const { data, error } = await query;

  return (
    <PageShell profile={profile} title="Scan để nhập kho">
      {error ? (
        <section className="alert alert-error">
          Chưa cập nhật database. Hãy chạy <b>supabase/007_scan_owner_and_direct_receipt.sql</b> trong Supabase SQL Editor.
        </section>
      ) : (
        <ScanQrClient initialRows={(data ?? []) as ScannedPallet[]} isAdmin={isAdmin} />
      )}
    </PageShell>
  );
}
