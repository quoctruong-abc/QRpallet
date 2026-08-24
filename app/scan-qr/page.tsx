import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ScanQrClient, type ScannedPallet } from "./scan-qr-client";

const MAX_SCAN_PALLETS = 200;

export default async function ScanQrPage() {
  const profile = await requirePermission("scan.standard");
  const supabase = await createClient();
  const isAdmin = profile.role === "admin" || profile.role === "superadmin";

  let query = supabase
    .from("pallet_data")
    .select("pallet_id,wo,quantity,product_name,customer,itemcode,status,updated_at,scanned_by")
    .eq("status", "pendingWH")
    .is("effect_to", null)
    .order("updated_at", { ascending: false })
    .limit(MAX_SCAN_PALLETS);

  if (!isAdmin) query = query.eq("scanned_by", profile.id);

  const { data, error } = await query;

  if (error) {
    console.error("Scan QR initial queue failed", error);
  }

  return (
    <PageShell profile={profile} title="Scan để nhập kho">
      {error ? (
        <section className="alert alert-error">
          Không thể tải dữ liệu. Vui lòng thử lại.
        </section>
      ) : (
        <ScanQrClient initialRows={(data ?? []) as ScannedPallet[]} isAdmin={isAdmin} />
      )}
    </PageShell>
  );
}
