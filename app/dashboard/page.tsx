import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { POSITION_ROUTES } from "@/lib/routes";

export default async function DashboardPage() {
  const profile = await requireProfile();

  if (profile.role === "superadmin" || profile.role === "admin") redirect("/admin");
  if (!profile.position) redirect("/inactive");

  const defaultRoute = POSITION_ROUTES[profile.position][0];
  if (!defaultRoute) redirect("/inactive");

  redirect(defaultRoute);
}
