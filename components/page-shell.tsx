import Link from "next/link";
import type { ReactNode } from "react";
import type { Profile } from "@/lib/types";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { LogoutButton } from "@/components/logout-button";

export function PageShell({
  profile,
  title,
  headerNavigation,
  children,
}: {
  profile: Profile;
  title: string;
  headerNavigation?: ReactNode;
  children: ReactNode;
}) {
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
          {headerNavigation}
          <div>
            <strong>{profile.full_name}</strong>
            <p className="muted small">{profile.email}</p>
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
