"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { POSITION_ROUTES } from "@/lib/routes";
import { isValidUsername, normalizeUsername, usernameToInternalEmail } from "@/lib/username";
import type { Profile } from "@/lib/types";

export type LoginState = { error: string };

export async function login(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = normalizeUsername(String(formData.get("username") ?? ""));
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Vui lòng nhập tên đăng nhập và mật khẩu." };
  }
  if (!isValidUsername(username)) {
    return { error: "Tên đăng nhập không hợp lệ." };
  }

  const supabase = await createClient();

  // A browser can still hold a JWT after its Auth user has been deleted.
  // Always clear the local session before a fresh username/password login so
  // an orphaned token can never interfere with the new session.
  await supabase.auth.signOut({ scope: "local" });

  const email = usernameToInternalEmail(username);
  const { data: signInData, error: signInError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (signInError) {
    const errorDetails = [
      signInError.code ? `code: ${signInError.code}` : null,
      signInError.status ? `status: ${signInError.status}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    return {
      error: `Lỗi đăng nhập Supabase${errorDetails ? ` (${errorDetails})` : ""}: ${signInError.message}`,
    };
  }

  if (!signInData.user) {
    return {
      error: "Lỗi đăng nhập: Supabase không trả về thông tin người dùng.",
    };
  }

  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", signInData.user.id)
    .single();

  if (profileError || !profileData) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Tài khoản chưa được cấu hình hồ sơ/phân quyền." };
  }

  const profile = profileData as Profile;
  if (!profile.is_active) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Tài khoản đã bị khóa. Vui lòng liên hệ admin." };
  }

  if (profile.role === "superadmin" || profile.role === "admin") {
    redirect("/admin");
  }

  if (!profile.position) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Tài khoản chưa được gán position." };
  }

  const defaultRoute = POSITION_ROUTES[profile.position][0];
  if (!defaultRoute) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Position chưa được cấu hình trang truy cập." };
  }

  redirect(defaultRoute);
}
