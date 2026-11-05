import { readSheet } from "read-excel-file/node";
import { authorizeProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_OPENING_FILE_BYTES, openingFingerprint, parseOpeningInventory } from "@/lib/warehouse-receipt/opening-inventory";

export const runtime = "nodejs";

function fail(error: string, status: number) {
  return Response.json({ success: false, error }, { status });
}

export async function POST(request: Request) {
  const authorization = await authorizeProfile();
  if (!authorization.ok) return fail(authorization.error, authorization.status);
  if (authorization.profile.role !== "superadmin") return fail("Bạn không có quyền nạp tồn đầu kỳ.", 403);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const action = form?.get("action");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || !file.size) {
    return fail("Vui lòng chọn file Excel .xlsx có sheet Detail.", 400);
  }
  if (file.size > MAX_OPENING_FILE_BYTES) return fail("File Excel vượt quá 4 MB.", 413);
  if (action !== "preview" && action !== "import") return fail("Thao tác không hợp lệ.", 400);

  let sheet;
  try {
    sheet = await readSheet(Buffer.from(await file.arrayBuffer()), "Detail");
  } catch {
    return fail("Không đọc được sheet Detail. Kiểm tra tên sheet và định dạng .xlsx.", 400);
  }
  let parsed;
  try {
    parsed = parseOpeningInventory(sheet);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Dữ liệu Excel không hợp lệ.", 400);
  }
  if (parsed.errorCount) {
    return Response.json({ success: false, error: "File có dòng không hợp lệ. Chưa ghi tồn kho.", errors: parsed.errors, errorCount: parsed.errorCount }, { status: 422 });
  }
  const fingerprint = openingFingerprint(parsed.rows);
  if (action === "preview") {
    return Response.json({ success: true, fingerprint, summary: parsed.summary, rows: parsed.rows.slice(0, 50) });
  }
  if (form?.get("fingerprint") !== fingerprint) {
    return fail("Nội dung đã thay đổi. Hãy kiểm tra lại file trước khi ghi tồn kho.", 409);
  }
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("post_opening_inventory", {
      p_actor: authorization.profile.id, p_fingerprint: fingerprint, p_file_name: file.name.slice(0, 255), p_rows: parsed.rows,
    });
    if (error) throw error;
    if (!data?.[0]) throw new Error("Missing opening inventory result");
    return Response.json({ success: true, result: data[0] });
  } catch (error) {
    console.error("Opening inventory import failed", { fingerprint, error });
    return fail("Chưa xác nhận được kết quả nạp kho. Có thể thử lại với cùng file mà không ghi trùng.", 500);
  }
}
