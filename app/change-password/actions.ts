"use server";

import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ChangePasswordState = {
  error: string;
  success: string;
};

export async function changePassword(
  _previousState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  await requireProfile();

  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirm_password") ?? "");

  if (password.length < 8) {
    return { error: "Mật khẩu mới phải có ít nhất 8 ký tự.", success: "" };
  }
  if (password !== confirmPassword) {
    return { error: "Mật khẩu xác nhận không khớp.", success: "" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: `Không thể đổi mật khẩu: ${error.message}`, success: "" };
  }

  return { error: "", success: "Đã đổi mật khẩu thành công." };
}
