import { PageShell } from "@/components/page-shell";
import { requireAdmin } from "@/lib/auth";
import { POSITION_LABELS, POSITION_PERMISSIONS, POSITION_ROUTES } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PermissionKey, Position, PositionPageMapping, Profile } from "@/lib/types";
import { updatePositionPageAccess } from "@/app/superadmin/actions";
import { CreateUserForm } from "./create-user-form";
import {
  resetEmployeePassword,
  toggleEmployeeStatus,
  updateUserPermissions,
} from "./actions";

const positions: Position[] = ["planning", "production", "warehouse"];
const pages = [
  { path: "/planning-inject", label: "Planning Inject" },
  { path: "/pallet-label", label: "Xuất tem pallet" },
  { path: "/scan-qr", label: "Scan QR" },
  { path: "/warehouse-receipt", label: "Xử lý data tạm" },
] as const;

const allPermissions: Array<{ key: PermissionKey; label: string }> = [
  { key: "planning.upload", label: "Upload planning" },
  { key: "planning.change", label: "Thay đổi planning" },
  { key: "pallet.create", label: "Tạo pallet" },
  { key: "pallet.edit", label: "Sửa pallet" },
  { key: "scan.standard", label: "Scan QR" },
  { key: "receipt.create", label: "Tạo phiếu nhập kho" },
  { key: "receipt.edit", label: "Sửa / hủy phiếu" },
];

const roleRules = [
  { role: "superadmin", system: "Toàn hệ thống", create: "superadmin, admin, user", accounts: "Tất cả tài khoản", mapping: "Được chỉnh", permissions: "Toàn bộ, luôn bypass" },
  { role: "admin", system: "Trong position của mình", create: "Chỉ user cùng position", accounts: "Chỉ user cùng position", mapping: "Không được chỉnh", permissions: "Toàn bộ quyền thuộc position" },
  { role: "user", system: "Không có quyền mặc định", create: "Không", accounts: "Không", mapping: "Không", permissions: "Phải được cấp từng quyền" },
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

  return (
    <PageShell profile={profile} title="Admin dashboard">
      <div className="hero-row">
        <div>
          <p className="eyebrow">{isSuperadmin ? "SUPERADMIN CONTROL CENTER" : "ADMIN CONTROL CENTER"}</p>
          <h1>Quản trị phân quyền hệ thống</h1>
          <p className="muted">
            {isSuperadmin
              ? "Quản lý toàn bộ tài khoản, position mapping và permission của user."
              : `Tạo và quản lý user thuộc position ${profile.position ? POSITION_LABELS[profile.position] : "—"}.`}
          </p>
        </div>
        <div className="stat-card">
          <span className="stat-number">{users.length}</span>
          <span className="muted">Tài khoản có thể quản lý</span>
        </div>
      </div>

      {isSuperadmin ? (
        <>
          <section className="panel">
            <div className="section-heading"><div><p className="eyebrow">ROLE RULES</p><h2>Quyền cố định theo role</h2></div></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Role</th><th>Phạm vi</th><th>Tạo tài khoản</th><th>Quản lý tài khoản</th><th>Position mapping</th><th>Quyền nghiệp vụ</th></tr></thead>
              <tbody>{roleRules.map((rule) => <tr key={rule.role}><td><span className="badge">{rule.role}</span></td><td>{rule.system}</td><td>{rule.create}</td><td>{rule.accounts}</td><td>{rule.mapping}</td><td>{rule.permissions}</td></tr>)}</tbody>
            </table></div>
          </section>

          <section className="panel">
            <div className="section-heading"><div><p className="eyebrow">POSITION PAGE MAPPING</p><h2>Position nào được vào trang nào</h2></div></div>
            <form action={updatePositionPageAccess}>
              <div className="table-wrap"><table>
                <thead><tr><th>Position</th>{pages.map((page) => <th key={page.path}>{page.label}</th>)}</tr></thead>
                <tbody>{positions.map((position) => <tr key={position}><td><strong>{POSITION_LABELS[position]}</strong></td>{pages.map((page) => <td key={page.path}><input aria-label={`${POSITION_LABELS[position]} - ${page.label}`} defaultChecked={mappingEnabled(mappingRows, position, page.path)} name={`position:${position}`} type="checkbox" value={page.path} /></td>)}</tr>)}</tbody>
              </table></div>
              {mappingResult.error ? <p className="alert alert-error">Chưa đọc được position_page_access: {mappingResult.error.message}</p> : null}
              <div style={{ marginTop: "1rem" }}><button className="button button-primary" type="submit">Lưu position mapping</button></div>
            </form>
          </section>
        </>
      ) : null}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACCOUNT MANAGEMENT</p>
            <h2>Tạo tài khoản</h2>
            {!isSuperadmin ? <p className="muted small">Admin chỉ tạo được user thuộc position của mình.</p> : null}
          </div>
        </div>
        <CreateUserForm actorRole={profile.role} actorPosition={profile.position} />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">USER PERMISSION MATRIX</p>
            <h2>Quyền của từng tài khoản</h2>
            <p className="muted small">
              {isSuperadmin
                ? "Hiển thị toàn bộ tài khoản; chỉ user được cấp permission thủ công."
                : `Chỉ hiển thị user thuộc position ${profile.position ? POSITION_LABELS[profile.position] : "—"} và các quyền thuộc position này.`}
            </p>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Tài khoản</th><th>Role</th><th>Position</th>{visiblePermissions.map((permission) => <th key={permission.key}>{permission.label}</th>)}<th>Lưu</th><th>Quản lý</th></tr></thead>
          <tbody>{users.map((user) => {
            const granted = permissionMap.get(user.id) ?? new Set<PermissionKey>();
            const isUser = user.role === "user";
            return <tr key={user.id}>
              <td><strong>{user.full_name}</strong><span className="table-subtext">{user.username}</span></td>
              <td><span className="badge">{user.role}</span></td>
              <td>{user.position ? POSITION_LABELS[user.position] : "Toàn quyền"}</td>
              {visiblePermissions.map((permission) => {
                const fixedChecked = user.role === "superadmin" || Boolean(user.role === "admin" && user.position && POSITION_PERMISSIONS[user.position].includes(permission.key));
                return <td key={permission.key}>{isUser ? <input aria-label={`${user.username} - ${permission.label}`} defaultChecked={granted.has(permission.key)} form={`permissions-${user.id}`} name="permissions" type="checkbox" value={permission.key} /> : <input checked={fixedChecked} disabled readOnly type="checkbox" />}</td>;
              })}
              <td>{isUser ? <form action={updateUserPermissions} id={`permissions-${user.id}`}><input name="user_id" type="hidden" value={user.id} /><button className="button button-small button-primary" type="submit">Lưu</button></form> : <span className="muted small">Theo role</span>}</td>
              <td><div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minWidth: "190px" }}>
                {isSuperadmin ? <form action={resetEmployeePassword} style={{ display: "flex", gap: "0.5rem" }}><input name="user_id" type="hidden" value={user.id} /><input name="password" minLength={8} placeholder="Mật khẩu mới" required type="password" /><button className="button button-small button-secondary" type="submit">Đặt lại</button></form> : null}
                {user.id === profile.id ? <span className="muted small">Tài khoản hiện tại</span> : <form action={toggleEmployeeStatus}><input name="user_id" type="hidden" value={user.id} /><input name="next_status" type="hidden" value={String(!user.is_active)} /><button className="button button-small button-secondary" type="submit">{user.is_active ? "Khóa tài khoản" : "Mở khóa tài khoản"}</button></form>}
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
    </PageShell>
  );
}
