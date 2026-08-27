import { redirect } from "next/navigation";
import { POSITION_PERMISSIONS, POSITION_ROUTES } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AppRole, PermissionKey, Position, Profile } from "@/lib/types";

type LegacyPosition = Position | "pallet" | "scanner";

function normalizePosition(position: LegacyPosition): Position {
  if (position === "pallet") return "production";
  if (position === "scanner") return "warehouse";
  return position;
}

async function loadPermissions(profile: Profile): Promise<PermissionKey[]> {
  if (profile.role === "superadmin") return [];

  // Permissions are managed by admins and may be protected by RLS. Read them
  // with the server-only service-role client after the signed-in user has been
  // identified, so granted permissions are not silently returned as an empty list.
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", profile.id);

  if (error) {
    console.error("loadPermissions failed", {
      userId: profile.id,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map((row) => row.permission_key as PermissionKey);
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();

  // Verify the access token locally from Supabase's signing keys. Unlike
  // getUser(), getClaims() does not make an Auth API request for every page or
  // route when the project uses asymmetric JWT signing keys.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;
  if (claimsError || typeof userId !== "string") return null;

  // Once the token has been verified, load the application profile with the
  // server-only admin client. This keeps page authorization consistent with
  // proxy.ts, catches deleted users through the auth.users foreign key, and
  // prevents profile RLS differences from causing redirect loops.
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
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

export function hasPermission(profile: Profile, permission: PermissionKey) {
  if (profile.role === "superadmin") return true;

  // Dashboard is a role-level default for every admin. User accounts only get
  // access when Super Admin grants dashboard.view in user_permissions.
  if (profile.role === "admin" && permission === "dashboard.view") return true;

  // Department admins receive the standard permissions of their position.
  // Extra permissions granted by Super Admin remain available through
  // profile.permissions below.
  if (
    profile.role === "admin"
    && profile.position
    && POSITION_PERMISSIONS[profile.position].includes(permission)
  ) {
    return true;
  }

  return profile.permissions?.includes(permission) ?? false;
}

export function hasAnyPermission(profile: Profile, permissions: PermissionKey[]) {
  return permissions.some((permission) => hasPermission(profile, permission));
}

export function hasPosition(profile: Profile, position: LegacyPosition) {
  const normalized = normalizePosition(position);
  if (profile.role === "superadmin" || profile.position === normalized) return true;

  // Page mapping may intentionally expose a module to another position. In
  // that case the matching granted permission is the second access layer;
  // proxy.ts still enforces whether that position is mapped to the page.
  return POSITION_PERMISSIONS[normalized].some((permission) =>
    hasPermission(profile, permission),
  );
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

export async function requireAnyPermission(permissions: PermissionKey[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!hasAnyPermission(profile, permissions)) redirect("/dashboard");
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
