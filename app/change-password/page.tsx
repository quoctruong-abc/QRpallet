import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requireProfile } from "@/lib/auth";
import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  const profile = await requireProfile();

  return (
    <PageShell profile={profile} title="Đổi mật khẩu">
      <section className="panel" style={{ maxWidth: "560px" }}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACCOUNT SECURITY</p>
            <h1>Đổi mật khẩu</h1>
            <p className="muted">Mật khẩu mới phải có ít nhất 8 ký tự.</p>
          </div>
        </div>
        <ChangePasswordForm />
        <div style={{ marginTop: "1rem" }}>
          <Link className="text-link" href="/dashboard">← Quay lại</Link>
        </div>
      </section>
    </PageShell>
  );
}
