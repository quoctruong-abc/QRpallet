"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppRole, Position } from "@/lib/types";

export type AdminActionState = {
  error: string;
  success: string;
};

const validRoles: AppRole[] = ["admin", "user"];
const validPositions: Position[] = ["planning", "pallet", "scanner", "warehouse"];

export async function createEmployee(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();
  const employeeCode = String(formData.get("employee_code") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "user") as AppRole;
  const rawPosition = String(formData.get("position") ?? "");
  const position = rawPosition ? (rawPosition as Position) : null;

  if (!fullName || !email || !password) {
    return { error: "Vui lòng nhập họ tên, email và mật khẩu.", success: "" };
  }
  if (password.length < 8) {
    return { error: "Mật khẩu phải có ít nhất 8 ký tự.", success: "" };
  }
  if (!validRoles.includes(role)) {
    return { error: "Role không hợp lệ.", success: "" };
  }
  if (role === "user" && (!position || !validPositions.includes(position))) {
    return { error: "Người dùng thường phải được gán position.", success: "" };
  }

  const adminClient = createAdminClient();
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      employee_code: employeeCode || null,
    },
  });

  if (createError || !created.user) {
    return {
      error: createError?.message ?? "Không thể tạo tài khoản.",
      success: "",
    };
  }

  const { error: profileError } = await adminClient
    .from("profiles")
    .update({
      full_name: fullName,
      employee_code: employeeCode || null,
      role,
      position: role === "admin" ? null : position,
      is_active: true,
    })
    .eq("id", created.user.id);

  if (profileError) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return {
      error: `Đã tạo Auth user nhưng cấu hình profile thất bại: ${profileError.message}`,
      success: "",
    };
  }

  revalidatePath("/admin");
  return { error: "", success: `Đã tạo tài khoản ${email}.` };
}

export async function toggleEmployeeStatus(formData: FormData) {
  await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const nextStatus = String(formData.get("next_status") ?? "false") === "true";

  if (!userId) return;

  const adminClient = createAdminClient();
  await adminClient.from("profiles").update({ is_active: nextStatus }).eq("id", userId);
  revalidatePath("/admin");
}
