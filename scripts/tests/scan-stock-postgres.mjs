// Creates and destroys its OWN local cluster. No database URL is accepted.
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { openSync,closeSync } from 'node:fs';
import { spawn,spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { fixture,sql,PREP,activate } from './helpers/scan-stock-fixture.mjs';
const bin=process.env.SCAN_POSTGRES_BIN;
if(!bin)throw Error('Set SCAN_POSTGRES_BIN to a local PostgreSQL bin directory. This test never connects to Supabase or an existing server.');
const work=await mkdtemp(join(tmpdir(),'svn-scan-postgres-'));
const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
const children=[];let server,log;const delay=ms=>new Promise(r=>setTimeout(r,ms));
const adapter=client=>({exec:text=>client.query(text),query:(text,args)=>client.query(text,args)});
async function connect(){const c=new pg.Client({host:'127.0.0.1',port,user:'svn_scan_test',database:'postgres',connectionTimeoutMillis:1000});await c.connect();await c.query("set statement_timeout='15s';set lock_timeout='10s'");children.push(c);return c;}
async function actor(c,id){await c.query('reset role');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await c.query('set role authenticated');}
async function waiting(observer,pid){const stop=Date.now()+4000;while(Date.now()<stop){const r=await observer.query("select wait_event from pg_stat_activity where pid=$1",[pid]);if(r.rows[0]?.wait_event==='advisory')return;await delay(15);}throw Error('Expected advisory lock wait, pid '+pid);}
const attempt=p=>p.then(result=>({result}),error=>({error}));
try{
 const init=spawnSync(join(bin,'initdb'),['-D',join(work,'data'),'-A','trust','-U','svn_scan_test','--no-locale'],{encoding:'utf8'});if(init.status!==0)throw Error(init.stderr||init.stdout);
 log=openSync(join(work,'postgres.log'),'a');server=spawn(join(bin,'postgres'),['-D',join(work,'data'),'-h','127.0.0.1','-p',String(port),'-c',"unix_socket_directories="],{stdio:['ignore',log,log]});
 let main;for(let i=0;i<100&&!main;i++){try{main=await connect();}catch{await delay(50);}}if(!main)throw Error(await readFile(join(work,'postgres.log'),'utf8'));
 console.log('Local server:',(await main.query('select version() as v')).rows[0].v);
 const db=adapter(main),f=await fixture(db);await main.query('reset role');await main.query(await sql(PREP));
 const a=await connect(),b=await connect(),control=await connect(),monitor=await connect();const aPid=(await a.query('select pg_backend_pid() id')).rows[0].id,bPid=(await b.query('select pg_backend_pid() id')).rows[0].id;
 const confirm=(c,ids)=>c.query('select * from public.create_warehouse_receipt_from_scan($1)',[ids]);
 const stock=async p=>(await control.query('select count(*)::int n,coalesce(sum(received_qty),0)::bigint qty from public.inv_incoming where scan_pallet_data_id=$1',[p.id])).rows[0];
 // An in-flight OLD confirm that already wrote receipt/pallet rows must finish
 // before activation can acquire its DDL locks. A timeout changes nothing.
 const pre=await f.seed();await actor(a,f.actor);await a.query('begin');await confirm(a,[pre.pallet_id]);
 await assert.rejects(activate(adapter(b)),e=>e.code==='55P03');
 assert.equal((await control.query("select count(*)::int n from pg_trigger where tgname='scan_stock_receive'")).rows[0].n,0);
 await a.query('commit');assert.equal((await stock(pre)).n,0);
 // A call already executing old RPC code but waiting BEFORE receipt writes must
 // see both new triggers when it resumes after the activation migration commits.
 const crossing=await f.seed();const day=(await control.query("select public.vietnam_working_day(now())::text d")).rows[0].d.replaceAll('-','');
 await control.query("select pg_advisory_lock(hashtext($1))",['WH_RECEIPT_'+day]);
 const crossingCall=attempt(confirm(a,[crossing.pallet_id]));await waiting(monitor,aPid);
 await activate(adapter(b));await control.query("select pg_advisory_unlock(hashtext($1))",['WH_RECEIPT_'+day]);
 const crossed=await crossingCall;assert.ok(crossed.result,crossed.error?.message);assert.equal((await stock(crossing)).n,1);assert.equal((await stock(pre)).n,0);
 console.log('PASS: bounded activation DDL lock timeout; old in-flight RPC across activation posts once; completed pre-cutover receipts are not backfilled.');
 // Same and overlapping pallet selections across real concurrent sessions.
 const same=await f.seed();await actor(a,f.actor);await actor(b,f.actor);await a.query('begin');const first=await confirm(a,[same.pallet_id]);
 const second=attempt(confirm(b,[same.pallet_id]));await waiting(monitor,bPid);await a.query('commit');assert.match((await second).error.message,/PALLET_STATUS_CHANGED/);
 assert.equal((await stock(same)).n,1);
 assert.equal((await b.query('select * from public.recover_scan_receipt($1)',[[same.pallet_id]])).rows[0].receipt_id,first.rows[0].receipt_id);
 const x=await f.seed(),y=await f.seed(),z=await f.seed();await a.query('begin');await confirm(a,[x.pallet_id,y.pallet_id]);
 const overlap=attempt(confirm(b,[y.pallet_id,z.pallet_id]));await waiting(monitor,bPid);await a.query('commit');assert.match((await overlap).error.message,/PALLET_STATUS_CHANGED/);
 assert.equal((await stock(z)).n,0);await confirm(b,[z.pallet_id]);
 console.log('PASS: duplicate and overlapping concurrent confirms never create duplicate/partial stock; exact full-receipt recovery works.');
 // Outgoing -> confirm lock ordering against the actual FIFO posting function.
 await f.as(f.supervisor);const reqId=crypto.randomUUID();await main.query('select public.post_manual_delivery($1,$2::jsonb)',[reqId,JSON.stringify({itemcode:'SCAN-A',delivery_date:'2026-11-19',ordered_qty:2})]);
 const preview=(await main.query('select public.preview_bulk_delivery($1::uuid[]) as d',[[reqId]])).rows[0].d;
 const group=preview.rows[0],lot=preview.lots['SCAN-A'][0];
 const ship={group_model_version:1,shipped_date:'2026-11-19',requests:preview.requests.map(({id,version,components})=>({id,version,components})),lots:[{group_key:group.group_key,incoming_id:lot.incoming_id,quantity:2}]};
 await actor(a,f.supervisor);await a.query('begin');await a.query('select public.post_bulk_delivery($1,$2::jsonb)',[crypto.randomUUID(),JSON.stringify(ship)]);
 const arriving=await f.seed();await actor(b,f.actor);const duringIssue=attempt(confirm(b,[arriving.pallet_id]));await waiting(monitor,bPid);await a.query('commit');assert.ok((await duringIssue).result);assert.equal((await stock(arriving)).n,1);
 const ledger=(await control.query("select s.balance_qty=(select sum(i.received_qty-i.issued_qty) from public.inv_incoming i where i.itemcode=s.itemcode) ok from public.inv_stock_summary s where itemcode='SCAN-A'")).rows[0];assert.equal(ledger.ok,true);
 await f.as(f.supervisor);const secondReq=crypto.randomUUID();await main.query('select public.post_manual_delivery($1,$2::jsonb)',[secondReq,JSON.stringify({itemcode:'SCAN-A',delivery_date:'2026-11-19',ordered_qty:2})]);
 const preview2=(await main.query('select public.preview_bulk_delivery($1::uuid[]) as d',[[secondReq]])).rows[0].d;
 const ship2={group_model_version:1,shipped_date:'2026-11-19',requests:preview2.requests.map(({id,version,components})=>({id,version,components})),lots:[{group_key:preview2.rows[0].group_key,incoming_id:preview2.lots['SCAN-A'][0].incoming_id,quantity:2}]};
 const arrivalFirst=await f.seed();await actor(a,f.actor);await a.query('begin');await confirm(a,[arrivalFirst.pallet_id]);await actor(b,f.supervisor);
 const issueAfterScan=attempt(b.query('select public.post_bulk_delivery($1,$2::jsonb)',[crypto.randomUUID(),JSON.stringify(ship2)]));await waiting(monitor,bPid);await a.query('commit');assert.ok((await issueAfterScan).result);await actor(b,f.actor);
 console.log('PASS: FIFO outflow and scan serialize in both lock orders without deadlock and preserve item summary.');
 // Busy inventory fails in five seconds; unrelated production updates do not
 // enter the inventory lock. The failed receipt and snapshots must roll back.
 const busyPallet=await f.seed(),production=await f.seed({status:'production'});
 await control.query('begin');await control.query('select pg_advisory_xact_lock(72638104112000::bigint)');
 const busyCall=attempt(confirm(b,[busyPallet.pallet_id]));await waiting(monitor,bPid);
 await main.query('reset role');await main.query("set statement_timeout='1s'");await main.query("update public.pallet_data set product_name='Production still editable' where id=$1",[production.id]);await main.query("set statement_timeout='15s'");
 const busyResult=await busyCall;assert.match(busyResult.error.message,/SCAN_STOCK_BUSY/);await control.query('rollback');
 assert.equal((await stock(busyPallet)).n,0);assert.equal((await control.query('select count(*)::int n from public.wh_data_pallet where pallet_data_id=$1',[busyPallet.id])).rows[0].n,0);
 await confirm(b,[busyPallet.pallet_id]);assert.equal((await stock(busyPallet)).n,1);
 console.log('PASS: busy stock lock rolls back receipt/snapshot/stock within timeout; production-only edits continue; retry succeeds once.');
 // Cancellation after header totals are read, but before final status updates.
 await control.query(`create function public.test_scan_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(1938123); return new; end $$;
 create trigger test_scan_barrier before insert on public.wh_receipt for each row execute function public.test_scan_barrier();`);
 const cancelA=await f.seed(),cancelB=await f.seed();await actor(a,f.actor);await actor(b,f.actor);
 await control.query('select pg_advisory_lock(1938123)');const raced=attempt(confirm(a,[cancelA.pallet_id,cancelB.pallet_id]));await waiting(monitor,aPid);
 await b.query('select public.cancel_pending_pallet($1)',[cancelA.pallet_id]);await control.query('select pg_advisory_unlock(1938123)');
 const canceled=await raced;assert.match(canceled.error.message,/SCAN_STOCK_RECEIPT_MISMATCH/);
 assert.equal((await stock(cancelA)).n,0);assert.equal((await stock(cancelB)).n,0);
 assert.equal((await control.query('select status from public.pallet_data where id=$1',[cancelB.id])).rows[0].status,'pendingWH');
 await control.query('drop trigger test_scan_barrier on public.wh_receipt;drop function public.test_scan_barrier()');
 console.log('PASS: actual concurrent cancellation cannot commit a partial receipt or partial inventory.');
 // Missing receiving trigger must fail closed, rather than silently losing stock.
 await control.query('alter table public.pallet_data disable trigger scan_stock_receive');const blocked=await f.seed();
 await assert.rejects(confirm(b,[blocked.pallet_id]),/SCAN_STOCK_RECEIPT_MISMATCH/);assert.equal((await stock(blocked)).n,0);
 await control.query('alter table public.pallet_data enable trigger scan_stock_receive');await confirm(b,[blocked.pallet_id]);assert.equal((await stock(blocked)).n,1);
 await assert.rejects(activate(adapter(control)),/ALREADY_ACTIVATED/);
 const bulkRows=[];for(let i=0;i<200;i++)bulkRows.push((await f.seed({palletId:'LOAD-'+i,code:'LOAD',quantity:3})).pallet_id);
 const started=performance.now();const load=await confirm(b,bulkRows);const elapsed=Math.round(performance.now()-started);
 assert.equal(load.rows[0].total_pallet,200);assert.equal(Number(load.rows[0].total_quantity),600);
 assert.equal((await control.query('select count(*)::int n from public.inv_incoming where receipt_id=$1',[load.rows[0].receipt_id])).rows[0].n,200);
 console.log('PASS: 200-pallet batch in '+elapsed+' ms on the temporary PostgreSQL server; disabled bridge fails closed; activation cannot run twice.');
}finally{
 for(const c of children)try{await c.end();}catch{}
 if(server){spawnSync(join(bin,'pg_ctl'),['-D',join(work,'data'),'stop','-m','immediate'],{stdio:'ignore'});}
 if(log!==undefined)closeSync(log);
 await rm(work,{recursive:true,force:true});
}
