import { PageShell } from "@/components/page-shell";
import { requireProfile } from "@/lib/auth";
import { WarehouseHistoryClient } from "./warehouse-history-client";

export default async function WarehouseReceiptPage() {
  const profile = await requireProfile();

  return (
    <PageShell profile={profile} title="Lịch sử phiếu nhập kho">
      <WarehouseHistoryClient />
    </PageShell>
  );
}
