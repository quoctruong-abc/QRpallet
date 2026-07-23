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

  if (!isLoggedIn && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (isLoggedIn && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (!isLoggedIn || isPublicRoute || pathname.startsWith("/api/")) return response;

  const { data: profileData } = await supabase
    .from("profiles")
    .select("id,email,full_name,employee_code,role,position,is_active,created_at,updated_at")
    .eq("id", userId!)
    .maybeSingle();
  const profile = profileData as Profile | null;

  if (!profile) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (!profile.is_active && pathname !== "/inactive") {
    const url = request.nextUrl.clone();
    url.pathname = "/inactive";
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/superadmin") && profile.role !== "superadmin") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/admin") && !["superadmin", "admin"].includes(profile.role)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  const protectedPage = matchesProtectedPage(pathname);
  if (!protectedPage || profile.role === "superadmin") return response;

  const position = profile.position as Position | null;
  if (!position) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
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
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
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

  const url = request.nextUrl.clone();
  url.pathname = "/dashboard";
  return NextResponse.redirect(url);
}
