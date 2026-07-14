import { PageShell } from "@/components/page-shell";
import { requirePosition } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ScanQrClient, type ScannedPallet } from "./scan-qr-client";

export default async function ScanQrPage() {
  const profile = await requirePosition("scanner");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pallet_data")
    .select("pallet_id,wo,quantity,product_name,customer,itemcode,status,updated_at")
    .eq("status", "pendingWH")
    .order("updated_at", { ascending: false });

  return (
    <PageShell profile={profile} title="Scan QR">
      <ScanQrClient initialRows={(error ? [] : data ?? []) as ScannedPallet[]} />
    </PageShell>
  );
}
