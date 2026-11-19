import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  const wo = (new URL(request.url).searchParams.get("wo") ?? "").trim();
  if (!wo || wo.length > 120 || wo === "0" || [...wo].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return NextResponse.json({ success: false, error: "Vui lòng nhập WO hợp lệ, tối đa 120 ký tự." }, { status: 400 });
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_new_pallet_wo", { p_wo: wo });
  if (error || !data) return NextResponse.json({ success: false, error: "Chưa kiểm tra được WO. Vui lòng thử lại." }, { status: 503 });
  return NextResponse.json({ success: true, ...data, message: data.valid ? "WO hợp lệ, có thể tạo tem mới." : data.reason === "EXISTS" ? "WO đã tồn tại trong dữ liệu pallet. Vui lòng chọn WO đã có hoặc nhập WO mới khác." : "WO không hợp lệ." });
}
