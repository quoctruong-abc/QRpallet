import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePosition } from "@/lib/auth";

export default async function PalletLabelPage() {
  const profile = await requirePosition("pallet");
  return (
    <PageShell profile={profile} title="Xuất tem pallet">
      <section className="module-page-card">
        <p className="eyebrow">MODULE 02</p>
        <h1>Xuất tem pallet</h1>
        <p className="muted">Sinh Pallet ID, lưu database và xuất tem QR/PDF.</p>
        <div className="placeholder-box">Gắn giao diện xuất tem pallet hiện có vào route này.</div>
        {profile.role === "admin" ? <Link className="text-link" href="/admin">← Trở về Admin</Link> : null}
      </section>
    </PageShell>
  );
}
