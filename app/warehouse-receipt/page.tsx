import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { WarehouseHistoryClient } from "./warehouse-history-client";

export default async function WarehouseReceiptPage() {
  const profile = await requirePermission("receipt.view");

  return (
    <PageShell profile={profile} title="Lịch sử phiếu nhập kho">
      <WarehouseHistoryClient />
    </PageShell>
  );
}