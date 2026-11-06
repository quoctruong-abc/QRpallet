import readExcel from "read-excel-file/node";
import { createHash } from "node:crypto";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readMergeRanges, expandMergedCells } from "@/lib/excel-merged";
import { normalizeWarehouseItemcode } from "@/lib/warehouse-receipt/itemcode";
import { parseDeliverySheet, parseManualDeliveryInput, type ManualDeliveryInput } from "@/lib/warehouse-receipt/outgoing";

export const runtime = "nodejs";
export const maxDuration = 60;
const fail = (error: string, status = 400) => Response.json({ success: false, error }, { status });
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function dbError(error: { code?: string; message?: string }) {
  const message = error.message || "";
  if (error.code === "PGRST202" && /lookup_manual_delivery_item|post_manual_delivery/.test(message)) {
    return fail("Cần chạy migration 20261106110000_manual_delivery.sql để nhập lịch giao thủ công.", 503);
  }
  if (error.code === "PGRST202" && message.includes("list_stock_production_dates")) {
    return fail("Cần chạy migration 20261106100000_stock_fifo_overship.sql để xem tồn theo ngày sản xuất.", 503);
  }
  if (["PGRST202", "42883", "42P01", "42703"].includes(error.code ?? "")) {
    return fail("Supabase chưa có cấu trúc Xuất kho. Cần chạy migration 20261105140000_item_stock_summary.sql.", 503);
  }
  const messages: [string, string][] = [
    ["DELIVERY_NOT_AUTHORIZED", "Bạn không có quyền xuất kho."],
    ["DELIVERY_STALE", "Dữ liệu đã thay đổi. Tải lại danh sách và kiểm tra trước khi xác nhận."],
    ["DELIVERY_COMMAND_CONFLICT", "Mã thao tác đã dùng cho nội dung khác. Tải lại trang để kiểm tra kết quả."],
    ["DELIVERY_INSUFFICIENT_STOCK", "Tồn thực tế không đủ số thực xuất. Tải lại gợi ý FIFO và kiểm tra số lượng."],
    ["DELIVERY_BELOW_SHIPPED", "Không thể giảm số yêu cầu thấp hơn số đã xuất hoặc số yêu cầu hiện tại nếu đã xuất vượt."],
    ["DELIVERY_CHOOSE_SCHEDULE", "Chọn tạo lịch mới hoặc dời lịch cũ cho dòng có ngày giao khác."],
    ["DELIVERY_DUPLICATE_TARGET", "Hai dòng đang cùng cập nhật một lịch giao. Kiểm tra lại lựa chọn dời lịch."],
    ["DELIVERY_DATE_CONFLICT", "Ngày mới trùng với một lịch đã có. Không thể dời lịch vào ngày đó."],
    ["DELIVERY_CANCELLED", "Yêu cầu đã hủy, không thể tiếp tục xuất hoặc chỉnh sửa."],
    ["DELIVERY_DONE", "Yêu cầu đã hoàn tất và không còn phần chờ xuất."],
    ["DELIVERY_ITEM_NOT_FOUND", "Không tìm thấy item, vui lòng cập nhật database."],
    ["DELIVERY_DUPLICATE_KEY", "File có dòng trùng PO, Sales ID, Itemcode và ngày giao."],
  ];
  const known = messages.find(([key]) => message.includes(key));
  if (known) return fail(known[1], 409);
  if (message.includes("DELIVERY_INVALID") || ["22P02", "22007", "22008", "23514", "P0002"].includes(error.code ?? "")) return fail("Thông tin xuất kho không hợp lệ. Kiểm tra số lượng, ngày và dòng đang chọn.");
  if (error.code === "23505") return fail("Lịch giao đã tồn tại. Tải lại danh sách để kiểm tra.", 409);
  console.error("Delivery API failed", error);
  return fail("Chưa xác nhận được kết quả. Giữ nguyên thao tác và bấm Thử lại để tránh ghi trùng.", 500);
}

export async function GET(request: Request) {
  const auth = await authorizePermission("receipt.view");
  if (!auth.ok) return fail(auth.error, auth.status);
  const db = await createClient();
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "manual-item") {
    let itemcode: string;
    try { itemcode = normalizeWarehouseItemcode(url.searchParams.get("itemcode") || ""); }
    catch (error) { return fail(error instanceof Error ? error.message : "Mã sản phẩm không hợp lệ."); }
    const { data, error } = await db.rpc("lookup_manual_delivery_item", { p_itemcode: itemcode });
    if (error) return dbError(error);
    const item = data?.[0];
    if (!item) return fail("Không tìm thấy item, vui lòng cập nhật database.", 404);
    return Response.json({ success: true, item }, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.searchParams.get("view") === "production-dates") {
    const itemcode = (url.searchParams.get("itemcode") || "").trim();
    if (!itemcode || itemcode.length > 200) return fail("Mã sản phẩm không hợp lệ.");
    const { data, error } = await db.rpc("list_stock_production_dates", { p_itemcode: itemcode });
    if (error) return dbError(error);
    return Response.json({ success: true, ...data }, { headers: { "Cache-Control": "no-store" } });
  }
  const id = url.searchParams.get("id");
  if (id) {
    if (!uuid(id)) return fail("Mã yêu cầu không hợp lệ.");
    const { data, error } = await db.from("inv_delivery_issues")
      .select("id,quantity,shipped_date,created_at,entered_by_name,inv_delivery_issue_lines(incoming_id,quantity,inv_incoming(production_date,received_date))")
      .eq("request_id", id).order("created_at", { ascending: false }).limit(500);
    if (error) return dbError(error);
    const quantity = url.searchParams.get("quantity");
    if (quantity !== null && (!Number.isSafeInteger(Number(quantity)) || Number(quantity) < 0 || Number(quantity) > 2147483647)) return fail("Số lượng xem FIFO không hợp lệ.");
    const { data: fifoPreview, error: fifoError } = await db.rpc("preview_delivery_fifo", {
      p_id: id, p_quantity: quantity === null ? null : Number(quantity),
    });
    if (fifoError) return dbError(fifoError);
    return Response.json({ success: true, history: data, ...fifoPreview }, { headers: { "Cache-Control": "no-store" } });
  }
  const offset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return fail("Trang không hợp lệ.");
  const p_search = (url.searchParams.get("search") || "").trim().slice(0, 200);
  const summary = url.searchParams.get("view") === "summary";
  const { data, error } = summary
    ? await db.rpc("list_stock_summary", { p_offset: offset, p_search, p_shortage_only: url.searchParams.get("shortage") === "true" })
    : await db.rpc("list_delivery", { p_offset: offset, p_search, p_closed: url.searchParams.get("closed") === "true" });
  if (error) return dbError(error);
  if (data?.model_version !== 2) return fail("Cần chạy migration 20261105140000_item_stock_summary.sql để chuyển mô hình tồn kho.", 503);
  return Response.json({ success: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("receipt.view");
  if (!auth.ok) return fail(auth.error, auth.status);
  const db = await createClient();
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx") || !file.size || file.size > 4 * 1024 * 1024) return fail("Chọn file .xlsx không quá 4 MB.");
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const sheets = await readExcel(buffer, { trim: false });
      const sheet = sheets.find((s) => s.sheet.trim().toLowerCase() === "srithai_sales_delivery_schedule");
      if (!sheet) return fail("Không tìm thấy sheet Srithai_Sales_Delivery_Schedule.");
      const parsed = parseDeliverySheet(expandMergedCells(sheet.data, readMergeRanges(buffer, sheet.sheet)));
      if (parsed.errors.length) return Response.json({ success: false, error: "File có dòng không hợp lệ.", errors: parsed.errors.slice(0, 100) }, { status: 422 });
      const { data, error } = await db.rpc("manage_delivery", { p_action: "preview", p_command_id: null, p_payload: { rows: parsed.rows } });
      if (error) return dbError(error);
      if (data?.model_version !== 2) return fail("Cần chạy migration 20261105140000_item_stock_summary.sql để chuyển mô hình tồn kho.", 503);
      // A fingerprint identifies the parsed source, independent of uploaded filename.
      const fingerprint = createHash("sha256").update(JSON.stringify(parsed.rows)).digest("hex");
      return Response.json({ success: true, ...data, fingerprint, file_name: file.name });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Không đọc được file ERP.");
    }
  }
  const body = await request.json().catch(() => null);
  if (!body || !["manual", "import", "edit", "cancel", "reserve", "ship"].includes(body.action) || !uuid(body.command_id) || !body.payload || typeof body.payload !== "object") return fail("Yêu cầu không hợp lệ.");
  if (body.profile_id !== auth.profile.id) return fail("Tài khoản đã thay đổi. Tải lại trang trước khi tiếp tục.", 403);
  try {
    if (body.action === "manual") {
      let payload: ManualDeliveryInput;
      try { payload = parseManualDeliveryInput(body.payload); }
      catch (error) { return fail(error instanceof Error ? error.message : "Lịch giao không hợp lệ."); }
      const { data, error } = await db.rpc("post_manual_delivery", { p_command_id: body.command_id, p_payload: payload });
      if (error) return dbError(error);
      return Response.json({ success: true, result: data });
    }
    const { data, error } = await db.rpc("manage_delivery", { p_action: body.action, p_command_id: body.command_id, p_payload: body.payload });
    if (error) return dbError(error);
    return Response.json({ success: true, result: data });
  } catch (error) {
    console.error("Delivery transport failed", error);
    return fail("Chưa xác nhận được kết quả. Giữ nguyên thao tác và bấm Thử lại để tránh ghi trùng.", 500);
  }
}
