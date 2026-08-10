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
const validPermissions = new Set<PermissionKey>([
  ...Object.values(POSITION_PERMISSIONS).flat(),
  "dashboard.view",
]);

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
  const { data: existingProfile, error: existingError } = await adminClient
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (existingError) {
    return { error: `Không thể kiểm tra tên đăng nhập: ${existingError.message}`, success: "" };
  }
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

  const { error: permissionCleanupError } = await adminClient
    .from("user_permissions")
    .delete()
    .eq("user_id", created.user.id);

  if (permissionCleanupError) {
    return {
      error: `Đã tạo tài khoản nhưng không thể khởi tạo quyền: ${permissionCleanupError.message}`,
      success: "",
    };
  }

  revalidatePath("/admin");
  revalidatePath("/superadmin");
  return { error: "", success: `Đã tạo tài khoản ${username} thành công.` };
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

export async function resetEmployeePassword(formData: FormData) {
  const actor = await requireAdmin();
  if (actor.role !== "superadmin") {
    throw new Error("Chỉ superadmin được đặt lại mật khẩu.");
  }

  const userId = String(formData.get("user_id") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!userId) {
    throw new Error("Không xác định được tài khoản cần đặt lại mật khẩu.");
  }
  if (password.length < 8) {
    throw new Error("Mật khẩu mới phải có ít nhất 8 ký tự.");
  }

  const adminClient = createAdminClient();
  const { data: target } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (!target) {
    throw new Error("Tài khoản không tồn tại.");
  }

  const { error } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (error) {
    throw new Error(`Không thể đặt lại mật khẩu: ${error.message}`);
  }

  revalidatePath("/admin");
}

export async function updateUserPermissions(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const actor = await requireAdmin();
  const userId = String(formData.get("user_id") ?? "").trim();
  const requested = Array.from(new Set(
    formData.getAll("permissions").map(String),
  )) as PermissionKey[];

  if (!userId) {
    return { error: "Không xác định được tài khoản cần lưu quyền.", success: "" };
  }

  const adminClient = createAdminClient();
  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id,username,full_name,role,position")
    .eq("id", userId)
    .maybeSingle();

  if (targetError) {
    return { error: `Không thể đọc tài khoản: ${targetError.message}`, success: "" };
  }
  if (!target || !canManageTarget(actor, target as { id: string; role: AppRole; position: Position | null })) {
    return { error: "Bạn không có quyền chỉnh permissions của tài khoản này.", success: "" };
  }

  const targetPosition = target.position as Position | null;
  const manageablePermissions = actor.role === "superadmin"
    ? validPermissions
    : new Set<PermissionKey>(targetPosition ? POSITION_PERMISSIONS[targetPosition] : []);

  const allowed = requested.filter((permission) => manageablePermissions.has(permission));

  const { data: existingRows, error: existingError } = await adminClient
    .from("user_permissions")
    .select("permission_key")
    .eq("user_id", userId);

  if (existingError) {
    return { error: `Không thể đọc quyền hiện tại: ${existingError.message}`, success: "" };
  }

  const existing = new Set(
    (existingRows ?? []).map((row) => String(row.permission_key) as PermissionKey),
  );
  const allowedSet = new Set(allowed);
  const toAdd = allowed.filter((permission) => !existing.has(permission));
  const toDelete = Array.from(existing).filter(
    (permission) => manageablePermissions.has(permission) && !allowedSet.has(permission),
  );

  if (toAdd.length > 0) {
    const { error: insertError } = await adminClient.from("user_permissions").insert(
      toAdd.map((permission_key) => ({
        user_id: userId,
        permission_key,
        granted_by: actor.id,
      })),
    );

    if (insertError) {
      return {
        error: `Không thể thêm quyền cho ${target.full_name || target.username}: ${insertError.message}`,
        success: "",
      };
    }
  }

  if (toDelete.length > 0) {
    const { error: deleteError } = await adminClient
      .from("user_permissions")
      .delete()
      .eq("user_id", userId)
      .in("permission_key", toDelete);

    if (deleteError) {
      if (toAdd.length > 0) {
        await adminClient
          .from("user_permissions")
          .delete()
          .eq("user_id", userId)
          .in("permission_key", toAdd);
      }
      return {
        error: `Không thể gỡ quyền của ${target.full_name || target.username}: ${deleteError.message}`,
        success: "",
      };
    }
  }

  revalidatePath("/admin");
  revalidatePath("/superadmin");

  return {
    error: "",
    success: `Đã lưu ${allowed.length} quyền cho ${target.full_name || target.username}.`,
  };
}
