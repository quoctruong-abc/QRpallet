import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { WarehouseManagementClient } from "./warehouse-management-client";

export default async function WarehouseReceiptPage() {
  const profile = await requirePermission("receipt.view");

  return (
    <PageShell profile={profile} title="Quản lý kho">
      <WarehouseManagementClient />
    </PageShell>
  );
}
