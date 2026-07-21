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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <Link className="brand" href={profile.role === "admin" ? "/admin" : "/dashboard"}>
            SVN Warehouse
          </Link>
          <p className="muted topbar-subtitle">{title}</p>
        </div>

        <div className="topbar-user">
          {visibleModules.length ? (
            <nav
              aria-label="Điều hướng module"
              style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}
            >
              {visibleModules.map((module) => (
                <Link
                  aria-label={module.label}
                  href={module.path}
                  key={module.path}
                  title={module.label}
                  style={{
                    alignItems: "center",
                    background: "rgba(255,255,255,0.72)",
                    border: "1px solid rgba(148,163,184,0.45)",
                    borderRadius: "0.7rem",
                    display: "inline-flex",
                    fontSize: "1.25rem",
                    height: "2.5rem",
                    justifyContent: "center",
                    lineHeight: 1,
                    textDecoration: "none",
                    width: "2.5rem",
                  }}
                >
                  <span aria-hidden="true">{module.icon}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          <div>
            <strong>{profile.full_name}</strong>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <ChangePasswordDialog />
            <LogoutButton />
          </div>
        </div>
      </header>
      <section className="page-content">{children}</section>
    </main>
  );
}
