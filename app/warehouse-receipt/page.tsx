import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePosition } from "@/lib/auth";

export default async function WarehouseReceiptPage() {
  const profile = await requirePosition("warehouse");
  return (
    <PageShell profile={profile} title="Xử lý data tạm / Nhập kho">
      <section className="module-page-card">
        <p className="eyebrow">MODULE 04</p>
        <h1>Xử lý data tạm</h1>
        <p className="muted">Xác nhận pallet, sinh số phiếu nhập kho và hoàn tất trạng thái.</p>
        <div className="placeholder-box">Gắn giao diện xử lý data tạm và phiếu nhập kho vào route này.</div>
        {profile.role === "admin" ? <Link className="text-link" href="/admin">← Trở về Admin</Link> : null}
      </section>
    </PageShell>
  );
}
