import { createHash } from "node:crypto";
import { readSheet } from "read-excel-file/node";
import { authorizeProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { MAX_MASTER_FILE_BYTES, parseWarehouseMasterData } from "@/lib/warehouse-receipt/master-data";

export const runtime = "nodejs";
export const maxDuration = 60;

const fail = (error: string, status: number) => Response.json({ success: false, error }, { status });

export async function POST(request: Request) {
  const auth = await authorizeProfile();
  if (!auth.ok) return fail(auth.error, auth.status);
  if (auth.profile.role !== "superadmin") return fail("Chỉ Super Admin có quyền nạp master data.", 403);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const action = form?.get("action");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || !file.size) {
    return fail("Vui lòng chọn file .xlsx có sheet data.", 400);
  }
  if (file.size > MAX_MASTER_FILE_BYTES) return fail("File Excel vượt quá 4 MB.", 413);
  if (action !== "preview" && action !== "import") return fail("Thao tác không hợp lệ.", 400);

  let sheet;
  try {
    sheet = await readSheet(Buffer.from(await file.arrayBuffer()), "data", { trim: false });
  } catch {
    return fail("Không đọc được sheet data. Kiểm tra tên sheet và định dạng .xlsx.", 400);
  }
  let parsed;
  try {
    parsed = parseWarehouseMasterData(sheet);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : "Dữ liệu Excel không hợp lệ.", 400);
  }
  if (parsed.errorCount) {
    return Response.json({ success: false, error: "File có dữ liệu không hợp lệ. Chưa đồng bộ master data.",
      errors: parsed.errors, errorCount: parsed.errorCount }, { status: 422 });
  }
  const rows = parsed.rows.map(({ itemcode, erp_name, netweight }) => ({ itemcode, erp_name, netweight }));
  const fingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  if (action === "import" && form?.get("fingerprint") !== fingerprint) {
    return fail("Nội dung file đã thay đổi. Hãy kiểm tra lại trước khi xác nhận nạp.", 409);
  }

  const db = await createClient();
  const { data, error } = await db.rpc("sync_warehouse_master_data", { p_rows: rows, p_preview: action === "preview" });
  if (error || !data) {
    if (error?.message.includes("MASTER_DATA_NOT_AUTHORIZED")) return fail("Chỉ Super Admin có quyền nạp master data.", 403);
    if (error?.code === "PGRST202" || error?.code === "42883") return fail("Cần chạy migration 20261112100000_warehouse_master_data.sql để nạp master data.", 503);
    console.error("Warehouse master data sync failed", { action, error });
    return fail(action === "preview" ? "Không thể kiểm tra master data. Vui lòng thử lại."
      : "Chưa xác nhận được kết quả. Có thể nạp lại cùng file mà không tạo mã trùng.", 500);
  }
  return Response.json(action === "preview"
    ? { success: true, fingerprint, counts: data, rows: parsed.rows.slice(0, 50), duplicateCount: parsed.duplicateCount }
    : { success: true, counts: data }, { headers: { "Cache-Control": "no-store" } });
}
