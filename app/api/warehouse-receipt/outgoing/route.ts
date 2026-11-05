import readExcel from "read-excel-file/node";
import { createHash } from "node:crypto";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { readMergeRanges, expandMergedCells } from "@/lib/excel-merged";
import { parseDeliverySheet } from "@/lib/warehouse-receipt/outgoing";

export const runtime = "nodejs";
export const maxDuration = 60;
const fail = (error: string, status = 400) => Response.json({ success: false, error }, { status });
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function dbError(error: { code?: string; message?: string }) {
  const message = error.message || "";
  if (["PGRST202", "42883", "42P01", "42703"].includes(error.code ?? "")) {
    return fail("Supabase chưa có cấu trúc Xuất kho. Cần chạy migration 20261105120000_delivery_reservations.sql.", 503);
  }
  const messages: [string, string][] = [
    ["DELIVERY_NOT_AUTHORIZED", "Bạn không có quyền xuất kho."],
    ["DELIVERY_STALE", "Dữ liệu đã thay đổi. Tải lại danh sách và kiểm tra trước khi xác nhận."],
    ["DELIVERY_COMMAND_CONFLICT", "Mã thao tác đã dùng cho nội dung khác. Tải lại trang để kiểm tra kết quả."],
    ["DELIVERY_INSUFFICIENT_RESERVED", "Số thực xuất phải từ 1 đến số lượng đã giữ. Hãy bổ sung On order nếu cần."],
    ["DELIVERY_BELOW_SHIPPED", "Số yêu cầu không được nhỏ hơn số đã xuất."],
    ["DELIVERY_UNIT_CONFLICT", "Cùng itemcode đang có đơn vị khác. Cần kiểm tra quy đổi đơn vị trước khi nạp."],
    ["DELIVERY_CHOOSE_SCHEDULE", "Chọn tạo lịch mới hoặc dời lịch cũ cho dòng có ngày giao khác."],
    ["DELIVERY_DUPLICATE_TARGET", "Hai dòng đang cùng cập nhật một lịch giao. Kiểm tra lại lựa chọn dời lịch."],
    ["DELIVERY_DATE_CONFLICT", "Ngày mới trùng với một lịch đã có. Không thể dời lịch vào ngày đó."],
    ["DELIVERY_CONFIRM_SET_UNIT", "Cần xác nhận đơn vị Bộ tương ứng với đơn vị tồn của itemcode."],
    ["DELIVERY_CANCELLED", "Yêu cầu đã hủy, không thể tiếp tục xuất hoặc chỉnh sửa."],
    ["DELIVERY_DONE", "Yêu cầu đã xuất đủ, không còn phần chờ để hủy."],
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
  const id = url.searchParams.get("id");
  if (id) {
    if (!uuid(id)) return fail("Mã yêu cầu không hợp lệ.");
    const { data, error } = await db.from("inv_delivery_issues")
      .select("id,quantity,shipped_date,created_at,entered_by_name,inv_delivery_issue_lines(incoming_id,quantity,inv_incoming(production_date,received_date))")
      .eq("request_id", id).order("created_at", { ascending: false }).limit(500);
    if (error) return dbError(error);
    const { data: allocations, error: allocationError } = await db.from("inv_delivery_reservations")
      .select("incoming_id,quantity,inv_incoming(production_date,received_date,balance_qty,reserved_qty,available_qty)")
      .eq("request_id", id).gt("quantity", 0).order("incoming_id").limit(1000);
    if (allocationError) return dbError(allocationError);
    return Response.json({ success: true, history: data, allocations }, { headers: { "Cache-Control": "no-store" } });
  }
  const offset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return fail("Trang không hợp lệ.");
  const { data, error } = await db.rpc("list_delivery", {
    p_offset: offset, p_search: (url.searchParams.get("search") || "").trim().slice(0, 200), p_closed: url.searchParams.get("closed") === "true",
  });
  if (error) return dbError(error);
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
      // A fingerprint identifies the parsed source, independent of uploaded filename.
      const fingerprint = createHash("sha256").update(JSON.stringify(parsed.rows)).digest("hex");
      return Response.json({ success: true, ...data, fingerprint, file_name: file.name });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Không đọc được file ERP.");
    }
  }
  const body = await request.json().catch(() => null);
  if (!body || !["import", "edit", "cancel", "reserve", "ship"].includes(body.action) || !uuid(body.command_id) || !body.payload || typeof body.payload !== "object") return fail("Yêu cầu không hợp lệ.");
  if (body.profile_id !== auth.profile.id) return fail("Tài khoản đã thay đổi. Tải lại trang trước khi tiếp tục.", 403);
  try {
    const { data, error } = await db.rpc("manage_delivery", { p_action: body.action, p_command_id: body.command_id, p_payload: body.payload });
    if (error) return dbError(error);
    return Response.json({ success: true, result: data });
  } catch (error) {
    console.error("Delivery transport failed", error);
    return fail("Chưa xác nhận được kết quả. Giữ nguyên thao tác và bấm Thử lại để tránh ghi trùng.", 500);
  }
}
