import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("pallet.create");
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error },
      { status: authorization.status },
    );
  }

  try {
    const body = await request.json();
    const palletId = String(body.pallet_id ?? "").trim();
    if (!palletId) {
      return NextResponse.json({ error: "Thiếu Pallet ID." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("increment_pallet_reprint_count", {
      p_pallet_id: palletId,
    });

    if (error) {
      console.error("increment_pallet_reprint_count failed", error);
      const notFound = error.message.includes("PALLET_NOT_FOUND");
      return NextResponse.json(
        { error: notFound ? "Không tìm thấy pallet đang hiệu lực." : error.message },
        { status: notFound ? 404 : 500 },
      );
    }

    return NextResponse.json({ success: true, pallet: data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dữ liệu gửi lên không hợp lệ." },
      { status: 400 },
    );
  }
}
