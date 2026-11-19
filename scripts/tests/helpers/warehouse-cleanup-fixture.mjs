import { randomUUID } from 'node:crypto';
import { fixture, sql, PREP } from './scan-stock-fixture.mjs';

export const cleanupTables = ['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary'];
export const PREVIEW = 'supabase/operations/warehouse_cleanup_preview.sql';
export const CLEAR = 'supabase/operations/clear_warehouse_test_data.sql';
export async function reviewedSql(manifest) {
  return (await sql(CLEAR))
    .replace("acknowledgement text:='__REVIEW_REQUIRED__'", "acknowledgement text:='CLEAR_ONLY_PREACTIVATION_WAREHOUSE_TEST_DATA'")
    .replace("expected_manifest jsonb:='{}'::jsonb", "expected_manifest jsonb:='" + JSON.stringify(manifest) + "'::jsonb");
}
export async function preview(db) {
  const results = await db.exec(await sql(PREVIEW));
  const result = results.find(r => r.fields?.some(f => f.name === 'expected_manifest'));
  if (!result?.rows[0]?.expected_manifest) throw Error('Preview did not return its manifest');
  return result.rows[0].expected_manifest;
}
export async function clear(db, manifest, raw) {
  try { await db.exec(raw ?? await reviewedSql(manifest)); }
  catch (error) { await db.exec('rollback'); throw error; }
}
export async function cleanupFixture(db) {
  const f = await fixture(db);
  await db.exec('reset role'); await db.exec(await sql(PREP));
  await db.exec(`insert into public.item_pallet_config(itemcode,product_name,customer,quantity_per_pallet) values
    ('CLEANUP','Cleanup item','Customer',100),('PARENT','Parent','Customer',100),('CHILD','Child','Customer',100);
    insert into public.item_build_up(parent_itemcode,child_itemcode_1,active) values('PARENT','CHILD',true);`);
  const oldPallet = await f.seed({ status: 'pendingWH', code: 'CLEANUP', palletId: 'KEEP-PRODUCTION-001' });
  const receipt = await f.confirm([oldPallet.pallet_id]);
  await f.as(f.supervisor);
  const row = { itemcode: 'CLEANUP', received_date: '2026-11-18', production_date: '2026-11-17', wo: null, quantity: 10, note: '' };
  const proposalId = randomUUID();
  await db.query('select * from public.propose_manual_inventory($1,$2::jsonb)', [proposalId, JSON.stringify([row, { ...row, quantity: 5 }])]);
  await db.exec('reset role');
  const line = (await db.query('select id,version from public.inv_incoming_proposal_lines where proposal_id=$1 order by line_no limit 1', [proposalId])).rows[0];
  await f.as(f.supervisor);
  await db.query('select * from public.approve_incoming_proposals($1,$2::jsonb)', [randomUUID(), JSON.stringify([line])]);
  const requestId = randomUUID();
  await db.query('select public.post_manual_delivery($1,$2::jsonb)', [requestId, JSON.stringify({ itemcode: 'CLEANUP', delivery_date: '2026-11-19', ordered_qty: 3 })]);
  const shipment = (await db.query('select public.preview_bulk_delivery($1::uuid[]) result', [[requestId]])).rows[0].result;
  const lot = shipment.lots.CLEANUP[0];
  await db.query('select public.post_bulk_delivery($1,$2::jsonb)', [randomUUID(), JSON.stringify({
    group_model_version: 1, shipped_date: '2026-11-19',
    requests: shipment.requests.map(({ id, version, components }) => ({ id, version, components })),
    lots: [{ group_key: shipment.rows[0].group_key, incoming_id: lot.incoming_id, quantity: 3 }],
  })]);
  await db.exec('reset role');
  await db.query('insert into public.inv_delivery_reservations_legacy(request_id,incoming_id,quantity) values($1,$2,0)', [requestId, lot.incoming_id]);
  await db.query("insert into public.inv_opening_imports(fingerprint,file_name,entered_by,line_count) values($1,'test.xlsx',$2,1)", ['a'.repeat(64), f.supervisor]);
  await db.query("insert into public.inv_incoming(itemcode,product_name,customer,received_date,received_qty,issued_qty,entered_by,note,opening_import_id,opening_excel_row,opening_kind) values('CLEANUP','Opening','',date '2026-11-18',4,0,$1,'',$2,6,'opening')", [f.supervisor, 'a'.repeat(64)]);
  const parent = randomUUID();
  await db.query("insert into public.inv_delivery_requests(id,purorder,sales_id,itemcode,delivery_date,unit,unit_label,ordered_qty,request_type) values($1,'PO','SO','PARENT','2026-11-19','EA','',2,'parent')", [parent]);
  await db.query("insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,unit,unit_label,ordered_qty,request_type,parent_request_id) values('PO','SO','CHILD','2026-11-19','EA','',2,'child',$1)", [parent]);
  return { ...f, oldPallet, receipt, stockId: lot.incoming_id, intake: row };
}
