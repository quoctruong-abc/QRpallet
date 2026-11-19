import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { sql, activate } from './helpers/scan-stock-fixture.mjs';
import { cleanupTables, PREVIEW, CLEAR, cleanupFixture, preview, clear, reviewedSql } from './helpers/warehouse-cleanup-fixture.mjs';

const db = new PGlite();
try {
  const f = await cleanupFixture(db);
  const unchangedOperation = await sql(CLEAR);
  assert.equal((await db.query("select to_regclass('public.inv_delivery_reservations') r")).rows[0].r, null, 'Only the legacy reservation table remains after summary migration');
  const manifest = await preview(db);
  assert.deepEqual(Object.keys(manifest).sort(), [...cleanupTables].sort());
  assert.ok(Object.values(manifest).every(r => r.rows > 0), 'Fixture covers every target table');
  const protectedTables = ['profiles','permissions','user_permissions','item_pallet_config','item_build_up','warehouse_positions','pallet_data','wh_data_pallet','wh_receipt','pallet_change_history','inv_scan_stock_activation'];
  const protectedSnapshot = async () => Object.fromEntries(await Promise.all(protectedTables.map(async t => [t, (await db.query(`select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]') data from public.${t} r`)).rows[0].data])));
  const before = await protectedSnapshot();
  const sequence = (await db.query('select last_value,is_called from public.inv_incoming_id_seq')).rows;
  await assert.rejects(clear(db, manifest, await sql(CLEAR)), /NOT_AUTHORIZED/, 'Unedited file cannot delete anything');
  await assert.rejects(clear(db, {}), /PREVIEW_REQUIRED/);
  await f.as(f.supervisor);
  await assert.rejects(clear(db, manifest), /OWNER_REQUIRED/, 'App-level Warehouse admin is not a database owner');
  await db.exec('reset role');
  assert.deepEqual(await preview(db), manifest);
  await db.exec('create table public.inv_unreviewed(id integer)');
  await assert.rejects(clear(db, manifest), /UNKNOWN_TABLES/); await db.exec('drop table public.inv_unreviewed');
  await db.exec('create table public.cleanup_external(id bigint references public.inv_incoming(id))');
  await db.query('insert into public.cleanup_external values($1)', [f.stockId]);
  await assert.rejects(clear(db, manifest), /EXTERNAL_FK/); await db.exec('drop table public.cleanup_external');
  await db.exec("create function public.cleanup_truncate_test() returns trigger language plpgsql as $$ begin return null; end $$; create trigger cleanup_custom before truncate on public.inv_incoming for each statement execute function public.cleanup_truncate_test()");
  await assert.rejects(clear(db, manifest), /CUSTOM_TRUNCATE_TRIGGER/);
  await db.exec('drop trigger cleanup_custom on public.inv_incoming;drop function public.cleanup_truncate_test()');
  await db.exec(`create trigger scan_stock_receive after update on public.pallet_data
    referencing old table as scan_stock_old new table as scan_stock_new
    for each statement execute function public.scan_stock_receive_transition();
    alter table public.pallet_data disable trigger scan_stock_receive;`);
  await assert.rejects(clear(db, manifest), /SCAN_TRIGGER_PRESENT/, 'Disabled/partial activation still blocks cleanup');
  await db.exec('drop trigger scan_stock_receive on public.pallet_data');
  await db.exec('create table public.cleanup_child(extra text) inherits(public.inv_opening_imports)');
  await assert.rejects(clear(db, manifest), /UNREVIEWED_TABLE_STRUCTURE/); await db.exec('drop table public.cleanup_child');
  await db.query('update public.inv_incoming set receipt_id=$1 where id=$2', [f.receipt.receipt_id, f.stockId]);
  const linked = await preview(db); await assert.rejects(clear(db, linked), /RECEIPT_LINKED_STOCK/);
  await db.query('update public.inv_incoming set receipt_id=null,received_qty=received_qty+1 where id=$1', [f.stockId]);
  await assert.rejects(clear(db, manifest), /STALE_PREVIEW/, 'Fingerprint catches equal-row-count data changes');
  assert.ok((await db.query('select count(*)::int n from public.inv_incoming')).rows[0].n > 0);
  const fresh = await preview(db);
  const failAfterTruncate = (await reviewedSql(fresh)).replace('continue identity restrict;', "continue identity restrict; raise exception 'LOCAL_TEST_ROLLBACK_AFTER_TRUNCATE';");
  await assert.rejects(clear(db, fresh, failAfterTruncate), /LOCAL_TEST_ROLLBACK_AFTER_TRUNCATE/);
  assert.deepEqual(await preview(db), fresh, 'An error after TRUNCATE restores every target table in the transaction');
  await clear(db, fresh);
  assert.deepEqual(await protectedSnapshot(), before, 'Master/production/receipt/scan/audit state is preserved byte-for-byte');
  assert.deepEqual((await db.query('select last_value,is_called from public.inv_incoming_id_seq')).rows, sequence, 'Identity must not restart');
  assert.ok(Object.values(await preview(db)).every(r => r.rows === 0));
  assert.equal(await sql(CLEAR), unchangedOperation, 'Tests replace acknowledgements in memory only');
  // The normal intake workflow still works after reset, with a new numeric ID.
  await f.as(f.supervisor);
  await db.query('select * from public.propose_manual_inventory($1,$2::jsonb)', [randomUUID(), JSON.stringify([f.intake])]);
  await db.exec('reset role');
  const nextLine = (await db.query('select id,version from public.inv_incoming_proposal_lines')).rows;
  await f.as(f.supervisor);
  await db.query('select * from public.approve_incoming_proposals($1,$2::jsonb)', [randomUUID(), JSON.stringify(nextLine)]);
  await db.exec('reset role');
  assert.ok(Number((await db.query('select max(id) id from public.inv_incoming')).rows[0].id) > Number(sequence[0].last_value));
  const postReset = await preview(db);
  await activate(db);
  await assert.rejects(clear(db, postReset), /ALREADY_ACTIVATED/);
  assert.ok((await db.query('select count(*)::int n from public.inv_scan_stock_activation')).rows[0].n === 1, 'Never erase activation audit');
  assert.ok((await db.query('select count(*)::int n from public.inv_incoming')).rows[0].n > 0, 'After-activation refusal retains stock');
  // Both SQL files stay outside automatic migrations.
  assert.ok(PREVIEW.startsWith('supabase/operations/') && CLEAR.startsWith('supabase/operations/'));
  console.log('PASS: 11-table FK-complete reset, read-only exact preview, unchanged production/master/scan receipts, preserved identities, acknowledgement/stale/unknown/FK/trigger/inheritance/receipt guards, post-reset intake and activated-state refusal.');
} finally { await db.close(); }
