import Link from "next/link";
import type { ReactNode } from "react";
import { hasPermission } from "@/lib/auth";
import { POSITION_ROUTES } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PermissionKey, Profile } from "@/lib/types";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { LogoutButton } from "@/components/logout-button";

const modules: Array<{
  path: string;
  label: string;
  icon: string;
  permissions: PermissionKey[];
}> = [
  {
    path: "/production-dashboard",
    label: "Dashboard sản xuất",
    icon: "📊",
    permissions: ["dashboard.view"],
  },
  { path: "/planning-inject", label: "Update kế hoạch", icon: "📋", permissions: ["planning.upload", "planning.change"] },
  { path: "/pallet-label", label: "In tem pallet", icon: "🏭", permissions: ["pallet.create", "pallet.edit"] },
  { path: "/scan-qr", label: "Scan để nhập kho", icon: "▣", permissions: ["scan.standard"] },
  {
    path: "/warehouse-receipt",
    label: "Xem phiếu nhập kho",
    icon: "📦",
    permissions: ["receipt.view"],
  },
];

async function loadMappedPaths(profile: Profile) {
  if (profile.role === "superadmin") {
    return new Set(modules.map((module) => module.path));
  }
  if (!profile.position) return new Set<string>();

  const fallback = new Set(POSITION_ROUTES[profile.position]);
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("position_page_access")
    .select("path,is_enabled")
    .eq("position", profile.position);

  if (error || !data) return fallback;

  const mapped = new Set<string>();
  for (const row of data) {
    if (row.is_enabled) mapped.add(String(row.path));
  }
  return mapped;
}

export async function PageShell({
  profile,
  title,
  children,
}: {
  profile: Profile;
  title: string;
  children: ReactNode;
}) {
  const mappedPaths = await loadMappedPaths(profile);
  const visibleModules = modules.filter((module) => {
    if (module.path === "/production-dashboard") {
      return hasPermission(profile, "dashboard.view");
    }

    const mapped = profile.role === "superadmin" || mappedPaths.has(module.path);
    const permitted = module.permissions.some((permission) => hasPermission(profile, permission));
    return mapped && permitted;
  });
  const userInitial = profile.full_name.trim().charAt(0).toUpperCase() || "U";
  const homePath = profile.role === "superadmin" || profile.role === "admin"
    ? "/admin"
    : "/dashboard";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand-area">
          <Link className="brand" href={homePath}>
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
