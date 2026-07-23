import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { POSITION_ROUTES } from "@/lib/routes";
import type { AppRole, PermissionKey, Position, Profile } from "@/lib/types";

type LegacyPosition = Position | "pallet" | "scanner";

function normalizePosition(position: LegacyPosition): Position {
  if (position === "pallet") return "production";
  if (position === "scanner") return "warehouse";
  return position;
}

async function loadPermissions(profile: Profile): Promise<PermissionKey[]> {
  if (profile.role === "superadmin") return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", profile.id);
  return (data ?? []).map((row) => row.permission_key as PermissionKey);
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || !userId) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error || !data) return null;

  const profile = data as Profile;
  profile.permissions = await loadPermissions(profile);
  return profile;
}

export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.is_active) redirect("/inactive");
  return profile;
}

export function hasRole(profile: Profile, roles: AppRole | AppRole[]) {
  return (Array.isArray(roles) ? roles : [roles]).includes(profile.role);
}

export function hasPosition(profile: Profile, position: LegacyPosition) {
  const normalized = normalizePosition(position);
  return profile.role === "superadmin" || profile.position === normalized;
}

export function hasPermission(profile: Profile, permission: PermissionKey) {
  if (profile.role === "superadmin") return true;
  if (profile.role === "admin" && permission === "receipt.view") return true;
  return profile.permissions?.includes(permission) ?? false;
}

export function canAccessPath(profile: Profile, pathname: string) {
  if (profile.role === "superadmin") return true;
  const position = profile.position;
  if (!position) return false;
  return POSITION_ROUTES[position].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function requireRole(roles: AppRole | AppRole[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!hasRole(profile, roles)) redirect("/dashboard");
  return profile;
}

export async function requireAdmin(): Promise<Profile> {
  return requireRole(["superadmin", "admin"]);
}

export async function requirePosition(position: LegacyPosition): Promise<Profile> {
  const profile = await requireProfile();
  if (!hasPosition(profile, position)) redirect("/dashboard");
  return profile;
}

export async function requirePermission(permission: PermissionKey): Promise<Profile> {
  const profile = await requireProfile();
  if (!hasPermission(profile, permission)) redirect("/dashboard");
  return profile;
}

export type ApiAuthorization =
  | { ok: true; profile: Profile }
  | { ok: false; status: 401 | 403; error: string };

export async function authorizeProfile(): Promise<ApiAuthorization> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, status: 401, error: "Phiên đăng nhập đã hết hạn." };
  if (!profile.is_active) return { ok: false, status: 403, error: "Tài khoản đã bị khóa." };
  return { ok: true, profile };
}

export async function authorizePermission(permission: PermissionKey): Promise<ApiAuthorization> {
  const authorization = await authorizeProfile();
  if (!authorization.ok) return authorization;
  if (!hasPermission(authorization.profile, permission)) {
    return { ok: false, status: 403, error: "Bạn không có quyền thực hiện chức năng này." };
  }
  return authorization;
}
