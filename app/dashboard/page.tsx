import { redirect } from "next/navigation";
import { PageShell } from "@/components/page-shell";
import { hasPermission, requireProfile } from "@/lib/auth";
import { PAGE_PERMISSIONS, POSITION_ROUTES } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function DashboardPage() {
  const profile = await requireProfile();

  if (profile.role === "superadmin" || profile.role === "admin") {
    redirect("/admin");
  }

  if (!profile.position) {
    return (
      <PageShell profile={profile} title="Trang chủ">
        <section className="panel">
          <h1>Chưa được cấu hình truy cập</h1>
          <p className="muted">
            Tài khoản chưa được gán position. Vui lòng liên hệ quản trị viên.
          </p>
        </section>
      </PageShell>
    );
  }

  const adminClient = createAdminClient();
  const { data: mappingRows, error: mappingError } = await adminClient
    .from("position_page_access")
    .select("path,is_enabled")
    .eq("position", profile.position);

  const fallbackRoutes = POSITION_ROUTES[profile.position];
  const mappedRoutes =
    !mappingError && mappingRows && mappingRows.length > 0
      ? new Set(
          mappingRows
            .filter((row) => row.is_enabled)
            .map((row) => String(row.path)),
        )
      : new Set(fallbackRoutes);

  // Dashboard production is independent from position page mapping and is
  // available only when dashboard.view has been granted.
  if (hasPermission(profile, "dashboard.view")) {
    redirect("/production-dashboard");
  }

  const defaultRoute = fallbackRoutes.find((path) => {
    if (!mappedRoutes.has(path)) return false;
    const requiredPermissions = PAGE_PERMISSIONS[path] ?? [];
    return requiredPermissions.some((permission) => hasPermission(profile, permission));
  });

  if (defaultRoute) {
    redirect(defaultRoute);
  }

  // Never redirect back and forth between /dashboard and a module the user
  // cannot access. This is especially important after permissions or mapping
  // data has been cleared during a production reset.
  return (
    <PageShell profile={profile} title="Trang chủ">
      <section className="panel">
        <h1>Chưa được cấp quyền truy cập</h1>
        <p className="muted">
          Tài khoản hiện không có quyền vào module nào. Vui lòng liên hệ quản trị viên để cấp lại quyền.
        </p>
      </section>
    </PageShell>
  );
}
