import { PageShell } from "@/components/page-shell";
import { requireAdmin } from "@/lib/auth";
import { POSITION_LABELS, POSITION_PERMISSIONS, POSITION_ROUTES } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PermissionKey, Position, PositionPageMapping, Profile } from "@/lib/types";
import { CreateUserForm } from "./create-user-form";
import { PositionMappingForm } from "./position-mapping-form";
import { UserPermissionEditor } from "./user-permission-editor";
import {
  resetEmployeePassword,
  toggleEmployeeStatus,
} from "./actions";

const positions: Position[] = ["planning", "production", "warehouse"];
const pages = [
  { path: "/planning-inject", label: "Planning Inject" },
  { path: "/pallet-label", label: "Xuất tem pallet" },
  { path: "/scan-qr", label: "Scan QR" },
  { path: "/warehouse-receipt", label: "Xem phiếu nhập kho" },
] as const;

const allPermissions: Array<{ key: PermissionKey; label: string }> = [
  { key: "planning.upload", label: "Upload planning" },
  { key: "planning.change", label: "Thay đổi planning" },
  { key: "pallet.create", label: "Tạo pallet" },
  { key: "pallet.edit", label: "Sửa pallet" },
  { key: "scan.standard", label: "Scan QR" },
  { key: "receipt.view", label: "Xem phiếu nhập kho" },
  { key: "dashboard.view", label: "Xem Dashboard" },
];

const roleRules = [
  { role: "superadmin", system: "Toàn hệ thống", create: "superadmin, admin, user", accounts: "Tất cả tài khoản", mapping: "Được chỉnh", permissions: "Toàn bộ, luôn bypass; chỉ role này cấp Dashboard cho user" },
  { role: "admin", system: "Trong position của mình", create: "Chỉ user cùng position", accounts: "Chỉ user cùng position", mapping: "Không được chỉnh", permissions: "Dashboard mặc định; cấp quyền nghiệp vụ theo position" },
  { role: "user", system: "Không có quyền mặc định", create: "Không", accounts: "Không", mapping: "Không", permissions: "Dashboard chỉ khi Super Admin cấp" },
] as const;

function mappingEnabled(rows: PositionPageMapping[], position: Position, path: string) {
  const stored = rows.find((row) => row.position === position && row.path === path);
  return stored ? stored.is_enabled : POSITION_ROUTES[position].includes(path);
}

export default async function AdminPage() {
  const profile = await requireAdmin();
  const isSuperadmin = profile.role === "superadmin";
  const adminClient = createAdminClient();

  let profilesQuery = adminClient.from("profiles").select("*").order("created_at", { ascending: false });
  if (!isSuperadmin) {
    profilesQuery = profilesQuery.eq("role", "user").eq("position", profile.position!);
  }

  const [profilesResult, permissionResult, mappingResult] = await Promise.all([
    profilesQuery,
    adminClient.from("user_permissions").select("user_id,permission_key"),
    isSuperadmin
      ? adminClient.from("position_page_access").select("position,path,is_enabled")
      : Promise.resolve({ data: [], error: null }),
  ]);

  const users = (profilesResult.data ?? []) as Profile[];
  const mappingRows = (mappingResult.data ?? []) as PositionPageMapping[];
  const permissionMap = new Map<string, Set<PermissionKey>>();
  for (const row of permissionResult.data ?? []) {
    const userId = String(row.user_id);
    const current = permissionMap.get(userId) ?? new Set<PermissionKey>();
    current.add(row.permission_key as PermissionKey);
    permissionMap.set(userId, current);
  }

  const visiblePermissions = isSuperadmin
    ? allPermissions
    : allPermissions.filter((permission) =>
        Boolean(profile.position && POSITION_PERMISSIONS[profile.position].includes(permission.key)),
      );

  const mappingPositions = positions.map((position) => ({
    position,
    label: POSITION_LABELS[position],
    enabledPaths: pages
      .filter((page) => mappingEnabled(mappingRows, position, page.path))
      .map((page) => page.path),
  }));

  return (
    <PageShell profile={profile} title="Admin dashboard">
      <div className="admin-page">
        <div className="hero-row admin-hero">
          <div>
            <p className="eyebrow">{isSuperadmin ? "SUPERADMIN CONTROL CENTER" : "ADMIN CONTROL CENTER"}</p>
            <h1>Quản trị phân quyền hệ thống</h1>
            <p className="muted admin-intro">
              {isSuperadmin
                ? "Quản lý tài khoản, position mapping và permission. Admin và Super Admin được xem Dashboard mặc định; user chỉ được xem khi Super Admin cấp quyền Xem Dashboard."
                : `Tạo và quản lý user thuộc position ${profile.position ? POSITION_LABELS[profile.position] : "—"}. Dashboard là quyền mặc định của Admin; quyền Dashboard của user chỉ do Super Admin quản lý.`}
            </p>
          </div>
          <div className="stat-card admin-stat-card">
            <span className="stat-number">{users.length}</span>
            <span className="muted">Tài khoản có thể quản lý</span>
          </div>
        </div>

        {isSuperadmin ? (
          <>
            <section className="panel admin-panel">
              <div className="section-heading admin-section-heading">
                <div><p className="eyebrow">ROLE RULES</p><h2>Quyền cố định theo role</h2></div>
              </div>
              <div className="table-wrap admin-table-wrap">
                <table className="admin-role-table">
                  <thead><tr><th>Role</th><th>Phạm vi</th><th>Tạo tài khoản</th><th>Quản lý tài khoản</th><th>Position mapping</th><th>Quyền nghiệp vụ</th></tr></thead>
                  <tbody>{roleRules.map((rule) => <tr key={rule.role}>
                    <td data-label="Role"><span className="badge">{rule.role}</span></td>
                    <td data-label="Phạm vi">{rule.system}</td>
                    <td data-label="Tạo tài khoản">{rule.create}</td>
                    <td data-label="Quản lý tài khoản">{rule.accounts}</td>
                    <td data-label="Position mapping">{rule.mapping}</td>
                    <td data-label="Quyền nghiệp vụ">{rule.permissions}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="panel admin-panel">
              <div className="section-heading admin-section-heading">
                <div><p className="eyebrow">POSITION PAGE MAPPING</p><h2>Position nào được vào trang nào</h2></div>
              </div>
              {mappingResult.error ? <p className="alert alert-error">Chưa đọc được position_page_access: {mappingResult.error.message}</p> : null}
              <PositionMappingForm
                pages={pages.map((page) => ({ ...page }))}
                positions={mappingPositions}
              />
            </section>
          </>
        ) : null}

        <section className="panel admin-panel">
          <div className="section-heading admin-section-heading">
            <div>
              <p className="eyebrow">ACCOUNT MANAGEMENT</p>
              <h2>Tạo tài khoản</h2>
              {!isSuperadmin ? <p className="muted small">Admin chỉ tạo được user thuộc position của mình.</p> : null}
            </div>
          </div>
          <CreateUserForm actorRole={profile.role} actorPosition={profile.position} />
        </section>

        <section className="panel admin-panel admin-users-panel">
          <div className="section-heading admin-section-heading">
            <div>
              <p className="eyebrow">USER PERMISSION MATRIX</p>
              <h2>Quyền của từng tài khoản</h2>
              <p className="muted small">
                {isSuperadmin
                  ? "Super Admin có thể cấp Xem Dashboard cho user. Admin và Super Admin được xem Dashboard theo role nên không cần cấp riêng."
                  : `Chỉ hiển thị user thuộc position ${profile.position ? POSITION_LABELS[profile.position] : "—"}. Admin có thể cấp quyền nghiệp vụ trong position, nhưng không thể cấp hoặc gỡ quyền Dashboard.`}
              </p>
            </div>
          </div>
          {permissionResult.error ? <p className="alert alert-error">Không thể đọc quyền user: {permissionResult.error.message}</p> : null}
          <div className="table-wrap admin-table-wrap">
            <table className="admin-user-table">
              <thead><tr><th>Tài khoản</th><th>Role</th><th>Position</th>{visiblePermissions.map((permission) => <th key={permission.key}>{permission.label}</th>)}<th>Lưu</th><th>Quản lý</th></tr></thead>
              <tbody>{users.map((user) => {
                const granted = permissionMap.get(user.id) ?? new Set<PermissionKey>();
                const canEditPermissions = user.role !== "superadmin" && (isSuperadmin || user.role === "user");
                return <tr className={!user.is_active ? "admin-user-disabled" : undefined} key={user.id}>
                  <td data-label="Tài khoản" className="admin-user-identity">
                    <strong>{user.full_name}</strong>
                    <span className="table-subtext">{user.username}</span>
                    <span className={`admin-account-status ${user.is_active ? "is-active" : "is-locked"}`}>
                      {user.is_active ? "Đang hoạt động" : "Đã khóa"}
                    </span>
                  </td>
                  <td data-label="Role"><span className="badge">{user.role}</span></td>
                  <td data-label="Position">{user.position ? POSITION_LABELS[user.position] : "Toàn quyền"}</td>
                  {canEditPermissions ? (
                    <UserPermissionEditor
                      granted={Array.from(granted)}
                      permissions={visiblePermissions.map((permission) => ({
                        ...permission,
                        roleGranted: user.role === "admin" && (
                          permission.key === "receipt.view" || permission.key === "dashboard.view"
                        ),
                      }))}
                      userId={user.id}
                      username={user.username}
                    />
                  ) : (
                    <>
                      {visiblePermissions.map((permission) => (
                        <td data-label={permission.label} key={permission.key} className="admin-permission-cell">
                          <input aria-label={`${user.username} - ${permission.label} - theo role`} checked disabled readOnly type="checkbox" />
                        </td>
                      ))}
                      <td data-label="Lưu quyền"><span className="muted small">Theo role</span></td>
                    </>
                  )}
                  <td data-label="Quản lý tài khoản">
                    <div className="admin-account-actions">
                      {isSuperadmin ? (
                        <form action={resetEmployeePassword} className="admin-reset-form">
                          <input name="user_id" type="hidden" value={user.id} />
                          <input name="password" minLength={8} placeholder="Mật khẩu mới" required type="password" />
                          <button className="button button-small button-secondary" type="submit">Đặt lại mật khẩu</button>
                        </form>
                      ) : null}
                      {user.id === profile.id ? (
                        <span className="muted small">Tài khoản hiện tại</span>
                      ) : (
                        <form action={toggleEmployeeStatus} className="admin-status-form">
                          <input name="user_id" type="hidden" value={user.id} />
                          <input name="next_status" type="hidden" value={String(!user.is_active)} />
                          <button className={`button button-small ${user.is_active ? "button-secondary" : "button-primary"}`} type="submit">
                            {user.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
