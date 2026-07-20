import { redirect } from "next/navigation";
import { PageShell } from "@/components/page-shell";
import { hasPermission, requireProfile } from "@/lib/auth";
import { WarehouseHistoryClient } from "./warehouse-history-client";

export default async function WarehouseReceiptPage() {
  const profile = await requireProfile();
  const canViewHistory = hasPermission(profile, "receipt.create") || hasPermission(profile, "receipt.edit");

  if (!canViewHistory) redirect("/dashboard");

  return (
    <PageShell profile={profile} title="Lịch sử phiếu nhập kho">
      <WarehouseHistoryClient />
    </PageShell>
  );
}
