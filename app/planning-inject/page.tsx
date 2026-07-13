import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePosition } from "@/lib/auth";

export default async function PlanningInjectPage() {
  const profile = await requirePosition("planning");
  return (
    <PageShell profile={profile} title="Planning Inject">
      <section className="module-page-card">
        <p className="eyebrow">MODULE 01</p>
        <h1>Planning Inject</h1>
        <p className="muted">Khu vực import kế hoạch Excel và tạo database Work Order.</p>
        <div className="placeholder-box">Gắn giao diện Planning Inject hiện có vào route này.</div>
        {profile.role === "admin" ? <Link className="text-link" href="/admin">← Trở về Admin</Link> : null}
      </section>
    </PageShell>
  );
}
