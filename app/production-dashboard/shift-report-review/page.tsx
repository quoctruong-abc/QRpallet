import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { requirePermission } from "@/lib/auth";
import { ShiftReportReviewClient } from "./shift-report-review-client";

export default async function ShiftReportReviewPage() {
  const profile = await requirePermission("dashboard.view");

  return (
    <PageShell profile={profile} title="Dashboard sản xuất">
      <style>{`
        .shift-review-page { display: grid; gap: 22px; }
        .dashboard-view-tabs { display: inline-flex; gap: 6px; width: fit-content; padding: 5px; border: 1px solid var(--border); border-radius: 12px; background: #f2f4f7; }
        .dashboard-view-tab { min-width: 140px; padding: 10px 16px; border-radius: 9px; color: #475467; font-weight: 850; text-align: center; }
        .dashboard-view-tab-active { color: white; background: var(--primary); box-shadow: 0 4px 10px rgba(21,94,239,.2); }
        .shift-review-heading { margin-bottom: 18px; }
        .shift-review-heading p { margin-bottom: 0; }
        .shift-upload-layout { display: grid; grid-template-columns: minmax(0,1.6fr) minmax(220px,.6fr); gap: 18px; align-items: stretch; }
        .shift-upload-modes { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
        .shift-upload-mode { display: grid; grid-template-columns: 20px minmax(0,1fr); gap: 11px; align-items: start; padding: 16px; border: 1px solid #d0d5dd; border-radius: 14px; color: #344054; background: #fff; text-align: left; cursor: pointer; }
        .shift-upload-mode:hover { border-color: #84adff; background: #f9fbff; }
        .shift-upload-mode-active { border-color: #528bff; background: #eff8ff; box-shadow: 0 0 0 1px #84adff; }
        .shift-upload-mode-dot { width: 18px; height: 18px; margin-top: 1px; border: 2px solid #98a2b3; border-radius: 50%; background: #fff; }
        .shift-upload-mode-active .shift-upload-mode-dot { border: 5px solid #175cd3; }
        .shift-upload-mode strong, .shift-upload-mode small { display: block; }
        .shift-upload-mode strong { margin-bottom: 5px; color: #101828; }
        .shift-upload-mode small { color: #667085; line-height: 1.4; }
        .shift-upload-action { display: flex; min-height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 18px; border: 1px dashed #98a2b3; border-radius: 14px; background: #fcfcfd; }
        .shift-upload-input { display: none; }
        .shift-upload-button { min-width: 178px; }
        .shift-upload-button svg { width: 18px; height: 18px; margin-right: 7px; vertical-align: -4px; }
        .shift-selected-file { display: grid; grid-template-columns: 44px minmax(0,1fr) auto; gap: 12px; align-items: center; margin-top: 16px; padding: 13px 15px; border: 1px solid #abefc6; border-radius: 13px; background: #f6fef9; }
        .shift-file-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 10px; color: #027a48; background: #d1fadf; font-size: .7rem; font-weight: 900; }
        .shift-selected-file strong, .shift-selected-file span { display: block; }
        .shift-selected-file strong { overflow-wrap: anywhere; }
        .shift-selected-file div > span { margin-top: 3px; color: #667085; font-size: .78rem; }
        .shift-file-pending { padding: 6px 9px; border-radius: 999px; color: #854a0e; background: #fffaeb; font-size: .72rem; font-weight: 850; white-space: nowrap; }
        .shift-file-done { color: #027a48; background: #ecfdf3; }
        .shift-file-error { color: #b42318; background: #fef3f2; }
        .shift-upload-panel > .alert { margin: 14px 0 0; }
        .shift-review-summary { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
        .shift-comparison-panel { width: 100%; max-width: 100%; overflow: hidden; }
        .shift-comparison-controls { display: flex; align-items: end; gap: 9px; }
        .shift-comparison-controls > .button { min-height: 42px; }
        .shift-comparison-date { display: grid; gap: 6px; min-width: 190px; color: #475467; font-size: .78rem; font-weight: 800; }
        .shift-comparison-date input { width: 100%; min-height: 42px; padding: 8px 11px; border: 1px solid #d0d5dd; border-radius: 9px; color: #101828; background: #fff; font: inherit; font-size: .9rem; }
        .shift-comparison-date input:focus { border-color: #528bff; outline: 3px solid rgba(82,139,255,.14); }
        .shift-comparison-summary { display: flex; flex-wrap: wrap; gap: 9px; margin: -2px 0 14px; }
        .shift-comparison-summary > span { padding: 7px 10px; border-radius: 999px; color: #344054; background: #f2f4f7; font-size: .78rem; }
        .shift-comparison-summary .shift-summary-matched { color: #027a48; background: #ecfdf3; }
        .shift-comparison-summary .shift-summary-mismatch { color: #b54708; background: #fffaeb; }
        .shift-comparison-panel > .alert { margin: 0 0 14px; }
        .shift-comparison-table-wrap { max-height: min(66vh,680px); overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
        .shift-comparison-table { width: 100%; min-width: 1080px; }
        .shift-comparison-table thead th { position: sticky; top: 0; z-index: 2; background: #f8fafc; box-shadow: 0 1px 0 var(--border); }
        .shift-comparison-table th small { color: inherit; font-size: .68rem; font-weight: 650; }
        .shift-comparison-table .shift-product-name-column { width: 190px; max-width: 190px; white-space: normal; overflow-wrap: anywhere; }
        .shift-comparison-table .shift-number-column { width: 86px; max-width: 86px; padding-left: 7px; padding-right: 7px; text-align: right; white-space: normal; }
        .shift-comparison-table .shift-total-quantity-column { width: 116px; max-width: 116px; padding-left: 7px; padding-right: 7px; text-align: right; white-space: nowrap; }
        .shift-comparison-table .number-cell { text-align: right; white-space: nowrap; }
        .shift-wo-cell, .shift-history-date-cell { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
        .shift-eye-button { position: relative; width: 30px; height: 30px; display: inline-grid; flex: 0 0 auto; place-items: center; padding: 0; border: 1px solid #b2ccff; border-radius: 8px; color: #175cd3; background: #eff8ff; cursor: pointer; }
        .shift-eye-button:hover { border-color: #528bff; background: #dbeafe; }
        .shift-eye-button svg { width: 17px; height: 17px; }
        .shift-wo-history-modal { width: min(760px,calc(100% - 24px)); max-height: 90vh; overflow: auto; }
        .shift-wo-history-table { min-width: 620px; }
        .shift-wo-history-table .number-cell { text-align: right; white-space: nowrap; }
        .shift-wo-history-total td { border-top: 2px solid #98a2b3; background: #f8fafc; font-weight: 850; }
        .shift-date-eye-button { width: 28px; height: 28px; }
        .shift-history-warning { position: absolute; top: -7px; right: -7px; width: 17px; height: 17px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: #d92d20; font-size: .65rem; font-weight: 900; line-height: 1; box-shadow: 0 2px 6px rgba(217,45,32,.3); }
        .shift-comparison-row-mismatch { background: #fffcf5; }
        .shift-comparison-row-mismatch:hover { background: #fff7e8; }
        .shift-difference { color: #b42318; font-weight: 850; }
        .shift-difference-zero { color: #027a48; }
        .shift-result { display: inline-block; max-width: 280px; padding: 6px 9px; border-radius: 8px; font-size: .75rem; font-weight: 800; line-height: 1.35; }
        .shift-result-matched { color: #027a48; background: #ecfdf3; }
        .shift-result-mismatch { color: #b54708; background: #fffaeb; }
        .shift-comparison-empty { padding: 42px 20px !important; color: var(--muted); text-align: center; }
        .shift-audit-backdrop { z-index: 1100; }
        .shift-audit-modal { width: min(1040px,calc(100% - 24px)); max-height: 90vh; overflow: auto; }
        .shift-audit-table { min-width: 880px; }
        .shift-audit-table input[type="checkbox"] { width: 18px; height: 18px; }
        @media (max-width: 820px) {
          .shift-upload-layout { grid-template-columns: 1fr; }
          .shift-upload-action { min-height: 150px; }
        }
        @media (max-width: 640px) {
          .dashboard-view-tabs { width: 100%; overflow-x: auto; }
          .dashboard-view-tab { min-width: 132px; flex: 0 0 auto; padding-left: 9px; padding-right: 9px; }
          .shift-upload-modes, .shift-review-summary { grid-template-columns: 1fr; }
          .shift-selected-file { grid-template-columns: 44px minmax(0,1fr); }
          .shift-file-pending { grid-column: 1 / -1; width: fit-content; }
          .shift-review-heading { align-items: stretch; flex-direction: column; gap: 14px; }
          .shift-comparison-controls { width: 100%; align-items: stretch; flex-direction: column; }
          .shift-comparison-date { width: 100%; }
          .shift-wo-history-modal { padding: 18px; }
        }
      `}</style>

      <div className="shift-review-page">
        <div className="hero-row">
          <div>
            <h1>Dashboard sản xuất</h1>
            <p className="muted">Đối chiếu dữ liệu sản xuất trong App với dữ liệu ERP từ báo ca.</p>
          </div>
        </div>

        <div className="dashboard-view-tabs" aria-label="Dashboard tabs">
          <Link className="dashboard-view-tab" href="/production-dashboard" prefetch={false}>Dashboard</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-fifo" prefetch={false}>Check FIFO</Link>
          <Link className="dashboard-view-tab" href="/production-dashboard/check-item" prefetch={false}>Check item</Link>
          <Link className="dashboard-view-tab dashboard-view-tab-active" href="/production-dashboard/shift-report-review" prefetch={false}>Rà soát báo ca</Link>
        </div>

        <ShiftReportReviewClient />
      </div>
    </PageShell>
  );
}
