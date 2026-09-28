import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ScanQrClient, type ScannedPallet } from "./scan-qr-client";

const MAX_SCAN_PALLETS = 200;

export default async function ScanQrPage() {
  const profile = await requirePermission("scan.standard");
  const supabase = await createClient();
  const isAdmin = profile.role === "admin" || profile.role === "superadmin";

  let query = supabase
    .from("pallet_data")
    .select("pallet_id,wo,quantity,product_name,customer,itemcode,status,updated_at,scanned_at,scanned_by")
    .eq("status", "pendingWH")
    .is("effect_to", null)
    .order("scanned_at", { ascending: false })
    .limit(MAX_SCAN_PALLETS);

  if (!isAdmin) query = query.eq("scanned_by", profile.id);

  const { data, error } = await query;

  if (error) {
    console.error("Scan QR initial queue failed", error);
  }

  const rows = (data ?? []) as Omit<ScannedPallet, "scanned_by_name">[];
  const scannerIds = Array.from(new Set(
    rows.map((row) => row.scanned_by).filter((id): id is string => Boolean(id)),
  ));
  const scannerNameMap = new Map<string, string>();

  if (scannerIds.length) {
    const adminClient = createAdminClient();
    const { data: scannerProfiles, error: scannerProfileError } = await adminClient
      .from("profiles")
      .select("id,full_name,username,employee_code")
      .in("id", scannerIds);

    if (scannerProfileError) {
      console.error("Scan QR scanner profile lookup failed", scannerProfileError);
    } else {
      for (const scannerProfile of scannerProfiles ?? []) {
        const displayName = scannerProfile.full_name?.trim() || scannerProfile.username?.trim() || "Không xác định";
        scannerNameMap.set(
          scannerProfile.id,
          scannerProfile.employee_code ? `${displayName} · ${scannerProfile.employee_code}` : displayName,
        );
      }
    }
  }

  const initialRows: ScannedPallet[] = rows.map((row) => ({
    ...row,
    scanned_by_name: row.scanned_by ? scannerNameMap.get(row.scanned_by) ?? "Không xác định" : null,
  }));

  return (
    <PageShell profile={profile} title="Scan để nhập kho">
      {error ? (
        <section className="alert alert-error">
          Không thể tải dữ liệu. Vui lòng thử lại.
        </section>
      ) : (
        <ScanQrClient initialRows={initialRows} isAdmin={isAdmin} />
      )}
    </PageShell>
  );
}
