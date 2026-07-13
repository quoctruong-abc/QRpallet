import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePosition } from "@/lib/auth";

export default async function ScanQrPage() {
  const profile = await requirePosition("scanner");
  return (
    <PageShell profile={profile} title="Scan QR">
      <section className="module-page-card">
        <p className="eyebrow">MODULE 03</p>
        <h1>Scan QR</h1>
        <p className="muted">Quét QR pallet, đối chiếu dữ liệu và xác nhận vào data tạm.</p>
        <div className="placeholder-box">Gắn scanner camera hiện có vào route này.</div>
        {profile.role === "admin" ? <Link className="text-link" href="/admin">← Trở về Admin</Link> : null}
      </section>
    </PageShell>
  );
}
