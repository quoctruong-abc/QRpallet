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
  permission: PermissionKey;
}> = [
  { path: "/planning-inject", label: "Update kế hoạch", icon: "📋", permission: "planning.upload" },
  { path: "/pallet-label", label: "In tem pallet", icon: "🏭", permission: "pallet.create" },
  { path: "/scan-qr", label: "Scan để nhập kho", icon: "▣", permission: "scan.standard" },
  { path: "/warehouse-receipt", label: "Xác nhận chuyển kho", icon: "📦", permission: "receipt.create" },
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
  const visibleModules = modules.filter((module) => hasPermission(profile, module.permission));

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
