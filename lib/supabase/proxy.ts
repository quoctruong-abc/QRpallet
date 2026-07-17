import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { PAGE_PERMISSIONS, POSITION_PERMISSIONS, POSITION_ROUTES } from "@/lib/routes";
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

  if (pathname.startsWith("/admin") && !["superadmin", "admin"].includes(profile.role)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  const protectedPage = matchesProtectedPage(pathname);
  if (!protectedPage || profile.role === "superadmin") return response;

  const position = profile.position as Position | null;
  const positionMapped = Boolean(
    position && POSITION_ROUTES[position]?.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    ),
  );
  if (!positionMapped) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  if (profile.role === "admin") {
    const required = PAGE_PERMISSIONS[protectedPage];
    const adminPermissions = position ? POSITION_PERMISSIONS[position] : [];
    if (required.some((permission) => adminPermissions.includes(permission))) return response;
  } else {
    const { data: permissionRows } = await supabase
      .from("user_permissions")
      .select("permission_key")
      .eq("user_id", profile.id);
    const granted = new Set(
      (permissionRows ?? []).map((row) => row.permission_key as PermissionKey),
    );
    if (PAGE_PERMISSIONS[protectedPage].some((permission) => granted.has(permission))) {
      return response;
    }
  }

  const url = request.nextUrl.clone();
  url.pathname = "/dashboard";
  return NextResponse.redirect(url);
}
