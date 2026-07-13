import Link from "next/link";
import type { ReactNode } from "react";
import type { Profile } from "@/lib/types";
import { LogoutButton } from "@/components/logout-button";

export function PageShell({
  profile,
  title,
  children,
}: {
  profile: Profile;
  title: string;
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
          <div>
            <strong>{profile.full_name}</strong>
            <p className="muted small">{profile.email}</p>
          </div>
          <LogoutButton />
        </div>
      </header>
      <section className="page-content">{children}</section>
    </main>
  );
}
