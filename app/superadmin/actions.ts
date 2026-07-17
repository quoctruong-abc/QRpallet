"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Position } from "@/lib/types";

const validPositions: Position[] = ["planning", "production", "warehouse"];
const validPaths = ["/planning-inject", "/pallet-label", "/scan-qr", "/warehouse-receipt"] as const;

export async function updatePositionPageAccess(formData: FormData) {
  const actor = await requireRole("superadmin");
  const adminClient = createAdminClient();

  const rows = validPositions.flatMap((position) =>
    validPaths.map((path) => ({
      position,
      path,
      is_enabled: formData.getAll(`position:${position}`).map(String).includes(path),
      updated_by: actor.id,
      updated_at: new Date().toISOString(),
    })),
  );

  const { error } = await adminClient
    .from("position_page_access")
    .upsert(rows, { onConflict: "position,path" });

  if (error) {
    throw new Error(`Không thể cập nhật quyền truy cập trang: ${error.message}`);
  }

  revalidatePath("/superadmin");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
}
