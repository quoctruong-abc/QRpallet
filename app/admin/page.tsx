import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { POSITION_LABELS } from "@/lib/routes";
import type { Profile } from "@/lib/types";
import { PageShell } from "@/components/page-shell";
import { CreateUserForm } from "./create-user-form";
import { toggleEmployeeStatus } from "./actions";

const modules = [
  { title: "Planning Inject", href: "/planning-inject" },
  { title: "Xuất tem pallet", href: "/pallet-label" },
  { title: "Scan QR", href: "/scan-qr" },
  { title: "Xử lý data tạm", href: "/warehouse-receipt" },
];

export default async function AdminPage() {
  const profile = await requireAdmin();
  const adminClient = createAdminClient();

  let query = adminClient.from("profiles").select("*").order("created_at", { ascending: false });
  if (profile.role === "admin") {
    query = query.eq("role", "user").eq("position", profile.position!);
  }
  const { data } = await query;
  const users = (data ?? []) as Profile[];

  return (
    <PageShell profile={profile} title="Admin dashboard">
      <div className="hero-row">
        <div>
          <p className="eyebrow">ADMIN CONTROL CENTER</p>
          <h1>Quản lý hệ thống SVN</h1>
          <p className="muted">
            {profile.role === "superadmin"
              ? "Toàn quyền tài khoản, position mapping và permissions."
              : `Quản lý user thuộc position ${profile.position ?? "—"}.`}
          </p>
        </div>
        <div className="stat-card">
          <span className="stat-number">{users.length}</span>
          <span className="muted">Tài khoản có thể quản lý</span>
        </div>
      </div>

      <section>
        <div className="module-grid">
          {modules.map((module) => (
            <Link className="module-card" href={module.href} key={module.href}>
              <h3>{module.title}</h3>
              <span className="module-link">Mở chức năng →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACCOUNT MANAGEMENT</p>
            <h2>Tạo tài khoản</h2>
          </div>
        </div>
        <CreateUserForm actorRole={profile.role} actorPosition={profile.position} />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">USERS</p>
            <h2>Danh sách tài khoản</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nhân viên</th>
                <th>Mã NV</th>
                <th>Role</th>
                <th>Position</th>
                <th>Trạng thái</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.full_name}</strong>
                    <span className="table-subtext">{user.email}</span>
                  </td>
                  <td>{user.employee_code ?? "—"}</td>
                  <td><span className="badge">{user.role}</span></td>
                  <td>{user.position ? POSITION_LABELS[user.position] : "Toàn quyền"}</td>
                  <td>
                    <span className={`status ${user.is_active ? "status-active" : "status-disabled"}`}>
                      {user.is_active ? "Hoạt động" : "Đã khóa"}
                    </span>
                  </td>
                  <td>
                    {user.id === profile.id ? (
                      <span className="muted small">Tài khoản hiện tại</span>
                    ) : (
                      <form action={toggleEmployeeStatus}>
                        <input type="hidden" name="user_id" value={user.id} />
                        <input type="hidden" name="next_status" value={String(!user.is_active)} />
                        <button className="button button-small button-secondary" type="submit">
                          {user.is_active ? "Khóa" : "Mở khóa"}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </PageShell>
  );
}
