import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { hasPermission, requirePosition } from "@/lib/auth";
import type { PlanningRow } from "@/lib/planning";
import { createClient } from "@/lib/supabase/server";
import { ChangeMachineButton } from "./change-machine-button";
import { PlanningImportForm } from "./import-form";

const PREVIEW_LIMIT = 100;

function displayValue(value: string | number | null) {
  if (value === null || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("vi-VN");
  return value;
}

export default async function PlanningInjectPage() {
  const profile = await requirePosition("planning");
  const canUploadPlan = hasPermission(profile, "planning.upload");
  const canEditPlan = hasPermission(profile, "planning.change");
  const supabase = await createClient();

  const [countResult, rowsResult, latestResult, machinesResult] = await Promise.all([
    supabase.from("planning_inject").select("*", { count: "exact", head: true }),
    supabase
      .from("planning_inject")
      .select(
        "id,machine,itemcode,product_name,customer,wo,netweight,quanperh,quanperday,color,material,package,quanorder",
      )
      .order("id", { ascending: true })
      .limit(PREVIEW_LIMIT),
    supabase
      .from("planning_inject")
      .select("source_file,imported_at")
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("planning_inject")
      .select("machine")
      .not("machine", "is", null)
      .order("machine", { ascending: true }),
  ]);

  const databaseReady = !countResult.error && !rowsResult.error;
  const rows = (rowsResult.data ?? []) as PlanningRow[];
  const totalRows = countResult.count ?? 0;
  const latest = latestResult.data as Pick<PlanningRow, "source_file" | "imported_at"> | null;
  const machines = Array.from(
    new Set(
      ((machinesResult.data ?? []) as Array<{ machine: string | null }>)
        .map((row) => row.machine?.trim())
        .filter((machine): machine is string => Boolean(machine)),
    ),
  );
  const importedAt = latest?.imported_at
    ? new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Ho_Chi_Minh",
      }).format(new Date(latest.imported_at))
    : "Chưa có dữ liệu";

  return (
    <PageShell profile={profile} title="Planning Inject">
      <div
        style={{
          boxSizing: "border-box",
          margin: "0 auto",
          maxWidth: "1500px",
          minWidth: 0,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <div className="hero-row planning-hero">
          <div>
            <p className="eyebrow">MODULE 01</p>
            <h1>Planning Inject</h1>
            <p className="muted">Import kế hoạch sản xuất từ Excel và thay thế plan hiện tại.</p>
          </div>
          <div className="planning-stats">
            <div className="stat-card">
              <span className="stat-number">{totalRows.toLocaleString("vi-VN")}</span>
              <span className="muted">Dòng kế hoạch</span>
            </div>
            <div className="stat-card planning-latest-card">
              <span className="small muted">Cập nhật gần nhất</span>
              <strong>{importedAt}</strong>
              <span className="small muted truncate-text">{latest?.source_file ?? "—"}</span>
            </div>
          </div>
        </div>

        {!databaseReady ? (
          <section className="alert alert-error">
            Chưa tìm thấy bảng <b>planning_inject</b>. Hãy chạy file SQL <b>supabase/002_planning_inject.sql</b> trong Supabase SQL Editor.
          </section>
        ) : null}

        {canUploadPlan ? (
          <section className="panel" style={{ minWidth: 0 }}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">IMPORT EXCEL</p>
                <h2>Cập nhật kế hoạch mới</h2>
              </div>
            </div>
            <PlanningImportForm databaseReady={databaseReady} />
          </section>
        ) : null}

        <section className="panel" style={{ minWidth: 0, overflow: "hidden" }}>
          <div className="section-heading planning-table-heading">
            <div>
              <p className="eyebrow">CURRENT PLAN</p>
              <h2>Dữ liệu hiện tại</h2>
            </div>
            {totalRows > PREVIEW_LIMIT ? (
              <span className="muted small">Đang hiển thị {PREVIEW_LIMIT} dòng đầu tiên</span>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="empty-state">
              <strong>Chưa có kế hoạch</strong>
              <p className="muted">Chưa có dữ liệu kế hoạch hiện tại.</p>
            </div>
          ) : (
            <div
              className="table-wrap planning-table-wrap"
              style={{
                boxSizing: "border-box",
                maxWidth: "100%",
                minWidth: 0,
                overflowX: "auto",
                width: "100%",
              }}
            >
              <table className="planning-table" style={{ minWidth: "max-content" }}>
                <thead>
                  <tr>
                    {canEditPlan ? <th>Đổi máy</th> : null}
                    <th>#</th>
                    <th>Machine</th>
                    <th>Item Code</th>
                    <th>Product Name</th>
                    <th>Customer</th>
                    <th>WO</th>
                    <th>Net Weight</th>
                    <th>Quan/Hour</th>
                    <th>Quan/Day</th>
                    <th>Color</th>
                    <th>Material</th>
                    <th>Package</th>
                    <th>Quan Order</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id ?? index}>
                      {canEditPlan ? (
                        <td>
                          {row.id ? (
                            <ChangeMachineButton
                              currentMachine={row.machine}
                              machines={machines}
                              rowId={row.id}
                            />
                          ) : null}
                        </td>
                      ) : null}
                      <td>{index + 1}</td>
                      <td><strong>{displayValue(row.machine)}</strong></td>
                      <td>{displayValue(row.itemcode)}</td>
                      <td>{displayValue(row.product_name)}</td>
                      <td>{displayValue(row.customer)}</td>
                      <td><span className="badge">{displayValue(row.wo)}</span></td>
                      <td>{displayValue(row.netweight)}</td>
                      <td>{displayValue(row.quanperh)}</td>
                      <td>{displayValue(row.quanperday)}</td>
                      <td>{displayValue(row.color)}</td>
                      <td>{displayValue(row.material)}</td>
                      <td>{displayValue(row.package)}</td>
                      <td>{displayValue(row.quanorder)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {profile.role === "admin" ? (
          <Link className="text-link" href="/admin">← Trở về Admin</Link>
        ) : null}
      </div>
    </PageShell>
  );
}
