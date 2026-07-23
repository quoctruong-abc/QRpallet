"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Position } from "@/lib/types";

export type PositionMappingActionState = {
  error: string;
  success: string;
};

const validPositions: Position[] = ["planning", "production", "warehouse"];
const validPaths = ["/planning-inject", "/pallet-label", "/scan-qr", "/warehouse-receipt"] as const;

export async function updatePositionPageAccess(
  _previousState: PositionMappingActionState,
  formData: FormData,
): Promise<PositionMappingActionState> {
  const actor = await requireRole("superadmin");
  const adminClient = createAdminClient();

  const rows = validPositions.flatMap((position) =>
    validPaths.map((path) => ({
      position,
      path,
      is_enabled: formData.getAll(`position:${position}`).map(String).includes(path),
    })),
  );

  const { error } = await adminClient
    .from("position_page_access")
    .upsert(rows, { onConflict: "position,path" });

  if (error) {
    return {
      error: `Không thể lưu position mapping: ${error.message}`,
      success: "",
    };
  }

  revalidatePath("/superadmin");
  revalidatePath("/admin");
  revalidatePath("/dashboard");

  return {
    error: "",
    success: `Đã lưu position mapping cho ${validPositions.length} bộ phận bởi ${actor.full_name}.`,
  };
}
