import { PageShell } from "@/components/page-shell";
import { hasPermission, requireAnyPermission } from "@/lib/auth";
import { WarehouseManagementClient } from "./warehouse-management-client";

export default async function WarehouseReceiptPage() {
  const profile = await requireAnyPermission(["receipt.view", "view-WH"]);
  const canViewWarehouse = hasPermission(profile, "view-WH");

  return (
    <PageShell profile={profile} title="Quản lý kho">
      <WarehouseManagementClient isSuperAdmin={profile.role === "superadmin"} key={profile.id} profileId={profile.id}
        canViewWarehouse={canViewWarehouse} canEditWarehouse={canViewWarehouse && hasPermission(profile, "edit-WH")}
        canViewReceipt={hasPermission(profile, "receipt.view")} />
    </PageShell>
  );
}
