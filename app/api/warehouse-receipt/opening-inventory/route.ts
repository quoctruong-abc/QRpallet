import { readSheet } from "read-excel-file/node";
import { authorizeProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInventoryDate } from "@/lib/warehouse-receipt/incoming";
import { MAX_OPENING_FILE_BYTES, openingFingerprint, parseOpeningInventory } from "@/lib/warehouse-receipt/opening-inventory";

export const runtime = "nodejs";

function fail(error: string, status: number) {
  return Response.json({ success: false, error }, { status });
}

function invalidRows(errors: { row: number; message: string }[], errorCount: number) {
  return Response.json({ success: false, error: "File có dòng không hợp lệ. Chưa ghi tồn kho.", errors, errorCount }, { status: 422 });
}

export async function POST(request: Request) {
  const authorization = await authorizeProfile();
  if (!authorization.ok) return fail(authorization.error, authorization.status);
  if (authorization.profile.role !== "superadmin") return fail("Bạn không có quyền nạp tồn đầu kỳ.", 403);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const action = form?.get("action");
  const openingDate = form?.get("openingDate");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || !file.size) {
    return fail("Vui lòng chọn file Excel .xlsx có sheet Detail.", 400);
  }
  if (file.size > MAX_OPENING_FILE_BYTES) return fail("File Excel vượt quá 4 MB.", 413);
  if (action !== "preview" && action !== "import") return fail("Thao tác không hợp lệ.", 400);
  if (openingDate && !isInventoryDate(openingDate)) return fail("Ngày nhập cho tồn đầu không hợp lệ.", 400);

  let sheet;
  try {
    // Excel can store a text formula with no cached value. Leave trimming
    // to our cell parsers so the reader treats those cells as empty.
    sheet = await readSheet(Buffer.from(await file.arrayBuffer()), "Detail", { trim: false });
  } catch {
    return fail("Không đọc được sheet Detail. Kiểm tra tên sheet và định dạng .xlsx.", 400);
  }
  let parsed;
  try {
    parsed = parseOpeningInventory(sheet, isInventoryDate(openingDate) ? openingDate : undefined);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Dữ liệu Excel không hợp lệ.", 400);
  }
  if (parsed.errorCount) {
    return invalidRows(parsed.errors, parsed.errorCount);
  }
  const fingerprint = openingFingerprint(parsed.rows);
  if (action === "preview") {
    const preview = parsed.rows.slice(0, 50);
    const fallbackRows = parsed.rows.filter((row) => !row.product_name);
    const codes = [...new Set([...preview, ...fallbackRows].map((row) => row.itemcode))];
    const items = new Map<string, { product_name: string | null; customer: string | null }>();
    try {
      const admin = createAdminClient();
      const chunkSize = 500;
      for (let i = 0; i < codes.length; i += 4 * chunkSize) {
        const chunks = Array.from({ length: Math.min(4, Math.ceil((codes.length - i) / chunkSize)) }, (_, j) =>
          codes.slice(i + j * chunkSize, i + (j + 1) * chunkSize));
        const results = await Promise.all(chunks.map((p_itemcodes) => admin.rpc("lookup_opening_inventory_items", { p_itemcodes })));
        for (const { data, error } of results) {
          if (error) throw error;
          for (const item of data ?? []) items.set(item.itemcode, item);
        }
      }
    } catch (error) {
      console.error("Opening inventory preview lookup failed", { fingerprint, error });
      return fail("Chưa tra cứu được tên sản phẩm và khách hàng. Vui lòng thử kiểm tra file lại.", 500);
    }
    const missingNames = [...new Set(fallbackRows.filter((row) => !items.get(row.itemcode)?.product_name).map((row) => row.excel_row))];
    if (missingNames.length) {
      return invalidRows(missingNames.slice(0, 100).map((row) => ({
        row, message: "Không tìm thấy tên sản phẩm trong hệ thống. Vui lòng điền tên hợp lệ ở cột E.",
      })), missingNames.length);
    }
    return Response.json({
      success: true, fingerprint, summary: parsed.summary,
      rows: preview.map((row) => ({
        ...row, product_name: items.get(row.itemcode)?.product_name || row.product_name,
        customer: items.get(row.itemcode)?.customer || "",
      })),
    });
  }
  if (form?.get("fingerprint") !== fingerprint) {
    return fail("Nội dung đã thay đổi. Hãy kiểm tra lại file trước khi ghi tồn kho.", 409);
  }
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("post_opening_inventory", {
      p_actor: authorization.profile.id, p_fingerprint: fingerprint, p_file_name: file.name.slice(0, 255), p_rows: parsed.rows,
      p_legacy_fingerprint: parsed.legacyRows ? openingFingerprint(parsed.legacyRows) : null,
    });
    if (error) throw error;
    if (!data?.[0]) throw new Error("Missing opening inventory result");
    return Response.json({ success: true, result: data[0] });
  } catch (error) {
    console.error("Opening inventory import failed", { fingerprint, error });
    return fail("Chưa xác nhận được kết quả nạp kho. Có thể thử lại với cùng file mà không ghi trùng.", 500);
  }
}
