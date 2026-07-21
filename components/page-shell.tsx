import Link from "next/link";
import type { ReactNode } from "react";
import { hasPermission } from "@/lib/auth";
import type { PermissionKey, Profile } from "@/lib/types";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { LogoutButton } from "@/components/logout-button";

const modules: Array<{
  path: string;
  label: string;
  icon: string;
  permissions: PermissionKey[];
  adminOnly?: boolean;
}> = [
  {
    path: "/production-dashboard",
    label: "Dashboard sản xuất",
    icon: "📊",
    permissions: [],
    adminOnly: true,
  },
  { path: "/planning-inject", label: "Update kế hoạch", icon: "📋", permissions: ["planning.upload"] },
  { path: "/pallet-label", label: "In tem pallet", icon: "🏭", permissions: ["pallet.create"] },
  { path: "/scan-qr", label: "Scan để nhập kho", icon: "▣", permissions: ["scan.standard"] },
  { path: "/warehouse-receipt", label: "Xem phiếu nhập kho", icon: "📦", permissions: ["receipt.view"] },
];

export function PageShell({
  profile,
  title,
  children,
}: {
  profile: Profile;
  title: string;
  children: ReactNode;
}) {
  const visibleModules = modules.filter((module) => {
    if (module.adminOnly) return profile.role === "admin" || profile.role === "superadmin";
    return module.permissions.some((permission) => hasPermission(profile, permission));
  });
  const userInitial = profile.full_name.trim().charAt(0).toUpperCase() || "U";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand-area">
          <Link className="brand" href={profile.role === "admin" ? "/admin" : "/dashboard"}>
            SVN Warehouse
          </Link>
          <p className="muted topbar-subtitle" title={title}>{title}</p>
        </div>

        {visibleModules.length ? (
          <nav aria-label="Điều hướng module" className="topbar-nav">
            {visibleModules.map((module) => (
              <Link
                aria-label={module.label}
                className="topbar-module-link"
                href={module.path}
                key={module.path}
                title={module.label}
              >
                <span aria-hidden="true" className="topbar-module-icon">{module.icon}</span>
                <span className="topbar-module-label">{module.label}</span>
              </Link>
            ))}
          </nav>
        ) : null}

        <div className="topbar-account">
          <div className="topbar-identity" title={profile.full_name}>
            <span aria-hidden="true" className="topbar-avatar">{userInitial}</span>
            <strong className="topbar-user-name">{profile.full_name}</strong>
          </div>
          <div className="topbar-actions">
            <ChangePasswordDialog />
            <LogoutButton />
          </div>
        </div>
      </header>
      <section className="page-content">{children}</section>
    </main>
  );
}
