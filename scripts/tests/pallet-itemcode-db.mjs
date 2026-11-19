import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { fixture, sql } from './helpers/scan-stock-fixture.mjs';

const db = new PGlite();
try {
  const f = await fixture(db);
  await db.exec(`reset role; alter table public.pallet_data add column quanorder numeric, add column machine text,
    add column created_by uuid, add column even_pallet boolean default false, add column note text;`);
  const before = (await db.query('select count(*)::int n from public.pallet_data')).rows[0].n;
  await db.exec(await sql('supabase/migrations/20261119090000_prepare_scan_stock_bridge.sql'));
  await db.exec(await sql('supabase/migrations/20261119100000_pallet_itemcode_work_orders.sql'));
  assert.equal((await db.query('select count(*)::int n from public.pallet_data')).rows[0].n, before, 'Migration is read-only with respect to business data');
  assert.equal((await db.query('select public.scan_stock_preflight() report')).rows[0].report.ready_to_activate, true, 'Lookup RPC does not conflict with the held scan activation guards');
  assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname in ('scan_stock_receive','scan_stock_receipt_complete')")).rows[0].n, 0, 'Scan activation remains off');
  const lookup = async (code = 'ITEM') => (await db.query('select * from public.pallet_itemcode_work_orders($1)', [code])).rows;
  await f.as();
  await assert.rejects(lookup(), /NOT_AUTHORIZED/, 'Scan permission alone cannot use the print lookup');
  await db.exec('reset role');
  await db.exec("insert into public.permissions values('pallet.create','pallet','Create labels')");
  await db.query("insert into public.user_permissions values($1,'pallet.create',$1)", [f.actor]);
  await db.exec(`insert into public.pallet_data(pallet_id,itemcode,wo,product_name,customer,machine,quanorder,quantity,status,effect_to,created_at) values
    ('OLD','ITEM','WO-1','Before edit','Customer','M1',1000,999,'production',now(),'2026-11-18T03:00:00Z'),
    ('CURRENT','ITEM','WO-1','Current name','Customer','M1',1000,10,'production',null,'2026-11-18T03:00:00Z'),
    ('SCANNED','ITEM','WO-1','Current name','Customer','M1',1000,7,'pendingWH',null,'2026-11-18T03:00:00Z'),
    ('PROCESSING','ITEM','WO-1','Current name','Customer','M1',1000,4,'processingWH',null,'2026-11-18T03:00:00Z'),
    ('RECEIVED','ITEM','WO-1','Current name','Customer','M1',1000,3,'WHdone',null,'2026-11-18T03:00:00Z'),
    ('ARCHIVED','ITEM','WO-2','Old WO','Customer','M1',20,500,'production',now(),'2026-11-17T03:00:00Z'),
    ('OTHER-ITEM','OTHER','WO-1','Other item','Other customer','M1',90,90,'WHdone',null,'2026-11-19T03:00:00Z'),
    ('ZERO-WO','ITEM','0','Ignore','Customer','M1',1,1,'production',null,now()),
    ('EMPTY-WO','ITEM','','Ignore','Customer','M1',1,1,'production',null,now());`);
  await f.as();
  const result = await lookup();
  assert.equal(result.length, 2);
  assert.equal(result[0].wo, 'WO-1');
  assert.equal(result[0].product_name, 'Current name');
  assert.equal(Number(result[0].produced_quantity), 24, 'Only active versions are summed');
  assert.equal(Number(result[0].warehouse_quantity), 3, 'Only WHdone is received');
  assert.equal(Number(result[0].pallet_count), 4);
  assert.equal(Number(result[0].quanorder), 1000, 'Order quantity is not summed per pallet');
  assert.equal(Number(result[1].produced_quantity), 0, 'Archived WO remains discoverable without inflating totals');
  assert.deepEqual(await lookup('NONE'), []);
  for (const code of ['', null, 'A B', 'A*B', 'A'.repeat(201)]) await assert.rejects(lookup(code), /INVALID_ITEMCODE/);
  await db.exec('reset role');
  const creationSql = await sql('supabase/migrations/20260827090000_pallet_label_working_day_even_flag.sql');
  const start = creationSql.indexOf('create function public.create_pallet_record(');
  await db.exec(creationSql.slice(start, creationSql.indexOf('$$;', start) + 3));
  await db.exec('revoke all on function public.create_pallet_record(text,text,text,text,numeric,text,integer,text,date,boolean) from public; grant execute on function public.create_pallet_record(text,text,text,text,numeric,text,integer,text,date,boolean) to authenticated;');
  await f.as();
  const created = (await db.query("select * from public.create_pallet_record('NEW','Product','Customer','NEW-WO',500,null,100,null,'2026-11-18',true)")).rows[0];
  assert.equal(created.pallet_id, 'NEW-WO-001');
  assert.equal(created.status, 'production');
  assert.equal(new Date(created.working_day).toISOString().slice(0, 10), '2026-11-18');
  assert.equal(Number(created.quanorder), 500);
  assert.equal(created.quantity, 100);
  assert.equal(created.created_by, f.actor);
  assert.equal((await lookup('NEW'))[0].wo, 'NEW-WO', 'A newly printed item enters the regular WO lookup');
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from public.inv_incoming')).rows[0].n, 0, 'Printing a label does not activate the stock bridge');
  await db.exec('reset role');
  await db.query('update public.profiles set is_active=false where id=$1', [f.actor]);
  await f.as(); await assert.rejects(lookup(), /NOT_AUTHORIZED/);
  await db.exec('reset role; set role anon');
  await assert.rejects(lookup(), /permission denied/);
  console.log('PASS DB: read-only migration, pallet.create permission, active/version totals, WHdone progress, archived WO discovery, item isolation, order/date sorting and inactive/anonymous denial.');
} finally {
  await db.close();
}
