"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { POSITION_ROUTES } from "@/lib/routes";
import type { Position, Profile } from "@/lib/types";

export type LoginState = { error: string };

export async function login(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Vui lòng nhập email và mật khẩu." };
  }

  const supabase = await createClient();
  const { data: signInData, error: signInError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (signInError || !signInData.user) {
    return { error: "Email hoặc mật khẩu không đúng." };
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

  if (profile.role === "admin") redirect("/admin");

  if (!profile.position) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Tài khoản chưa được gán position." };
  }

  redirect(POSITION_ROUTES[profile.position as Position]);
}
