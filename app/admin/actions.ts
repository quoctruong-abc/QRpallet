"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { POSITION_PERMISSIONS } from "@/lib/routes";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUsername, normalizeUsername, usernameToInternalEmail } from "@/lib/username";
import type { AppRole, PermissionKey, Position } from "@/lib/types";

export type AdminActionState = { error: string; success: string };

const validRoles: AppRole[] = ["superadmin", "admin", "user"];
const validPositions: Position[] = ["planning", "production", "warehouse"];
const validPermissions = new Set<PermissionKey>(Object.values(POSITION_PERMISSIONS).flat());

function canManageTarget(
  actor: Awaited<ReturnType<typeof requireAdmin>>,
  target: { id: string; role: AppRole; position: Position | null },
) {
  if (actor.role === "superadmin") return true;
  return target.role === "user" && target.position === actor.position && target.id !== actor.id;
}

export async function createEmployee(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const actor = await requireAdmin();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const employeeCode = String(formData.get("employee_code") ?? "").trim();
  const username = normalizeUsername(String(formData.get("username") ?? ""));
  const password = String(formData.get("password") ?? "");
  const requestedRole = String(formData.get("role") ?? "user") as AppRole;
  const requestedPosition = String(formData.get("position") ?? "") as Position;

  if (!fullName || !username || !password) {
    return { error: "Vui lòng nhập họ tên, tên đăng nhập và mật khẩu.", success: "" };
  }
  if (!isValidUsername(username)) {
    return { error: "Tên đăng nhập phải có 3-32 ký tự và chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.", success: "" };
  }
  if (password.length < 8) {
    return { error: "Mật khẩu phải có ít nhất 8 ký tự.", success: "" };
  }
  if (!validRoles.includes(requestedRole)) {
    return { error: "Role không hợp lệ.", success: "" };
  }

  const role: AppRole = actor.role === "superadmin" ? requestedRole : "user";
  const position: Position | null =
    role === "superadmin"
      ? null
      : actor.role === "admin"
        ? actor.position
        : requestedPosition;

  if (role !== "superadmin" && (!position || !validPositions.includes(position))) {
    return { error: "Admin và user phải thuộc một position hợp lệ.", success: "" };
  }
  if (actor.role === "admin" && requestedRole !== "user") {
    return { error: "Admin chỉ được tạo tài khoản role=user.", success: "" };
  }

  const adminClient = createAdminClient();
  const { data: existingProfile } = await adminClient
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existingProfile) {
    return { error: "Tên đăng nhập đã tồn tại.", success: "" };
  }

  const internalEmail = usernameToInternalEmail(username);
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: internalEmail,
    password,
    email_confirm: true,
    user_metadata: { username, full_name: fullName, employee_code: employeeCode || null },
  });
  if (createError || !created.user) {
    return { error: createError?.message ?? "Không thể tạo tài khoản.", success: "" };
  }

  const { error: profileError } = await adminClient.from("profiles").update({
    username,
    full_name: fullName,
    employee_code: employeeCode || null,
    role,
    position,
    is_active: true,
  }).eq("id", created.user.id);

  if (profileError) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return { error: `Không thể lưu profile: ${profileError.message}`, success: "" };
  }

  await adminClient.from("user_permissions").delete().eq("user_id", created.user.id);
  revalidatePath("/admin");
  return { error: "", success: `Đã tạo tài khoản ${username}.` };
}

export async function toggleEmployeeStatus(formData: FormData) {
  const actor = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const nextStatus = String(formData.get("next_status") ?? "false") === "true";
  if (!userId || userId === actor.id) return;

  const adminClient = createAdminClient();
  const { data: target } = await adminClient
    .from("profiles")
    .select("id,role,position")
    .eq("id", userId)
    .maybeSingle();
  if (!target || !canManageTarget(actor, target as { id: string; role: AppRole; position: Position | null })) {
    throw new Error("Bạn không có quyền chỉnh tài khoản này.");
  }

  await adminClient.from("profiles").update({ is_active: nextStatus }).eq("id", userId);
  revalidatePath("/admin");
}

export async function updateUserPermissions(formData: FormData) {
  const actor = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const requested = formData.getAll("permissions").map(String) as PermissionKey[];
  if (!userId) return;

  const adminClient = createAdminClient();
  const { data: target } = await adminClient
    .from("profiles")
    .select("id,role,position")
    .eq("id", userId)
    .maybeSingle();
  if (!target || !canManageTarget(actor, target as { id: string; role: AppRole; position: Position | null })) {
    throw new Error("Bạn không có quyền chỉnh permissions của tài khoản này.");
  }

  const targetPosition = target.position as Position | null;
  const allowed = actor.role === "superadmin"
    ? requested.filter((permission) => validPermissions.has(permission))
    : requested.filter((permission) =>
        Boolean(targetPosition && POSITION_PERMISSIONS[targetPosition].includes(permission)),
      );

  await adminClient.from("user_permissions").delete().eq("user_id", userId);
  if (allowed.length > 0) {
    await adminClient.from("user_permissions").insert(
      allowed.map((permission_key) => ({
        user_id: userId,
        permission_key,
        granted_by: actor.id,
      })),
    );
  }
  revalidatePath("/admin");
}
