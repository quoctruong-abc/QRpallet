import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { WarehouseReceiptClient, type WarehousePallet } from "./warehouse-receipt-client";

export default async function WarehouseReceiptPage() {
  const profile = await requirePermission("receipt.create");
  const supabase = await createClient();
  const { data, error } = await supabase.from("pallet_data")
    .select("pallet_id,itemcode,product_name,customer,wo,quantity,status,updated_at")
    .is("effect_to", null).eq("status", "processingWH").order("updated_at", { ascending: true });

  return <PageShell profile={profile} title="Xử lý data tạm / Nhập kho">
    {error ? <section className="alert alert-error">Chưa cập nhật database. Hãy chạy <b>supabase/006_warehouse_receipt.sql</b> trong Supabase SQL Editor.</section>
      : <WarehouseReceiptClient initialRows={(data ?? []) as WarehousePallet[]} />}
    {profile.role === "superadmin" || profile.role === "admin" ? <Link className="text-link" href="/admin">← Trở về Admin</Link> : null}
  </PageShell>;
}
