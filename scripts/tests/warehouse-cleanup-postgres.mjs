// Destructive tests use a newly initialized local cluster only; no DB URL accepted.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { cleanupFixture, preview, clear, reviewedSql } from './helpers/warehouse-cleanup-fixture.mjs';
const bin = process.env.CLEANUP_POSTGRES_BIN ?? process.env.SCAN_POSTGRES_BIN;
if (!bin) throw Error('Set CLEANUP_POSTGRES_BIN to a local PostgreSQL bin directory. No existing or production DB URL is accepted.');
const work = await mkdtemp(join(tmpdir(), 'svn-cleanup-'));
const port = await new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
const connections = []; let server, log;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const adapter = c => ({ query: (text, args) => c.query(text, args), exec: async text => { const result = await c.query(text); return Array.isArray(result) ? result : [result]; } });
async function connect() { const c = new pg.Client({ host: '127.0.0.1', port, user: 'svn_cleanup_test', database: 'postgres', connectionTimeoutMillis: 1000 }); await c.connect(); await c.query("set statement_timeout='15s'"); connections.push(c); return c; }
async function waiting(observer, pid) { const stop = Date.now() + 4000; while (Date.now() < stop) { if ((await observer.query('select wait_event from pg_stat_activity where pid=$1', [pid])).rows[0]?.wait_event === 'advisory') return; await delay(15); } throw Error('Expected test barrier advisory wait'); }
const attempt = p => p.then(result => ({ result }), error => ({ error }));
try {
  const init = spawnSync(join(bin, 'initdb'), ['-D', join(work, 'data'), '-A', 'trust', '-U', 'svn_cleanup_test', '--no-locale'], { encoding: 'utf8' });
  if (init.status !== 0) throw Error(init.stderr || init.stdout);
  log = openSync(join(work, 'postgres.log'), 'a');
  server = spawn(join(bin, 'postgres'), ['-D', join(work, 'data'), '-h', '127.0.0.1', '-p', String(port), '-c', 'unix_socket_directories='], { stdio: ['ignore', log, log] });
  let main; for (let i = 0; i < 100 && !main; i++) { try { main = await connect(); } catch { await delay(50); } }
  if (!main) throw Error(await readFile(join(work, 'postgres.log'), 'utf8'));
  console.log('Local server:', (await main.query('select version() v')).rows[0].v);
  const db = adapter(main), f = await cleanupFixture(db), b = await connect(), control = await connect(), other = adapter(b);
  const production = await f.seed({ status: 'production', palletId: 'CAN-CONTINUE-PRODUCTION' }); await main.query('reset role');
  let reviewed = await preview(db);
  await main.query('begin;select count(*) from public.inv_incoming');
  let started = performance.now();
  await assert.rejects(clear(other, reviewed), error => error.code === '55P03');
  assert.ok(performance.now() - started < 2000, 'NOWAIT refuses an active reader without a long wait'); await main.query('commit');
  await control.query('select pg_advisory_lock(72638104112000::bigint)');
  started = performance.now(); await assert.rejects(clear(other, reviewed), /WAREHOUSE_CLEANUP_BUSY/);
  assert.ok(performance.now() - started < 2000, 'Try-lock avoids inversion with an inventory/catalog writer');
  assert.ok((await main.query('select count(*)::int n from public.inv_incoming')).rows[0].n > 0, 'Refusal releases every target lock');
  await control.query('select pg_advisory_unlock(72638104112000::bigint)');
  await control.query('begin;lock table public.wh_receipt,public.pallet_data in share row exclusive mode');
  await assert.rejects(clear(other, reviewed), error => error.code === '55P03'); await control.query('rollback');
  await main.query('update public.inv_incoming set received_qty=received_qty+1 where id=$1', [f.stockId]);
  await assert.rejects(clear(other, reviewed), /STALE_PREVIEW/);
  reviewed = await preview(db);
  // In-memory test barrier freezes cleanup while all real locks are held.
  const script = (await reviewedSql(reviewed)).replace('-- One explicit FK-complete statement;', 'perform pg_advisory_xact_lock(987654321::bigint);\n  -- One explicit FK-complete statement;');
  const pid = (await b.query('select pg_backend_pid() id')).rows[0].id;
  await control.query('select pg_advisory_lock(987654321::bigint)');
  const pending = attempt(clear(other, reviewed, script));
  await waiting(control, pid);
  await main.query("set statement_timeout='1s'");
  await main.query("update public.pallet_data set product_name='Production continues' where id=$1", [production.id]);
  await main.query('begin');
  await assert.rejects(main.query('lock table public.wh_receipt,public.pallet_data in share row exclusive mode nowait'), error => error.code === '55P03');
  await main.query('rollback');
  await control.query('select pg_advisory_unlock(987654321::bigint)');
  const result = await pending; assert.ok(!result.error, result.error?.message);
  assert.ok(Object.values(await preview(db)).every(row => row.rows === 0));
  assert.equal((await main.query('select product_name from public.pallet_data where id=$1', [production.id])).rows[0].product_name, 'Production continues');
  assert.equal((await main.query('select count(*)::int n from public.wh_receipt where receipt_id=$1', [f.receipt.receipt_id])).rows[0].n, 1);
  assert.equal((await main.query('select count(*)::int n from public.wh_data_pallet where pallet_data_id=$1', [f.oldPallet.id])).rows[0].n, 1);
  console.log('PASS: PostgreSQL 17 real-session reader/writer/activation contention fails safely, stale preview rolls back, production row writes continue during cleanup, activation DDL is excluded, and all 11 target tables reset while scan receipts/snapshots survive.');
} finally {
  for (const c of connections) try { await c.end(); } catch { /* continue cleanup */ }
  if (server) spawnSync(join(bin, 'pg_ctl'), ['-D', join(work, 'data'), 'stop', '-m', 'immediate'], { stdio: 'ignore' });
  if (log !== undefined) closeSync(log);
  await rm(work, { recursive: true, force: true });
}
