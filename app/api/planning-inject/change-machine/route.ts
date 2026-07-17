import { NextResponse } from "next/server";
import { authorizePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const authorization = await authorizePermission("planning.change");
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const body = await request.json().catch(() => null) as {
    id?: number | string;
    machine?: string;
  } | null;

  const id = Number(body?.id);
  const machine = String(body?.machine ?? "").trim();

  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Dòng kế hoạch không hợp lệ." }, { status: 400 });
  }
  if (!machine) {
    return NextResponse.json({ error: "Vui lòng chọn máy." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("planning_inject")
    .update({ machine })
    .eq("id", id)
    .select("id,machine")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Không thể đổi máy: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, row: data });
}
