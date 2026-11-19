import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { fixture, sql } from './helpers/scan-stock-fixture.mjs';

const db = new PGlite();
try {
  const f = await fixture(db);
  await db.exec(`reset role; alter table public.pallet_data add column quanorder numeric, add column machine text,
    add column created_by uuid, add column even_pallet boolean default false, add column note text;`);
  await db.exec(`alter table public.item_pallet_config add column updated_at timestamptz not null default now();
    create trigger item_pallet_config_set_updated_at before update on public.item_pallet_config
    for each row execute function public.set_updated_at();`);
  const before = (await db.query('select count(*)::int n from public.pallet_data')).rows[0].n;
  await db.exec(await sql('supabase/migrations/20261119090000_prepare_scan_stock_bridge.sql'));
  await db.exec(await sql('supabase/migrations/20261119100000_pallet_itemcode_work_orders.sql'));
  await db.exec(await sql('supabase/migrations/20261119110000_pallet_config_customers.sql'));
  assert.equal((await db.query('select count(*)::int n from public.pallet_data')).rows[0].n, before, 'Migration is read-only with respect to business data');
  assert.equal((await db.query('select public.scan_stock_preflight() report')).rows[0].report.ready_to_activate, true, 'Lookup RPC does not conflict with the held scan activation guards');
  assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname in ('scan_stock_receive','scan_stock_receipt_complete')")).rows[0].n, 0, 'Scan activation remains off');
  const lookup = async (code = 'ITEM') => (await db.query('select * from public.pallet_itemcode_work_orders($1)', [code])).rows;
  await f.as();
  await assert.rejects(lookup(), /NOT_AUTHORIZED/, 'Scan permission alone cannot use the print lookup');
  await assert.rejects(db.query('select public.pallet_customer_options()'), /NOT_AUTHORIZED/);
  await assert.rejects(db.query("select public.pallet_config_save('CFG',100)"), /NOT_AUTHORIZED/);
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
  await db.exec(`insert into public.pallet_data(pallet_id,itemcode,wo,quantity,customer) values
    ('CUSTOMER-SPACE','DONOR','CUSTOMERS',1,' Customer '),('CUSTOMER-BLANK','DONOR','CUSTOMERS',1,' '),('CUSTOMER-NULL','DONOR','CUSTOMERS',1,null);
    insert into public.item_pallet_config(itemcode,quantity_per_pallet,product_name,"ERP_name",customer,netweight) values
    ('CFG',100,'Production label','ERP label','Legacy Only',0.5),('CFG-LEGACY',100,'Legacy item','ERP','Legacy Only',1),
    ('CFG-EMPTY',100,'Empty customer','ERP',null,1);`);
  const historyBefore = (await db.query('select id,customer from public.pallet_data order by id')).rows;
  await f.as();
  const options = (await db.query('select public.pallet_customer_options() result')).rows[0].result.customers;
  assert.deepEqual(options, ['Customer', 'Other customer'], 'Trim, deduplicate and exclude blanks using pallet history, not config');
  const save = async (code, quantity, customer) => (await db.query('select public.pallet_config_save($1,$2,$3) result', [code, quantity, customer])).rows[0].result;
  const saved = await save('CFG', 150, ' Other customer ');
  assert.equal(saved.quantity_per_pallet, 150); assert.equal(saved.customer, 'Other customer');
  await save('CFG', 200, null);
  for (const [qty, customer, error] of [[250, 'Invented customer', /UNKNOWN_CUSTOMER/], [250, '', /CUSTOMER_REQUIRED/], [0, 'Customer', /CONFIG_INVALID/]]) {
    await assert.rejects(save('CFG', qty, customer), error);
  }
  assert.equal((await save('CFG-LEGACY', 120, 'Legacy Only')).customer, 'Legacy Only', 'Keep an existing customer absent from history');
  assert.equal((await save('CFG-EMPTY', 120, '')).customer, '', 'Quantity-only edits still work for an item with no customer');
  await db.exec('reset role');
  const cfg = (await db.query("select * from public.item_pallet_config where itemcode='CFG'")).rows[0];
  assert.equal(cfg.quantity_per_pallet, 200, 'Rejected customer changes do not partially save quantity');
  assert.equal(cfg.customer, 'Other customer'); assert.equal(cfg.product_name, 'Production label');
  assert.equal(cfg.ERP_name, 'ERP label'); assert.equal(Number(cfg.netweight), 0.5);
  assert.deepEqual((await db.query('select id,customer from public.pallet_data order by id')).rows, historyBefore, 'Settings never rewrite historical pallet customer snapshots');
  await db.exec('reset role');
  await db.query('update public.profiles set is_active=false where id=$1', [f.actor]);
  await f.as(); await assert.rejects(lookup(), /NOT_AUTHORIZED/);
  await db.exec('reset role; set role anon');
  await assert.rejects(lookup(), /permission denied/);
  await assert.rejects(db.query('select public.pallet_customer_options()'), /permission denied/);
  await assert.rejects(db.query("select public.pallet_config_save('CFG',100)"), /permission denied/);
  console.log('PASS DB: pallet WO lookup, customer options from history, atomic quantity/customer settings, catalog metadata preservation, unchanged pallet snapshots, permission guards and dormant scan activation.');
} finally {
  await db.close();
}
