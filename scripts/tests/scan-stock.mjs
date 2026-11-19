import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readdir } from 'node:fs/promises';
import { fixture,sql,PREP,HELD,activate,definition } from './helpers/scan-stock-fixture.mjs';
const date=v=>v instanceof Date?v.toISOString().slice(0,10):v;
const db=new PGlite();
try{
 const f=await fixture(db);
 const cutoff=(await db.query("select public.vietnam_working_day('2026-11-19T22:59:00Z') a,public.vietnam_working_day('2026-11-19T23:00:00Z') b")).rows[0];
 assert.deepEqual([date(cutoff.a),date(cutoff.b)],['2026-11-19','2026-11-20']);
 const old=(await f.seed({palletId:'BEFORE-PREP'}));await f.confirm([old.pallet_id]);
 const original=(await db.query("select prosrc,proacl::text as acl from pg_proc where oid='public.create_warehouse_receipt_from_scan(text[])'::regprocedure")).rows[0];
 await db.exec('reset role');await db.exec(await sql(PREP));await f.as();
 assert.deepEqual((await db.query("select prosrc,proacl::text as acl from pg_proc where oid='public.create_warehouse_receipt_from_scan(text[])'::regprocedure")).rows[0],original);
 const dormant=await f.seed({palletId:'AFTER-PREP'});await f.confirm([dormant.pallet_id]);assert.equal((await f.inventory()).length,0);
 await assert.rejects(db.query('select public.scan_stock_receive_transition()'),/permission denied/);
 await db.exec('reset role');
 try{await db.exec(await sql(HELD));assert.fail('Held SQL must refuse activation');}catch(e){await db.exec('rollback');assert.match(e.message,/ACTIVATION_NOT_AUTHORIZED/);}
 assert.equal((await db.query("select count(*)::int as n from pg_trigger where tgname like 'scan_stock_%'")).rows[0].n,0);
 assert.equal((await f.preflight()).ready_to_activate,true);
 const canonical=definition(await sql('supabase/migrations/20260922090000_wh_pallet_snapshot_and_position_scan.sql'),'create_warehouse_receipt_from_scan');
 await db.exec('reset role');await db.exec(canonical.replace('v_date date :=','-- local drift test\n  v_date date :='));
 await assert.rejects(activate(db),/SCAN_RPC_DRIFT/);await db.exec(canonical);
 await db.exec("create function public.unreviewed_receipt_writer() returns void language plpgsql as $$ begin insert into public.wh_receipt(receipt_id) values('x'); end $$");
 await assert.rejects(activate(db),/OTHER_RECEIPT_WRITERS/);await db.exec('drop function public.unreviewed_receipt_writer()');
 const badBefore=await f.seed({name:'',customer:'',code:'MISSING'});await db.exec('reset role');
 await assert.rejects(activate(db),/PENDING_PALLETS_INVALID/);
 await db.query("update public.pallet_data set product_name='Fixed' where id=$1",[badBefore.id]);
 await activate(db);await f.as();
 assert.equal((await f.inventory()).length,0,'Activation never backfills completed pallets');
 const a=await f.seed({code:'NO-CUSTOMER',quantity:5,name:'At confirmation',customer:''}),b=await f.seed({quantity:7,code:'SCAN-B',production:null});
 const receipt=await f.confirm([a.pallet_id,b.pallet_id]);let rows=await f.inventory();
 assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.received_qty),[5,7]);assert.ok(rows.every(r=>r.receipt_id===receipt.receipt_id&&r.source_type==='scan'&&r.entered_by===f.actor));
 assert.equal(rows[0].customer,'');assert.equal(rows[0].product_name,'At confirmation');assert.equal(rows[1].production_date,null);
 assert.equal(date(rows[0].received_date),date(receipt.receipt_date));assert.equal(date(rows[0].production_date),'2026-11-10');
 assert.deepEqual((await f.recover([a.pallet_id,b.pallet_id])).map(r=>r.receipt_id),[receipt.receipt_id]);
 assert.deepEqual(await f.recover([a.pallet_id]),[]);assert.deepEqual(await f.recover([old.pallet_id,a.pallet_id]),[]);
 await f.as(f.other);assert.deepEqual(await f.recover([a.pallet_id,b.pallet_id]),[]);await f.as();
 await assert.rejects(f.confirm([a.pallet_id,b.pallet_id]),/PALLET_STATUS_CHANGED_OR_NOT_OWNER/);assert.equal((await f.inventory()).length,2);
 await db.exec('reset role');await db.query("update public.pallet_data set position='A-01-02' where id=$1",[old.id]);await f.as();assert.equal((await f.inventory()).length,2);
 // Fallback uses the shared read-only identity, without changing production data.
 await db.exec('reset role');await db.query('insert into public.item_pallet_config(itemcode,"ERP_name") values($1,$2)',['ERP-FALLBACK','ERP display']);
 const fallback=await f.seed({code:'ERP-FALLBACK',name:'',customer:''});await f.confirm([fallback.pallet_id]);
 assert.equal((await f.inventory()).find(r=>r.scan_pallet_id===fallback.pallet_id).product_name,'ERP display');
 const bad=await f.seed({code:'MISSING-AFTER',name:'',customer:''});const good=await f.seed({quantity:9});
 await db.exec('reset role');const before=(await db.query('select count(*)::int n from public.wh_receipt')).rows[0].n;await f.as();
 await assert.rejects(f.confirm([good.pallet_id,bad.pallet_id]),/SCAN_STOCK_MISSING_NAME/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from public.wh_receipt')).rows[0].n,before);
 assert.equal((await db.query('select count(*)::int n from public.wh_data_pallet where pallet_data_id=any($1)',[[good.id,bad.id]])).rows[0].n,0);
 assert.equal((await db.query('select status from public.pallet_data where id=$1',[good.id])).rows[0].status,'pendingWH');
 // End-of-transaction validation catches empty or incomplete confirmations.
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f.actor]);
 try{await db.exec("begin;insert into public.wh_receipt values('EMPTY',public.vietnam_working_day(now()),1,5,'"+f.actor+"','active',now());commit");assert.fail();}catch(e){await db.exec('rollback');assert.match(e.message,/SCAN_STOCK_RECEIPT_MISMATCH/);}
 try{await db.exec("begin;insert into public.wh_receipt values('PARTIAL',public.vietnam_working_day(now()),2,10,'"+f.actor+"','active',now());update public.pallet_data set status='WHdone',wh_receipt='PARTIAL' where id="+good.id+";commit");assert.fail();}catch(e){await db.exec('rollback');assert.match(e.message,/SCAN_STOCK_RECEIPT_MISMATCH/);}
 assert.equal((await db.query("select count(*)::int n from public.wh_receipt where receipt_id in ('EMPTY','PARTIAL')")).rows[0].n,0);
 try{await db.exec("begin;update public.pallet_data set status='processingWH' where id="+a.id+";update public.pallet_data set status='WHdone' where id="+a.id+";commit");assert.fail();}catch(e){await db.exec('rollback');assert.match(e.message,/SCAN_STOCK_ALREADY_POSTED/);}
 await f.as(f.supervisor);const legacy=await f.seed({status:'processingWH',owner:f.supervisor,quantity:3});await f.as(f.supervisor);
 const legacyResult=(await db.query('select * from public.create_warehouse_receipt($1)',[[legacy.pallet_id]])).rows[0];assert.ok((await f.inventory()).some(r=>r.receipt_id===legacyResult.receipt_id));
 await db.exec('reset role');await db.query("update public.pallet_data set product_name='Now fixed' where id=$1",[bad.id]);
 const batch=[];for(let i=0;i<200;i++)batch.push((await f.seed({palletId:'BATCH-'+i,code:'BATCH',quantity:10})).pallet_id);
 const started=performance.now();const bulk=await f.confirm(batch);const elapsed=Math.round(performance.now()-started);
 assert.equal(Number(bulk.total_quantity),2000);assert.equal((await f.inventory()).filter(r=>r.receipt_id===bulk.receipt_id).length,200);
 const huge=await f.seed({code:'BIG',quantity:2147483647}),huge2=await f.seed({code:'BIG',quantity:2147483647});const big=await f.confirm([huge.pallet_id,huge2.pallet_id]);assert.equal(Number(big.total_quantity),4294967294);
 await db.exec('reset role');assert.equal((await db.query("select count(*)::int n from public.inv_incoming where scan_pallet_data_id=any($1)",[[old.id,dormant.id]])).rows[0].n,0);
 assert.deepEqual((await db.query("select prosrc,proacl::text as acl from pg_proc where oid='public.create_warehouse_receipt_from_scan(text[])'::regprocedure")).rows[0],original);
 assert.equal((await db.query("select count(*)::int n from public.inv_incoming i join public.pallet_data p on p.id=i.scan_pallet_data_id where i.received_qty<>p.quantity or i.receipt_id<>p.wh_receipt")).rows[0].n,0);
 const migrations=await readdir(new URL('../../supabase/migrations/',import.meta.url));assert.ok(!migrations.some(n=>n.includes('activate_scan_stock')));
 const held=await sql(HELD);assert.ok(held.includes("cutover_note text:='__WAITING_FOR_USER_APPROVAL__'"));
 console.log('PASS: dormant preparation, activation handbrake/preflight/drift guards, no historical backfill, canonical and legacy RPCs, atomic stock/summary, names/customer/date mapping, receipt reconciliation at COMMIT, source uniqueness, recovery scope and 200-pallet batch ('+elapsed+' ms, PGlite).');
}finally{await db.close();}
