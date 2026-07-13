import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { POSITION_ROUTES } from "@/lib/routes";

export default async function DashboardPage() {
  const profile = await requireProfile();

  if (profile.role === "admin") redirect("/admin");
  if (!profile.position) redirect("/inactive");

  redirect(POSITION_ROUTES[profile.position]);
}
