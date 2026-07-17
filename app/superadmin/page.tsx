import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

export default async function SuperadminPage() {
  await requireRole("superadmin");
  redirect("/admin");
}
