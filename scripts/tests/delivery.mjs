import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
const require = createRequire(import.meta.url);
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file);
const { parseDeliverySheet, parseManualDeliveryInput, previewDeliveryDemand } = require("../../lib/warehouse-receipt/outgoing.ts");
const { expandMergedCells } = require("../../lib/excel-merged.ts");

const header = Array(33).fill(null);
for (const [i, v] of [[1,"Delivery Date\n"],[8,"Purchorder "],[13,"Sales Id"],[16,"No"],[18,"Item"],[28,"Sales Qty"]]) header[i]=v;
const excelLine = (no, item, quantity, unit="PCS") => {
  const row = Array(33).fill(null);
  row[16]=no; row[18]=item; row[28]=quantity; row[31]=unit;
  return row;
};
const source = [header, excelLine(1,"0011223344556",70), excelLine(2,"B",40)];
source[1][1]=new Date("2026-10-27T00:00:00Z"); source[1][8]="PO"; source[1][13]="SO";
const parsed = parseDeliverySheet(expandMergedCells(source,["B2:C3","I2:M3","N2:P3"]));
assert.equal(parsed.errors.length,0);
assert.equal(parsed.rows.length,2);
assert.equal(parsed.rows[1].sales_id,"SO");
assert.equal(parsed.rows[0].delivery_date,"2026-10-27");
assert.equal(parsed.rows[0].itemcode,"0011223344556");
assert.ok(parseDeliverySheet(source).errors.length>0,"Never forward-fill unmerged blank fields");
const duplicates=expandMergedCells([header,source[1],Object.assign([...source[1]],{16:2})],[]);
assert.equal(parseDeliverySheet(duplicates).errors.length,1);
const bad=structuredClone(source[1]); bad[28]=-1;
assert.equal(parseDeliverySheet([header,bad]).errors.length,1);
const set=structuredClone(source[1]); set[31]="Bộ";
assert.equal(parseDeliverySheet([header,set]).rows[0].unit,"SET");

const demandRows=[{...parsed.rows[0],existing:null,candidates:[{id:"move",ordered_qty:60,shipped_qty:20,cancelled:false}],item_stock_qty:100,item_on_order_qty:90,item_on_order_after:160,item_shortage_after:60}];
assert.equal(previewDeliveryDemand(demandRows,{[demandRows[0].excel_row]:"new"})[0].item_on_order_after,160);
assert.equal(previewDeliveryDemand(demandRows,{[demandRows[0].excel_row]:"move"})[0].item_on_order_after,100);
const db=new PGlite();
const actor=randomUUID();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create function public.has_permission(text) returns boolean language sql as $$ select coalesce(current_setting('test.permission',true),'yes')<>'no' $$;
create function public.vietnam_working_day(timestamptz) returns date language sql as $$ select $1::date $$;
create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at:=now(); return new; end $$;
create table public.profiles(id uuid primary key,is_active boolean,role text,full_name text,username text);
insert into public.profiles values('${actor}',true,'superadmin','Test Operator','test');
create table public.wh_receipt(receipt_id text primary key);
create table public.item_pallet_config(itemcode text primary key,product_name text,customer text,quantity_per_pallet integer);
create table public.pallet_data(id bigint primary key,itemcode text,product_name text,customer text,effect_to timestamptz,updated_at timestamptz);
create function public.resolve_warehouse_item(text) returns table(product_name text,customer text) language sql as $$ select 'Product','Customer' $$;
select set_config('test.actor','${actor}',false);
`);
const migrate = async file => db.exec(await readFile(new URL("../../supabase/migrations/"+file,import.meta.url),"utf8"));
for(const file of [
  "20261026090000_inventory_incoming.sql","20261026100000_post_manual_inventory.sql","20261105090000_optional_inventory_note.sql",
  "20261105100000_opening_inventory_import.sql","20261105110000_opening_inventory_outflow_and_catalog.sql",
  "20261105120000_delivery_reservations.sql","20261105130000_delivery_import_units_optional.sql",
]) await migrate(file);
const seed=async(item,qty,production)=>db.query("insert into public.inv_incoming(itemcode,product_name,customer,received_qty,received_date,production_date,note) values($1,'Product','Customer',$2,'2026-10-01',$3,'test') returning id",[item,qty,production]);
await seed("A",60,"2026-09-01"); await seed("A",40,"2026-09-02"); await seed("B",12,"2026-09-01"); await seed("S",10,"2026-09-01");
await seed("C",100,"2026-09-01");
await db.exec("set role authenticated");
const rpc=async(action,payload,id=randomUUID())=>(await db.query("select public.manage_delivery($1,$2,$3::jsonb) as result",[action,id,JSON.stringify(payload)])).rows[0].result;
const line=(po,item,qty,date="2026-10-27",extra={})=>({
  excel_row:12, purorder:po, sales_id:"SO-"+po, itemcode:item, ordered_qty:qty,delivery_date:date,
  product_name:"Product",customer:"Customer",unit:"EA",unit_label:"PCS",...extra,
});
const normalizeDate=r=>({...r,delivery_date:r.delivery_date instanceof Date?r.delivery_date.toISOString().slice(0,10):r.delivery_date});
const get=async(po)=>(await db.query("select * from public.inv_delivery_requests where purorder=$1 order by delivery_date",[po])).rows.map(normalizeDate);
const request=async(id)=>(await db.query("select * from public.inv_delivery_requests where id=$1",[id])).rows.map(normalizeDate)[0];
const totals=async(item)=>(await db.query("select sum(balance_qty)::int as balance,sum(reserved_qty)::int as reserved,sum(available_qty)::int as available,sum(issued_qty)::int as issued from public.inv_incoming where itemcode=$1",[item])).rows[0];
const preview=await rpc("preview",{rows:[line("P2","A",50,"2026-10-28"),line("P1","A",70)]});
assert.deepEqual(preview.rows.map(r=>[r.purorder,r.suggested_reserved,r.shortage_qty]),[["P1",70,0],["P2",30,20]]);
assert.deepEqual(await totals("A"),{balance:100,reserved:0,available:100,issued:0});
const importPayload={rows:[line("P2","A",50,"2026-10-28"),line("P1","A",70)],file_name:"test.xlsx"};
const command=randomUUID();
assert.deepEqual(await rpc("import",importPayload,command),{changed:2,skipped:0});
assert.deepEqual(await rpc("import",importPayload,command),{changed:2,skipped:0});
assert.deepEqual(await rpc("import",importPayload),{changed:0,skipped:2});
await assert.rejects(rpc("import",{...importPayload,file_name:"other"},command),/DELIVERY_COMMAND_CONFLICT/);
assert.deepEqual(await totals("A"),{balance:100,reserved:100,available:0,issued:0});
let p1=(await get("P1"))[0],p2=(await get("P2"))[0];
const allocations=(await db.query("select quantity from public.inv_delivery_reservations where request_id=$1 order by incoming_id",[p1.id])).rows.map(r=>r.quantity);
assert.deepEqual(allocations,[60,10],"Oldest stock is reserved first");
const ship={id:p1.id,version:p1.version,quantity:20,shipped_date:"2026-10-28"};
const shipID=randomUUID();
assert.equal((await rpc("ship",ship,shipID)).shipped,20);
assert.equal((await rpc("ship",ship,shipID)).shipped,20);
await assert.rejects(rpc("ship",ship),/DELIVERY_STALE/);
assert.deepEqual(await totals("A"),{balance:80,reserved:80,available:0,issued:20});
p1=await request(p1.id);
await assert.rejects(rpc("edit",{id:p1.id,version:p1.version,ordered_qty:19,delivery_date:p1.delivery_date}),/DELIVERY_BELOW_SHIPPED/);
await rpc("edit",{id:p1.id,version:p1.version,ordered_qty:25,delivery_date:p1.delivery_date});
assert.deepEqual(await totals("A"),{balance:80,reserved:35,available:45,issued:20});
const restockedPreview=await rpc("preview",{rows:[line("P2","A",50,"2026-10-28")]});
assert.equal(restockedPreview.rows[0].suggested_reserved,30,"Unchanged imports must not promise extra reservations");
await rpc("reserve",{});
p2=await request(p2.id); assert.equal(p2.reserved_qty,50);
await rpc("cancel",{id:p2.id,version:p2.version});
assert.deepEqual(await totals("A"),{balance:80,reserved:5,available:75,issued:20});
p1=await request(p1.id);
await assert.rejects(rpc("ship",{id:p1.id,version:p1.version,quantity:6,shipped_date:"2026-10-28"}),/DELIVERY_INSUFFICIENT_RESERVED/);
await rpc("ship",{id:p1.id,version:p1.version,quantity:5,shipped_date:"2026-10-29"});
p1=await request(p1.id);
assert.equal(p1.shipped_qty,25);
await assert.rejects(rpc("cancel",{id:p1.id,version:p1.version}),/DELIVERY_DONE/);
await rpc("import",{rows:[line("PB","B",8)]});
let pb=(await get("PB"))[0];
await assert.rejects(rpc("import",{rows:[line("PB","B",4,"2026-10-28")]}),/DELIVERY_CHOOSE_SCHEDULE/);
await rpc("import",{rows:[line("PB","B",4,"2026-10-28",{mode:"new"})]});
await assert.rejects(rpc("edit",{id:pb.id,version:pb.version,ordered_qty:8,delivery_date:"2026-10-28"}),/DELIVERY_DATE_CONFLICT/);
const editID=randomUUID();
const editPayload={id:pb.id,version:pb.version,ordered_qty:8,delivery_date:"2026-10-29"};
assert.deepEqual(await rpc("edit",editPayload,editID),{changed:1,skipped:0});
assert.deepEqual(await rpc("edit",editPayload,editID),{changed:1,skipped:0});
assert.equal((await request(pb.id)).delivery_date,"2026-10-29");
assert.equal((await get("PB")).length,2,"Rescheduling preserves the ID");

await rpc("import",{rows:[line("SET","S",3,"2026-10-27",{unit:"SET",unit_label:"Bộ"})]});
await rpc("import",{rows:[line("OTHERUNIT","S",2,"2026-10-28",{unit:"EA",unit_label:"Any label"})]});
assert.equal((await totals("S")).reserved,5,"Unit labels do not block or convert source quantities");
const noUnit=structuredClone(source[1]);noUnit[31]=null;
assert.equal(parseDeliverySheet([header,noUnit]).rows[0].ordered_qty,70);
const otherUnit=structuredClone(source[1]);otherUnit[31]="Thùng";
assert.equal(parseDeliverySheet([header,otherUnit]).errors.length,0);
await assert.rejects(rpc("import",{rows:[line("ROLLBACK","A",4),line("LATEBAD","B",-1,"2026-12-01")]}),/DELIVERY_INVALID_ROW/);
assert.equal((await get("ROLLBACK")).length,0,"The whole file rolls back on a late error");
await Promise.all([rpc("import",{rows:[line("C1","C",70)]}),rpc("import",{rows:[line("C2","C",70)]})]);
assert.equal((await totals("C")).reserved,100,"Combined demand never overbooks stock");
await db.exec("set test.permission='no'");
await assert.rejects(rpc("reserve",{}),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("set test.permission='yes'");
await assert.rejects(db.exec("update public.inv_incoming set reserved_qty=0"),/permission denied/);
await assert.rejects(db.query("select public.reserve_delivery_request($1)",[p1.id]),/permission denied/);
await db.exec("reset role;set role anon");
await assert.rejects(rpc("reserve",{}),/permission denied/);
await db.exec("reset role;set role authenticated");
const list=(await db.query("select public.list_delivery(0,'P1',true) as data")).rows[0].data;
assert.equal(list.rows[0].status,"done");
const manualID=randomUUID();
await db.query("select * from public.post_manual_inventory($1,$2::jsonb)",[manualID,JSON.stringify([{itemcode:"A",received_date:"2026-11-05",production_date:null,wo:null,quantity:5,note:""}])]);
assert.equal((await totals("A")).available,80,"Manual receipts remain compatible and do not auto-reserve");
const invariants=await db.query(`
select count(*)::int as failures from (
 select i.id::text from public.inv_incoming i where
   i.reserved_qty <> coalesce((select sum(a.quantity) from public.inv_delivery_reservations a where a.incoming_id=i.id),0)
   or i.issued_qty <> coalesce((select sum(l.quantity) from public.inv_delivery_issue_lines l where l.incoming_id=i.id),0)
 union all
 select d.id::text from public.inv_delivery_requests d where
   d.reserved_qty <> coalesce((select sum(a.quantity) from public.inv_delivery_reservations a where a.request_id=d.id),0)
   or d.shipped_qty <> coalesce((select sum(s.quantity) from public.inv_delivery_issues s where s.request_id=d.id),0)
) bad`);
assert.equal(invariants.rows[0].failures,0,"All counters match their allocation/issue ledgers");

// Upgrade a populated database. Historical issues must survive unchanged.
const preUpgradeRequest=await request(pb.id);
const priorHistory=(await db.query("select id,request_id,quantity,shipped_date from public.inv_delivery_issues order by id")).rows;
const priorIssued=(await db.query("select id,issued_qty from public.inv_incoming order by id")).rows;
await db.exec("reset role");
await migrate("20261105140000_item_stock_summary.sql");
assert.deepEqual((await db.query("select id,request_id,quantity,shipped_date from public.inv_delivery_issues order by id")).rows,priorHistory);
assert.deepEqual((await db.query("select id,issued_qty from public.inv_incoming order by id")).rows,priorIssued);
assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='inv_incoming' and column_name='reserved_qty'")).rows[0].n,0);
assert.equal((await request(pb.id)).version,preUpgradeRequest.version+1,"Migration invalidates unexecuted old-screen actions");
await assert.rejects(rpc("ship",{id:pb.id,version:preUpgradeRequest.version,quantity:1,shipped_date:"2026-11-05"}),/DELIVERY_STALE/);
assert.equal((await rpc("ship",ship,shipID)).shipped,20,"Already-committed old commands still retry without issuing again");
const summary=async item=>(await db.query("select * from public.inv_stock_summary where itemcode=$1",[item])).rows[0];
assert.equal(Number((await summary("C")).on_order_qty),140,"Full pending demand, including the unreserved part, is rebuilt");
assert.equal(Number((await summary("C")).shortage_qty),40);
const unaffected=(await summary("A")).updated_at;
const oldest=(await seed("SUMMARY",60,"2026-01-01")).rows[0].id;
const newer=(await seed("SUMMARY",40,"2026-02-01")).rows[0].id;
assert.equal(Number((await summary("SUMMARY")).balance_qty),100,"Incoming statements refresh the affected item");
assert.deepEqual((await summary("A")).updated_at,unaffected,"Unrelated summaries are untouched");
await db.exec("set role authenticated");
const modelPreview=await rpc("preview",{rows:[line("SUM1","SUMMARY",70),line("SUM2","SUMMARY",50,"2026-10-28")]});
assert.equal(modelPreview.model_version,2);
assert.ok(modelPreview.rows.every(row=>row.item_stock_qty===100 && row.item_on_order_after===120 && row.item_shortage_after===20));
assert.equal(Number((await summary("SUMMARY")).on_order_qty),0,"Preview never books demand");
await rpc("import",{rows:[line("SUM1","SUMMARY",70),line("SUM2","SUMMARY",50,"2026-10-28")]});
assert.equal(Number((await summary("SUMMARY")).balance_qty),100);
assert.equal(Number((await summary("SUMMARY")).on_order_qty),120);
assert.equal(Number((await summary("SUMMARY")).available_qty),-20,"Projected stock may be negative");
const sum1=(await get("SUM1"))[0], sum2=(await get("SUM2"))[0];
const fifo=async(id,qty)=>(await db.query("select public.preview_delivery_fifo($1,$2) as data",[id,qty])).rows[0].data;
assert.equal((await fifo(sum1.id,60)).fifo[0].incoming_id,Number(oldest));
const secondShip={id:sum2.id,version:sum2.version,quantity:20,shipped_date:"2026-11-05"};
const secondID=randomUUID();
assert.equal((await rpc("ship",secondShip,secondID)).shipped,20);
assert.equal((await rpc("ship",secondShip,secondID)).shipped,20);
assert.equal(Number((await summary("SUMMARY")).on_order_qty),100);
assert.equal(Number((await summary("SUMMARY")).balance_qty),80);
assert.equal(Number((await summary("SUMMARY")).shortage_qty),20);
const firstID=randomUUID();
await rpc("ship",{id:sum1.id,version:sum1.version,quantity:60,shipped_date:"2026-11-05"},firstID);
assert.deepEqual((await db.query("select incoming_id::int,quantity from public.inv_delivery_issue_lines where issue_id=$1 order by incoming_id",[firstID])).rows,
 [{incoming_id:Number(oldest),quantity:40},{incoming_id:Number(newer),quantity:20}],
 "The first confirmed delivery gets the oldest stock, regardless of schedule priority or earlier previews");
let currentSum2=await request(sum2.id);
await assert.rejects(rpc("ship",{id:sum2.id,version:currentSum2.version,quantity:21,shipped_date:"2026-11-05"}),/DELIVERY_INSUFFICIENT_STOCK/);
assert.equal(Number((await summary("SUMMARY")).balance_qty),20);
assert.equal(Number((await summary("SUMMARY")).on_order_qty),40);
await rpc("cancel",{id:sum2.id,version:currentSum2.version});
assert.equal(Number((await summary("SUMMARY")).on_order_qty),10);
let currentSum1=await request(sum1.id);
await rpc("edit",{id:sum1.id,version:currentSum1.version,ordered_qty:60,delivery_date:currentSum1.delivery_date});
assert.equal(Number((await summary("SUMMARY")).on_order_qty),0);
assert.equal(Number((await summary("SUMMARY")).balance_qty),20);
await db.query("select * from public.post_manual_inventory($1,$2::jsonb)",[randomUUID(),JSON.stringify([{itemcode:"SUMMARY",received_date:"2026-11-05",production_date:null,quantity:10,note:""}])]);
assert.equal(Number((await summary("SUMMARY")).balance_qty),30,"Manual receipts immediately update the item summary");
await db.exec("reset role");
const extra=(await seed("REKEY-A",7,null)).rows[0].id;
await db.query("update public.inv_incoming set itemcode='REKEY-B' where id=$1",[extra]);
assert.equal(Number((await summary("REKEY-A")).balance_qty),0);
assert.equal(Number((await summary("REKEY-B")).balance_qty),7);
await db.query("delete from public.inv_incoming where id=$1",[extra]);
assert.equal(Number((await summary("REKEY-B")).balance_qty),0);
await db.exec("insert into public.item_pallet_config(itemcode,product_name,customer) values ('SUMMARY','Renamed','New Customer')");
assert.equal((await summary("SUMMARY")).product_name,"Renamed");
await db.exec("grant select on public.profiles,public.item_pallet_config,public.pallet_data to service_role; grant insert,update on public.item_pallet_config to service_role; set role service_role");
await db.query("select * from public.post_opening_inventory($1,$2,$3,$4::jsonb,$5)",[actor,"e".repeat(64),"opening.xlsx",JSON.stringify([{excel_row:6,kind:"opening",itemcode:"SUMMARY-OPEN",product_name:"Opening",received_date:"2026-11-05",production_date:null,wo:null,received_qty:13,issued_qty:3,balance_qty:10}]),null]);
await db.exec("reset role");
assert.equal(Number((await summary("SUMMARY-OPEN")).balance_qty),10,"Service-role opening imports also update summaries");
const modelList=(await db.query("select public.list_delivery(0,'SUM1',true) as data")).rows[0].data;
assert.equal(modelList.model_version,2);
assert.equal(modelList.rows[0].status,"done");
assert.equal(modelList.rows[0].remaining_qty,0);
await db.exec("set role authenticated");
await assert.rejects(db.exec("update public.inv_stock_summary set on_order_qty=0"),/permission denied/);
await assert.rejects(db.query("select public.refresh_stock_summary(array['SUMMARY'])"),/permission denied/);
await assert.rejects(db.exec("select * from public.inv_delivery_reservations_legacy"),/permission denied/);
await assert.rejects(rpc("import",{rows:[line("NEW-ROLLBACK","SUMMARY",2),line("BAD-AFTER","SUMMARY",-1,"2027-01-01")]}),/DELIVERY_INVALID_ROW/);
assert.equal((await get("NEW-ROLLBACK")).length,0);
assert.equal(Number((await summary("SUMMARY")).on_order_qty),0,"Late import errors roll back summary triggers too");
const finalCheck=await db.query("select count(*)::int as failures from public.inv_stock_summary s where s.balance_qty <> coalesce((select sum(i.balance_qty) from public.inv_incoming i where i.itemcode=s.itemcode),0) or s.on_order_qty <> coalesce((select sum(d.ordered_qty-d.shipped_qty) from public.inv_delivery_requests d where d.itemcode=s.itemcode and not d.cancelled),0)");
assert.equal(finalCheck.rows[0].failures,0,"Every item summary matches its stock and pending-demand sources");
const summaryRead=(await db.query("select public.list_stock_summary(0,'C',true) as data")).rows[0].data;
assert.equal(summaryRead.model_version,2);
assert.ok(summaryRead.rows.some(row=>row.itemcode==="C" && row.shortage_qty===40));
console.log("PASS: populated migration, automatic item-only refresh, uncapped On order, first-confirmed FIFO, partial/cancel/edit, retry, rekeys/deletes, summary permissions and source reconciliation.");

await db.exec("reset role");
await migrate("20261105150000_delivery_system_customer.sql");
const backfilled=await request(sum1.id);
assert.equal(backfilled.system_customer_name,"New Customer","Existing ERP requests get the catalog name");
assert.equal(backfilled.customer,"Customer","The ERP customer name remains intact");
assert.equal(backfilled.shipped_qty,60);
await db.exec("set role authenticated");
await rpc("import",{rows:[line("NAME-ERP","SUMMARY",4,"2026-11-07",{customer:"ERP Name"}),line("NO-CATALOG","NAME-ONLY-ERP",1,"2026-11-08",{customer:"ERP Only"})]});
const named=(await get("NAME-ERP"))[0];
assert.equal(named.system_customer_name,"New Customer");
assert.equal(named.customer,"ERP Name");
assert.equal((await get("NO-CATALOG"))[0].system_customer_name,null,"Do not use an ERP name as the system name");
const namedList=(await db.query("select public.list_delivery(0,'NAME-ERP',false) as data")).rows[0].data;
assert.equal(namedList.rows[0].system_customer_name,"New Customer");
await db.exec("reset role; update public.item_pallet_config set customer='Renamed Customer' where itemcode='SUMMARY'");
assert.equal((await request(named.id)).system_customer_name,"Renamed Customer");
assert.equal((await request(named.id)).version,named.version,"A metadata refresh does not stale a shipping action");
await db.exec("update public.item_pallet_config set customer='' where itemcode='SUMMARY'");
assert.equal((await request(named.id)).system_customer_name,"Customer","Falls back to the latest named incoming lot");
assert.equal(Number((await summary("SUMMARY")).on_order_qty),4);
assert.equal(Number((await summary("SUMMARY")).balance_qty),30);
console.log("PASS: system customer backfill and synchronization, preserved ERP name, incoming fallback, no changes to shipping versions or quantities.");

await migrate("20261106100000_stock_fifo_overship.sql");
const item="FIFO-UNDATED";
const oldLot=Number((await seed(item,9,"2026-01-01")).rows[0].id);
await seed(item,5,"2026-01-01");
await seed(item,10,"2026-02-01");
const unknownFirst=Number((await seed(item,4,null)).rows[0].id);
const unknownSecond=Number((await seed(item,3,null)).rows[0].id);
const usedLot=Number((await seed(item,1,"2026-03-01")).rows[0].id);
await db.query("update public.inv_incoming set issued_qty=received_qty where id=$1",[usedLot]);
const breakdown=async code=>(await db.query("select public.list_stock_production_dates($1) as data",[code])).rows[0].data;
await db.exec("set role anon");
await assert.rejects(breakdown(item),/permission denied/);
await db.exec("set role authenticated; select set_config('test.permission','no',false)");
await assert.rejects(breakdown(item),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
assert.deepEqual(await breakdown(item),{balance_qty:31,rows:[
  {production_date:null,lot_count:2,balance_qty:7},
  {production_date:"2026-01-01",lot_count:2,balance_qty:14},
  {production_date:"2026-02-01",lot_count:1,balance_qty:10},
]});
assert.deepEqual(await breakdown("UNKNOWN-ITEM"),{balance_qty:0,rows:[]});
const overLine=line("OVERSHIP",item,8);
await rpc("import",{rows:[overLine,line("OTHER-ORDER",item,24,"2026-10-28")]});
const toShip=await request((await get("OVERSHIP"))[0].id);
const shipment={id:toShip.id,version:toShip.version,quantity:2,shipped_date:"2026-11-06"};
await rpc("ship",shipment);
shipment.version=(await request(toShip.id)).version;
shipment.quantity=30;
assert.equal((await fifo(toShip.id,30)).can_ship,false);
await assert.rejects(rpc("ship",shipment),/DELIVERY_INSUFFICIENT_STOCK/);
assert.equal((await request(toShip.id)).shipped_qty,2,"An insufficient-stock overage does not post");
shipment.quantity=10;
const suggested=await fifo(toShip.id,10);
assert.equal(suggested.can_ship,true);
assert.equal(suggested.remaining_qty,6);
const expectedLots=[[unknownFirst,2],[unknownSecond,3],[oldLot,5]];
assert.deepEqual(suggested.fifo.map(l=>[l.incoming_id,l.quantity]),expectedLots);
const overCommand=randomUUID();
assert.equal((await rpc("ship",shipment,overCommand)).shipped,10);
assert.equal((await rpc("ship",shipment,overCommand)).shipped,10,"Retry must not ship again");
const actualLots=await db.query("select incoming_id::int,quantity from public.inv_delivery_issue_lines where issue_id=$1",[overCommand]);
assert.deepEqual(actualLots.rows.map(l=>[l.incoming_id,l.quantity]).sort((a,b)=>a[0]-b[0]),[...expectedLots].sort((a,b)=>a[0]-b[0]));
const closedOver=(await db.query("select public.list_delivery(0,'OVERSHIP',true) as data")).rows[0].data.rows[0];
assert.deepEqual([closedOver.ordered_qty,closedOver.shipped_qty,closedOver.remaining_qty,closedOver.status],[8,12,0,"done"]);
assert.equal((await db.query("select public.list_delivery(0,'OVERSHIP',false) as data")).rows[0].data.total,0);
assert.deepEqual([...(await breakdown(item)).rows].map(l=>[l.production_date,l.balance_qty]),[["2026-01-01",9],["2026-02-01",10]]);
const afterOver=await summary(item);
assert.deepEqual([afterOver.balance_qty,afterOver.on_order_qty,afterOver.shortage_qty].map(Number),[19,24,5],"The extra quantity reduces physical stock without reducing another order's demand");
assert.equal((await fifo(toShip.id,1)).can_ship,false);
await assert.rejects(rpc("ship",{...shipment,version:closedOver.version,quantity:1}),/DELIVERY_DONE/);
await assert.rejects(rpc("cancel",{id:toShip.id,version:closedOver.version}),/DELIVERY_DONE/);
const overPreview=await rpc("preview",{rows:[overLine]});
assert.equal(overPreview.rows[0].item_on_order_after,24);
assert.equal(previewDeliveryDemand(overPreview.rows,{})[0].item_on_order_after,24);
assert.equal((await rpc("import",{rows:[overLine]})).skipped,1,"Reimporting an unchanged plan remains idempotent");
await rpc("edit",{id:toShip.id,version:closedOver.version,ordered_qty:8,delivery_date:"2026-11-07"});
assert.equal(Number((await summary(item)).on_order_qty),24);
console.log("PASS: undated-first stock groups and FIFO, overshipment with ledger and stock reconciliation, insufficient-stock rollback, and idempotent reimport.");

await db.exec("reset role");
await migrate("20261106110000_manual_delivery.sql");
const input=parseManualDeliveryInput({itemcode:" 11011*209 ",delivery_date:"2026-11-09",ordered_qty:8});
assert.equal(input.itemcode,"1101100000209");
assert.throws(()=>parseManualDeliveryInput({...input,delivery_date:"2026-02-30"}),/Ngày giao/);
assert.throws(()=>parseManualDeliveryInput({...input,ordered_qty:1.5}),/Số lượng/);
await seed(input.itemcode,10,"2026-09-01");
await db.query("insert into public.item_pallet_config(itemcode,product_name,customer) values ($1,'Catalog name','Catalog customer')",[input.itemcode]);
await db.exec("insert into public.pallet_data(id,itemcode,product_name,customer) values (10,'PALLET-MANUAL','Pallet name','Pallet customer'),(11,'NO-CUSTOMER','Product without customer',null)");
const lookupManual=async code=>(await db.query("select * from public.lookup_manual_delivery_item($1)",[code])).rows[0];
const postManual=async (payload,id=randomUUID())=>(await db.query("select public.post_manual_delivery($1,$2::jsonb) as result",[id,JSON.stringify(payload)])).rows[0].result;
await db.exec("set role anon");
await assert.rejects(lookupManual(input.itemcode),/permission denied/);
await assert.rejects(postManual(input),/permission denied/);
await db.exec("set role authenticated; select set_config('test.permission','no',false)");
await assert.rejects(postManual(input),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
assert.deepEqual(await lookupManual(input.itemcode),{product_name:"Catalog name",customer:"Catalog customer"});
assert.deepEqual(await lookupManual(item),{product_name:"Product",customer:"Customer"},"Opening/stock items work even without a catalog entry");
assert.deepEqual(await lookupManual("PALLET-MANUAL"),{product_name:"Pallet name",customer:"Pallet customer"});
assert.deepEqual(await lookupManual("NO-CUSTOMER"),{product_name:"Product without customer",customer:null});
assert.equal(await lookupManual("ITEM-MISSING"),undefined);
await assert.rejects(postManual({...input,itemcode:"ITEM-MISSING"}),/DELIVERY_ITEM_NOT_FOUND/);
await assert.rejects(postManual({...input,ordered_qty:1.5}),/DELIVERY_INVALID_QUANTITY/);
const manualCommand=randomUUID();
const result=await postManual(input,manualCommand);
assert.equal(result.request_id,manualCommand);
assert.deepEqual(await postManual(input,manualCommand),result);
await assert.rejects(postManual({...input,ordered_qty:9},manualCommand),/DELIVERY_COMMAND_CONFLICT/);
const manual=(await request(result.request_id));
assert.deepEqual([manual.delivery_source,manual.product_name,manual.system_customer_name,manual.ordered_qty,manual.created_by],
  ["manual","Catalog name","Catalog customer",8,actor]);
const manualSummary=await summary(input.itemcode);
assert.deepEqual([manualSummary.balance_qty,manualSummary.on_order_qty].map(Number),[10,8]);
const sameDate=await postManual({...input,ordered_qty:1});
assert.notEqual(sameDate.request_id,manual.id,"A deliberate new schedule is distinct from retrying the old one");
await rpc("import",{rows:[line("ERP-SAME-DAY",input.itemcode,2,input.delivery_date)]});
const manualQueue=(await db.query("select public.list_delivery(0,$1,false) as data",[input.itemcode])).rows[0].data.rows;
assert.equal(manualQueue.length,3);
assert.equal(manualQueue.filter(row=>row.delivery_source==="manual").length,2);
assert.equal(Number((await summary(input.itemcode)).shortage_qty),1);
const fallbackOrder=await postManual({...input,itemcode:"PALLET-MANUAL"});
assert.equal((await request(fallbackOrder.request_id)).system_customer_name,"Pallet customer");
await rpc("edit",{id:manual.id,version:manual.version,ordered_qty:7,delivery_date:"2026-11-10"});
const manualMoved=await request(manual.id);
assert.equal(manualMoved.delivery_source,"manual");
await rpc("ship",{id:manualMoved.id,version:manualMoved.version,quantity:7,shipped_date:"2026-11-10"});
const afterManualShip=await summary(input.itemcode);
assert.deepEqual([afterManualShip.balance_qty,afterManualShip.on_order_qty].map(Number),[3,3]);
console.log("PASS: manual delivery lookup, authorization, idempotency, coexistence with ERP, On order, and normal edit/ship flow.");

await db.exec("reset role");
await seed("SPLIT-PO",100,"2026-09-01");
await db.exec("set role authenticated");
await rpc("import",{rows:[line("SPLIT-A","SPLIT-PO",20,"2026-11-09")]});
const splitLines=[line("SPLIT-A","SPLIT-PO",45,"2026-11-10",{excel_row:6}),line("SPLIT-B","SPLIT-PO",50,"2026-11-10",{excel_row:7})];
const splitPreview=(await rpc("preview",{rows:splitLines})).rows;
assert.deepEqual(splitPreview.map(row=>row.item_shortage_after),[15,15],"Different PO/SO on the same day share one item shortage");
assert.deepEqual(previewDeliveryDemand(splitPreview,{6:"new",7:"new"}).map(row=>row.item_shortage_after),[15,15]);
const oldSchedule=splitPreview[0].candidates[0];
const movedPreview=previewDeliveryDemand(splitPreview,{6:oldSchedule.id,7:"new"});
assert.deepEqual(movedPreview.map(row=>row.item_shortage_after),[0,0],"Rescheduling replaces the old demand instead of counting it twice");
assert.equal(Number((await summary("SPLIT-PO")).on_order_qty),20,"Preview does not book the new demand");
await rpc("import",{rows:[{...splitLines[0],target_id:oldSchedule.id,expected_version:oldSchedule.version},splitLines[1]]});
assert.deepEqual([(await summary("SPLIT-PO")).on_order_qty,(await summary("SPLIT-PO")).shortage_qty].map(Number),[95,0]);
console.log("PASS: same-day split PO/SO demand is aggregated by item, with existing demand counted once when rescheduling.");

await db.exec("reset role");
await migrate("20261106120000_review_delivery_fifo.sql");
const reviewItem="REVIEW-MIXED";
await seed(reviewItem,10,"2026-01-01");
await seed(reviewItem,8,"2026-01-01");
await seed(reviewItem,50,"2026-02-01");
await seed(reviewItem,3,null);
await seed(reviewItem,4,null);
await db.query("insert into public.item_pallet_config(itemcode,product_name,customer) values ($1,'Review product','Review customer')",[reviewItem]);
const reviewFifo=async ids=>(await db.query("select public.review_delivery_fifo($1::uuid[]) as data",[ids])).rows[0].data;
await db.exec("set role anon");
await assert.rejects(reviewFifo([randomUUID()]),/permission denied/);
await db.exec("set role authenticated; select set_config('test.permission','no',false)");
await assert.rejects(reviewFifo([randomUUID()]),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
await assert.rejects(reviewFifo([]),/DELIVERY_INVALID_REVIEW/);
const reviewManual=await postManual({...input,itemcode:reviewItem,ordered_qty:15});
await rpc("import",{rows:[line("REVIEW-ERP",reviewItem,20,input.delivery_date),line("NOT-IN-REVIEW",reviewItem,1000,input.delivery_date),line("REVIEW-CANCEL",reviewItem,10,input.delivery_date)]});
const reviewErp=(await get("REVIEW-ERP"))[0], reviewCancel=(await get("REVIEW-CANCEL"))[0];
await rpc("ship",{id:reviewErp.id,version:reviewErp.version,quantity:5,shipped_date:input.delivery_date});
await rpc("cancel",{id:reviewCancel.id,version:reviewCancel.version});
const stockBeforeReview=await summary(reviewItem);
const reviewData=await reviewFifo([reviewManual.request_id,reviewErp.id,reviewErp.id,reviewCancel.id,manual.id,fallbackOrder.request_id]);
assert.equal(reviewData.request_count,3,"Ignore duplicated, canceled and completed requests");
assert.deepEqual(reviewData.rows,[
  {itemcode:"PALLET-MANUAL",product_name:"Pallet name",customer:"Pallet customer",quantity:8,shortage_qty:8,days:[]},
  {itemcode:reviewItem,product_name:"Review product",customer:"Review customer",quantity:30,shortage_qty:0,days:[
    {production_date:null,quantity:2},{production_date:"2026-01-01",quantity:18},{production_date:"2026-02-01",quantity:10},
  ]},
],"Use only selected requests, remaining quantities, and one FIFO allocation per item grouped by production date");
assert.deepEqual(await summary(reviewItem),stockBeforeReview,"Review neither allocates inventory nor changes demand");
console.log("PASS: selected-request FIFO review groups items/dates, subtracts prior shipments and excludes closed orders without writing stock.");

await db.exec("reset role");
await migrate("20261106130000_bulk_delivery_lots.sql");
const bulkItem="BULK-LOT";
const undatedId=String((await seed(bulkItem,6,null)).rows[0].id);
const oldId=String((await seed(bulkItem,12,"2026-01-01")).rows[0].id);
const newId=String((await seed(bulkItem,20,"2026-02-01")).rows[0].id);
await db.exec("set role authenticated");
await rpc("import",{rows:[line("BULK-LATE",bulkItem,10,"2026-11-10"),line("BULK-EARLY",bulkItem,8,"2026-11-09"),line("BULK-NOT-SELECTED",bulkItem,100,"2026-11-08")]});
const early=(await get("BULK-EARLY"))[0], late=(await get("BULK-LATE"))[0];
const bulkPreview=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[[late.id,early.id]])).rows[0].data;
assert.equal(bulkPreview.rows[0].quantity,18);
assert.deepEqual(bulkPreview.lots[bulkItem].map(l=>l.incoming_id),[undatedId,oldId,newId]);
const bulkPayload={shipped_date:"2026-11-11",requests:bulkPreview.requests.map(({id,version})=>({id,version})),
  lots:[{incoming_id:newId,quantity:7},{incoming_id:oldId,quantity:3}]};
const postBulk=async (payload,id=randomUUID())=>(await db.query("select public.post_bulk_delivery($1,$2::jsonb) as data",[id,JSON.stringify(payload)])).rows[0].data;
await db.exec("select set_config('test.permission','no',false)");
await assert.rejects(postBulk(bulkPayload),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
await assert.rejects(postBulk({...bulkPayload,requests:[{id:early.id,version:early.version+1}]}),/DELIVERY_STALE/);
await assert.rejects(postBulk({...bulkPayload,lots:[{incoming_id:newId,quantity:21}]}),/DELIVERY_INSUFFICIENT_STOCK/);
await assert.rejects(postBulk({...bulkPayload,lots:[{incoming_id:newId,quantity:19}]}),/DELIVERY_BULK_OVER_DEMAND/);
await assert.rejects(postBulk({...bulkPayload,lots:[bulkPayload.lots[0],bulkPayload.lots[0]]}),/DELIVERY_INVALID_BULK/);
assert.equal(Number((await summary(bulkItem)).balance_qty),38,"Rejected batches leave stock unchanged");
const bulkCommand=randomUUID();
assert.deepEqual(await postBulk(bulkPayload,bulkCommand),{shipped:10,request_count:2});
assert.deepEqual(await postBulk(bulkPayload,bulkCommand),{shipped:10,request_count:2});
await assert.rejects(postBulk({...bulkPayload,shipped_date:"2026-11-12"},bulkCommand),/DELIVERY_COMMAND_CONFLICT/);
assert.equal((await request(early.id)).shipped_qty,8);
assert.equal((await request(late.id)).shipped_qty,2);
assert.equal((await get("BULK-NOT-SELECTED"))[0].shipped_qty,0);
const bulkLedger=(await db.query(`select s.request_id,s.shipped_date::text as shipped_date,l.incoming_id::text,l.quantity
  from public.inv_delivery_issues s join public.inv_delivery_issue_lines l on l.issue_id=s.id
  where s.request_id=any($1::uuid[]) order by s.request_id,l.incoming_id`,[[early.id,late.id]])).rows;
assert.deepEqual(bulkLedger.filter(l=>l.request_id===early.id).map(l=>[l.incoming_id,l.quantity,l.shipped_date]),
  [[oldId,3,"2026-11-11"],[newId,5,"2026-11-11"]]);
assert.deepEqual(bulkLedger.filter(l=>l.request_id===late.id).map(l=>[l.incoming_id,l.quantity]),[[newId,2]]);
assert.equal(Number((await summary(bulkItem)).balance_qty),28);
assert.equal(Number((await summary(bulkItem)).on_order_qty),108);
assert.equal((await db.query("select balance_qty from public.inv_incoming where id=$1",[undatedId])).rows[0].balance_qty,6);
console.log("PASS: bulk shipment honors exact edited lots, posts partial orders in delivery order, and rejects stale/invalid batches without duplicate stock deduction.");

await db.exec("reset role");
await migrate("20261106140000_bulk_delivery_overship.sql");
const unselectedItem="BULK-UNCHECKED";
const unselectedLot=String((await seed(unselectedItem,30,null)).rows[0].id);
const maxLot=String((await seed("BULK-MAX",2147483647,null)).rows[0].id);
const oneLot=String((await seed("BULK-MAX",1,null)).rows[0].id);
await db.exec("set role authenticated");
assert.deepEqual(await postBulk(bulkPayload,bulkCommand),{shipped:10,request_count:2},"Migration preserves previously recorded command results");
await rpc("import",{rows:[line("BULK-EXTRA-LATE",bulkItem,2,"2026-11-12"),line("BULK-UNCHECKED",unselectedItem,3),line("BULK-MAX", "BULK-MAX",1)]});
const afterPartial=await request(late.id), extraLate=(await get("BULK-EXTRA-LATE"))[0];
const excessPayload={shipped_date:"2026-11-12",requests:[extraLate,afterPartial].map(({id,version})=>({id,version})),
  lots:[{incoming_id:oldId,quantity:4},{incoming_id:newId,quantity:10}]};
await assert.rejects(postBulk({...excessPayload,lots:[...excessPayload.lots,{incoming_id:unselectedLot,quantity:1}]}),/DELIVERY_BULK_LOT_MISMATCH/);
const maxOrder=(await get("BULK-MAX"))[0];
await assert.rejects(postBulk({shipped_date:excessPayload.shipped_date,requests:[{id:maxOrder.id,version:maxOrder.version}],
  lots:[{incoming_id:maxLot,quantity:2147483647},{incoming_id:oneLot,quantity:1}]}),/DELIVERY_BULK_QTY_LIMIT/);
assert.equal(Number((await summary("BULK-MAX")).balance_qty),2147483648);
const excessCommand=randomUUID();
assert.deepEqual(await postBulk(excessPayload,excessCommand),{shipped:14,request_count:2});
assert.deepEqual(await postBulk(excessPayload,excessCommand),{shipped:14,request_count:2});
const firstShipped=await request(late.id), lastShipped=await request(extraLate.id);
assert.deepEqual([firstShipped.ordered_qty,firstShipped.shipped_qty,lastShipped.ordered_qty,lastShipped.shipped_qty],[10,10,2,6]);
assert.equal((await get("BULK-NOT-SELECTED"))[0].shipped_qty,0,"Another request for the same item is outside this batch");
assert.equal((await get("BULK-UNCHECKED"))[0].shipped_qty,0);
assert.equal(Number((await summary(unselectedItem)).balance_qty),30);
assert.equal(Number((await summary(bulkItem)).balance_qty),14);
assert.equal(Number((await summary(bulkItem)).on_order_qty),100,"Excess is not deducted from other open orders");
console.log("PASS: bulk overshipment is allocated to the last selected request, preserves plans and unselected demand, and remains idempotent.");

const legacyManualId=randomUUID();
const undatedManual=[{itemcode:bulkItem,received_date:"2026-11-11",production_date:null,quantity:1,note:""}];
const postIncoming=async (id, rows)=>(await db.query("select * from public.post_manual_inventory($1,$2::jsonb)",[id,JSON.stringify(rows)])).rows;
const legacyPosted=await postIncoming(legacyManualId,undatedManual);
await db.exec("reset role");
await migrate("20261106150000_outgoing_receipt_history.sql");
await db.exec("set role authenticated");
assert.deepEqual(await postIncoming(legacyManualId,undatedManual),legacyPosted,"Already posted manual batches are safe to retry");
await assert.rejects(postIncoming(randomUUID(),undatedManual),/INV_PRODUCTION_DATE_REQUIRED/);
assert.equal((await postIncoming(randomUUID(),[{...undatedManual[0],production_date:"2026-11-01"}]))[0].row_count,1);

await rpc("import",{rows:[line("REVIEW-LATER",reviewItem,3,"2026-11-20")]});
const reviewLater=(await get("REVIEW-LATER"))[0];
const reviewDates=await reviewFifo([reviewLater.id,reviewManual.request_id,reviewErp.id]);
assert.deepEqual(reviewDates.rows[0].delivery_dates,[input.delivery_date,"2026-11-20"]);
const receipts=async (from,to)=>(await db.query("select public.list_outgoing_receipts($1,$2,0) as data",[from,to])).rows[0].data;
const receiptDetails=async (day,code)=>(await db.query("select public.outgoing_receipt_details($1,$2,0) as data",[day,code])).rows[0].data;
await db.exec("select set_config('test.permission','no',false)");
await assert.rejects(receipts(null,null),/DELIVERY_NOT_AUTHORIZED/);
await assert.rejects(receiptDetails("2026-11-12",bulkItem),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
const dayReceipt=await receipts("2026-11-12","2026-11-12");
assert.equal(dayReceipt.total,1);
assert.deepEqual(dayReceipt.rows[0],{shipped_date:"2026-11-12",itemcode:bulkItem,product_name:"Product",customer:"Customer",quantity:14,creator_name:"Test Operator"});
const twoDays=await receipts("2026-11-11","2026-11-12");
assert.deepEqual(twoDays.rows.filter(row=>row.itemcode===bulkItem).map(row=>[row.shipped_date,row.quantity]),[["2026-11-12",14],["2026-11-11",10]]);
assert.ok((await receipts(null,null)).rows.length<=10);
const receiptDetail=await receiptDetails("2026-11-12",bulkItem);
assert.equal(receiptDetail.total,2);
assert.deepEqual(receiptDetail.rows.map(row=>[row.purorder,row.sales_id,row.delivery_date,row.quantity]).sort(),[
  ["BULK-EXTRA-LATE","SO-BULK-EXTRA-LATE","2026-11-12",6],["BULK-LATE","SO-BULK-LATE","2026-11-10",8],
]);
assert.deepEqual(receiptDetail.rows.find(row=>row.request_id===late.id).lots.map(lot=>[lot.incoming_id,lot.quantity]),[[oldId,4],[newId,4]]);
console.log("PASS: required production date for new manual intake, valid retries, review delivery dates, and item/day shipment history with exact request and lot detail.");

await db.close();
console.log("PASS: merged parser, FIFO allocation, aggregate shortage, import/update dedupe, partial/done, cancellation, reschedule, units, rollback, access control and ledger consistency.");
