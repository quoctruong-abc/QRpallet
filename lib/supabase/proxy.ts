import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  PAGE_PERMISSIONS,
  POSITION_PERMISSIONS,
  POSITION_ROUTES,
} from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PermissionKey, Position, Profile } from "@/lib/types";

function matchesProtectedPage(pathname: string) {
  return Object.keys(PAGE_PERMISSIONS).find(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function redirectWithSessionCookies(
  request: NextRequest,
  sessionResponse: NextResponse,
  pathname: string,
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  const redirectResponse = NextResponse.redirect(url);
  for (const cookie of sessionResponse.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }
  return redirectResponse;
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  const isLoggedIn = !error && Boolean(userId);
  const pathname = request.nextUrl.pathname;
  const isPublicRoute = pathname === "/login" || pathname === "/inactive";

  if (!isLoggedIn) {
    if (isPublicRoute) return response;

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // API authorization is handled by the API route helpers. Keep the proxy
  // focused on page/session routing.
  if (pathname.startsWith("/api/")) return response;

  // A JWT can remain valid for a short period after its Auth user is deleted.
  // Confirm that this JWT still belongs to an application profile before
  // redirecting away from /login. Without this check a deleted user can loop
  // forever between /login and /dashboard until the old JWT expires.
  const { data: profileData } = await supabase
    .from("profiles")
    .select("id,email,full_name,employee_code,role,position,is_active,created_at,updated_at")
    .eq("id", userId!)
    .maybeSingle();
  const profile = profileData as Profile | null;

  if (!profile) {
    // Local sign-out clears the stale Supabase cookies on this browser/device.
    // It does not revoke sessions on other devices.
    await supabase.auth.signOut({ scope: "local" });

    if (pathname === "/login") {
      return response;
    }

    return redirectWithSessionCookies(request, response, "/login");
  }

  if (!profile.is_active) {
    if (pathname === "/inactive") return response;
    return redirectWithSessionCookies(request, response, "/inactive");
  }

  if (pathname === "/login" || pathname === "/inactive") {
    return redirectWithSessionCookies(request, response, "/dashboard");
  }

  if (pathname.startsWith("/superadmin") && profile.role !== "superadmin") {
    return redirectWithSessionCookies(request, response, "/dashboard");
  }

  if (pathname.startsWith("/admin") && !["superadmin", "admin"].includes(profile.role)) {
    return redirectWithSessionCookies(request, response, "/dashboard");
  }

  const protectedPage = matchesProtectedPage(pathname);
  if (!protectedPage || profile.role === "superadmin") return response;

  const position = profile.position as Position | null;
  if (!position) {
    return redirectWithSessionCookies(request, response, "/dashboard");
  }

  // Mapping and permissions are administrative data. Read them with the
  // service-role client so RLS cannot silently hide granted access.
  const adminClient = createAdminClient();
  const { data: mappingRow, error: mappingError } = await adminClient
    .from("position_page_access")
    .select("is_enabled")
    .eq("position", position)
    .eq("path", protectedPage)
    .maybeSingle();

  const positionMapped = mappingError || !mappingRow
    ? POSITION_ROUTES[position]?.includes(protectedPage)
    : Boolean(mappingRow.is_enabled);

  if (!positionMapped) {
    return redirectWithSessionCookies(request, response, "/dashboard");
  }

  const { data: permissionRows, error: permissionError } = await adminClient
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", profile.id);

  if (permissionError) {
    console.error("proxy permission lookup failed", {
      userId: profile.id,
      message: permissionError.message,
    });
  }

  const granted = new Set<PermissionKey>(
    profile.role === "admin" ? POSITION_PERMISSIONS[position] : [],
  );
  for (const row of permissionRows ?? []) {
    granted.add(row.permission_key as PermissionKey);
  }

  if (PAGE_PERMISSIONS[protectedPage].some((permission) => granted.has(permission))) {
    return response;
  }

  return redirectWithSessionCookies(request, response, "/dashboard");
}
