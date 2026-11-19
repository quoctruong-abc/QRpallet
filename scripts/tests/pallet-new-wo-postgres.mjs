// Own temporary local server only. No production or existing database URL.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { fixture, sql } from './helpers/scan-stock-fixture.mjs';
const bin = process.env.PALLET_POSTGRES_BIN ?? process.env.SCAN_POSTGRES_BIN;
if (!bin) throw Error('Set PALLET_POSTGRES_BIN to a local PostgreSQL bin directory. No database URL is accepted.');
const work = await mkdtemp(join(tmpdir(), 'svn-new-wo-'));
const port = await new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
const connections = []; let server, log;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() { const c = new pg.Client({ host: '127.0.0.1', port, user: 'svn_pallet_test', database: 'postgres', connectionTimeoutMillis: 1000 }); await c.connect(); await c.query("set statement_timeout='15s'"); connections.push(c); return c; }
async function actor(c, id) { await c.query('reset role'); await c.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await c.query('set role authenticated'); }
async function waiting(observer, pid) { const stop = Date.now() + 4000; while (Date.now() < stop) { if ((await observer.query('select wait_event from pg_stat_activity where pid=$1', [pid])).rows[0]?.wait_event === 'advisory') return; await delay(15); } throw Error('Expected advisory wait'); }
const attempt = p => p.then(result => ({ result }), error => ({ error }));
try {
  const init = spawnSync(join(bin, 'initdb'), ['-D', join(work, 'data'), '-A', 'trust', '-U', 'svn_pallet_test', '--no-locale'], { encoding: 'utf8' });
  if (init.status !== 0) throw Error(init.stderr || init.stdout);
  log = openSync(join(work, 'postgres.log'), 'a');
  server = spawn(join(bin, 'postgres'), ['-D', join(work, 'data'), '-h', '127.0.0.1', '-p', String(port), '-c', 'unix_socket_directories='], { stdio: ['ignore', log, log] });
  let main; for (let i = 0; i < 100 && !main; i++) { try { main = await connect(); } catch { await delay(50); } }
  if (!main) throw Error(await readFile(join(work, 'postgres.log'), 'utf8'));
  console.log('Local server:', (await main.query('select version() v')).rows[0].v);
  const f = await fixture({ exec: text => main.query(text), query: (text, args) => main.query(text, args) });
  await main.query('reset role; alter table public.pallet_data add column quanorder numeric, add column machine text, add column created_by uuid, add column note text, add column even_pallet boolean default false;');
  const original = await sql('supabase/migrations/20260827090000_pallet_label_working_day_even_flag.sql'), start = original.indexOf('create function public.create_pallet_record(');
  await main.query(original.slice(start, original.indexOf('$$;', start) + 3));
  await main.query(await sql('supabase/migrations/20261119120000_new_pallet_wo_guard.sql'));
  await main.query("insert into public.permissions values('pallet.create','pallet','Print'); insert into public.item_pallet_config(itemcode,product_name,customer,quantity_per_pallet) values('TEST','Trusted product','Customer',100)");
  for (const id of [f.actor, f.other]) await main.query("insert into public.user_permissions values($1,'pallet.create',$1)", [id]);
  const a = await connect(), b = await connect(), control = await connect();
  await actor(a, f.actor); await actor(b, f.other);
  const pid = (await b.query('select pg_backend_pid() id')).rows[0].id;
  const create = (c, wo) => c.query("select * from public.create_pallet_from_new_wo('TEST',$1,1000,100,'2026-11-18')", [wo]);
  const legacy = (c, wo) => c.query("select * from public.create_pallet_record('TEST','Product','Customer',$1,1000,null,100,null,'2026-11-18',true)", [wo]);
  const count = async wo => (await control.query('select count(*)::int n from public.pallet_data where lower(btrim(wo))=lower($1)', [wo])).rows[0].n;
  for (const [first, second] of [['RACE', 'RACE'], ['Case-Race', 'case-race']]) {
    await a.query('begin'); await create(a, first);
    const pending = attempt(create(b, second)); await waiting(control, pid); await a.query('commit');
    assert.match((await pending).error?.message ?? '', /PALLET_NEW_WO_EXISTS/); assert.equal(await count(first), 1);
  }
  await a.query('begin'); await create(a, 'ROLLBACK');
  const afterRollback = attempt(create(b, 'ROLLBACK')); await waiting(control, pid); await a.query('rollback');
  assert.equal((await afterRollback).result.rows[0].pallet_id, 'ROLLBACK-001'); assert.equal(await count('ROLLBACK'), 1);
  await a.query('begin'); await legacy(a, 'LEGACY-FIRST');
  const legacyFirst = attempt(create(b, 'LEGACY-FIRST')); await waiting(control, pid); await a.query('commit');
  assert.match((await legacyFirst).error?.message ?? '', /PALLET_NEW_WO_EXISTS/); assert.equal(await count('LEGACY-FIRST'), 1);
  await a.query('begin'); await create(a, 'NEW-FIRST');
  const append = attempt(legacy(b, 'NEW-FIRST')); await waiting(control, pid); await a.query('commit');
  assert.equal((await append).result.rows[0].pallet_id, 'NEW-FIRST-002');
  assert.equal((await b.query("select public.check_new_pallet_wo('BLUR-RACE') d")).rows[0].d.valid, true);
  await legacy(a, 'BLUR-RACE'); await assert.rejects(create(b, 'BLUR-RACE'), /PALLET_NEW_WO_EXISTS/);
  await control.query("select pg_advisory_lock(19111926,hashtext(lower('BUSY')))");
  const busy = attempt(create(b, 'BUSY')); await waiting(control, pid); assert.match((await busy).error?.message ?? '', /PALLET_NEW_WO_BUSY/);
  assert.equal(await count('BUSY'), 0); await control.query("select pg_advisory_unlock(19111926,hashtext(lower('BUSY')))");
  assert.equal((await create(b, 'BUSY')).rows[0].pallet_id, 'BUSY-001');
  assert.equal((await control.query("select count(*)::int n from pg_trigger where tgname in ('scan_stock_receive','scan_stock_receipt_complete')")).rows[0].n, 0);
  console.log('PASS: real concurrent new-WO/case-variant attempts yield one first label; rollback releases WO; legacy/new printing share locks; stale blur is rejected; timeout leaves no pallet and retry works. Scan activation stays off.');
} finally {
  for (const c of connections) try { await c.end(); } catch { /* continue cleanup */ }
  if (server) spawnSync(join(bin, 'pg_ctl'), ['-D', join(work, 'data'), 'stop', '-m', 'immediate'], { stdio: 'ignore' });
  if (log !== undefined) closeSync(log);
  await rm(work, { recursive: true, force: true });
}
