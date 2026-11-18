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
const { parseDeliverySheet, parseManualDeliveryInput, previewDeliveryDemand, deliveryPreviewErrors, selectDeliveryBuildUp, deliveryBuildUpSelection } = require("../../lib/warehouse-receipt/outgoing.ts");
const { analyzeDeliveryGroups, componentPickKey, suggestDeliveryGroups } = require("../../lib/warehouse-receipt/delivery-groups.ts");
const { expandMergedCells } = require("../../lib/excel-merged.ts");
const { parseWarehouseMasterData } = require("../../lib/warehouse-receipt/master-data.ts");
const { parseWarehouseItemBuildUp } = require("../../lib/warehouse-receipt/item-build-up.ts");

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

await db.exec("reset role");
await migrate("20261106160000_bulk_delivery_require_stock.sql");
const shortageLot=String((await seed("BULK-SHORT",10,null)).rows[0].id);
const enoughLot=String((await seed("BULK-ENOUGH",10,null)).rows[0].id);
await db.exec("set role authenticated");
assert.deepEqual(await postBulk(excessPayload,excessCommand),{shipped:14,request_count:2},"Previous commands remain retryable");
await rpc("import",{rows:[line("BULK-SHORT","BULK-SHORT",15),line("BULK-ENOUGH","BULK-ENOUGH",8)]});
const shortRequest=(await get("BULK-SHORT"))[0], enoughRequest=(await get("BULK-ENOUGH"))[0];
const blockedBatch={shipped_date:"2026-11-12",
  requests:[shortRequest,enoughRequest].map(({id,version})=>({id,version})),
  lots:[{incoming_id:shortageLot,quantity:3},{incoming_id:enoughLot,quantity:4}]};
await assert.rejects(postBulk(blockedBatch),/DELIVERY_BULK_SHORT_STOCK:BULK-SHORT/);
assert.equal(Number((await summary("BULK-ENOUGH")).balance_qty),10,"A selected shortage blocks all writes");
assert.deepEqual(await postBulk({...blockedBatch,requests:[blockedBatch.requests[1]],lots:[blockedBatch.lots[1]]}),
  {shipped:4,request_count:1},"Unchecked shortage doesn't block a partial lot choice on a fully stocked item");
assert.equal(Number((await summary("BULK-SHORT")).balance_qty),10);
assert.equal((await request(shortRequest.id)).shipped_qty,0);
console.log("PASS: bulk shipping rejects selected items short of total stock without blocking deliberate partial picks on adequately stocked items.");

const excelMasterRow=(code,name,weight)=>[code,name,null,null,null,weight];
const parsedMaster=parseWarehouseMasterData([
  [],excelMasterRow("Mã sản phẩm","Tên sản phẩm","Khối lượng (kg)"),
  excelMasterRow("00011","Tên ERP 1","1.234,5"),excelMasterRow("00011","Tên ERP 1",1234.5),
  excelMasterRow(123,"Tên ERP 2",null),
]);
assert.deepEqual(parsedMaster.rows,[
  {excel_row:3,itemcode:"00011",erp_name:"Tên ERP 1",netweight:1234.5},
  {excel_row:5,itemcode:"123",erp_name:"Tên ERP 2",netweight:null},
]);
assert.equal(parsedMaster.duplicateCount,1);
assert.equal(parseWarehouseMasterData([excelMasterRow("ITEM","Vật tư",0)]).rows[0].itemcode,"ITEM","A legitimate first data row is not a header");
assert.deepEqual(parseWarehouseMasterData([excelMasterRow("A1","Tên",1),excelMasterRow("A1","Tên khác",1),excelMasterRow("A2","Tên",-1)]).errors.map(x=>x.row),[2,3]);

await db.exec("reset role");
await migrate("20261112100000_warehouse_master_data.sql");
await db.exec("insert into public.item_pallet_config(itemcode,product_name,customer,quantity_per_pallet,netweight) values ('00011','Tên hệ thống','Khách cũ',24,10)");
const masterRows=parsedMaster.rows.map(({itemcode,erp_name,netweight})=>({itemcode,erp_name,netweight}));
const syncMaster=async (rows,preview)=>(await db.query("select public.sync_warehouse_master_data($1::jsonb,$2) as data",[JSON.stringify(rows),preview])).rows[0].data;
const catalog=async code=>(await db.query('select product_name,customer,quantity_per_pallet,"ERP_name" as erp_name,netweight::text from public.item_pallet_config where itemcode=$1',[code])).rows[0];
const masterOperator=randomUUID();
await db.query("insert into public.profiles(id,is_active,role,full_name,username) values ($1,true,'admin','Warehouse Admin','whadmin')",[masterOperator]);
await db.exec("set role authenticated");
await db.query("select set_config('test.actor',$1,false)",[masterOperator]);
await assert.rejects(syncMaster(masterRows,true),/MASTER_DATA_NOT_AUTHORIZED/);
await assert.rejects(syncMaster(masterRows,false),/MASTER_DATA_NOT_AUTHORIZED/);
await db.query("select set_config('test.actor',$1,false)",[actor]);
assert.deepEqual(await syncMaster(masterRows,true),{inserted:1,updated:1,unchanged:0});
await db.exec("reset role");
assert.equal(await catalog("123"),undefined,"Preview does not change the catalog");
assert.equal((await catalog("00011")).erp_name,null);
await db.exec("set role authenticated");
await assert.rejects(syncMaster([...masterRows,{itemcode:"DUP",erp_name:"Tên",netweight:-1}],false),/MASTER_DATA_INVALID_ROW/);
await assert.rejects(syncMaster([masterRows[0],masterRows[0]],false),/MASTER_DATA_DUPLICATE_ITEM/);
assert.deepEqual(await syncMaster(masterRows,false),{inserted:1,updated:1,unchanged:0});
assert.deepEqual(await syncMaster(masterRows,false),{inserted:0,updated:0,unchanged:2});
assert.deepEqual(await syncMaster([{itemcode:"00011",erp_name:"Tên ERP sửa",netweight:null}],false),{inserted:0,updated:1,unchanged:0});
await db.exec("reset role");
assert.deepEqual(await catalog("00011"),{product_name:"Tên hệ thống",customer:"Khách cũ",quantity_per_pallet:24,erp_name:"Tên ERP sửa",netweight:"1234.5"});
assert.deepEqual(await catalog("123"),{product_name:"Tên ERP 2",customer:null,quantity_per_pallet:null,erp_name:"Tên ERP 2",netweight:null});
assert.equal(await summary("123"),undefined,"Catalog-only imports do not create zero stock rows");
console.log("PASS: master data validates Excel columns and duplicates, restricts access, previews without writes and syncs catalog fields idempotently.");

const buildUpExcelRow=(a,c,e,g)=>[a,"Tên mẹ",c,"Tên con 1",e,"Tên con 2",g,"Tên con 3"];
const buildUp=parseWarehouseItemBuildUp([
  [],buildUpExcelRow("Code mẹ","Code con 1","Code con 2","Code con 3"),
  buildUpExcelRow("0001",210001,"0002",null),
  buildUpExcelRow("0001","210001","0002",null),
  buildUpExcelRow("0001","210005",null,"0003"),
]);
assert.deepEqual(buildUp.rows,[
  {excel_row:3,parent_itemcode:"0001",child_itemcode_1:"210001",child_itemcode_2:"0002",child_itemcode_3:null},
  {excel_row:5,parent_itemcode:"0001",child_itemcode_1:"210005",child_itemcode_2:null,child_itemcode_3:"0003"},
]);
assert.equal(buildUp.duplicateCount,1);
assert.deepEqual(parseWarehouseItemBuildUp([buildUpExcelRow("A",null,null,null),buildUpExcelRow(null,"C",null,null),buildUpExcelRow("A","C",4.5,null)]).errors.map(x=>x.row),[1,2,3]);

await migrate("20261112110000_warehouse_item_build_up.sql");
const recipes=buildUp.rows.map(({ parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3 })=>
  ({ parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3 }));
const syncBuildUp=async (rows,preview)=>(await db.query("select public.sync_warehouse_item_build_up($1::jsonb,$2) as data",[JSON.stringify(rows),preview])).rows[0].data;
await db.exec("set role authenticated");
await db.query("select set_config('test.actor',$1,false)",[masterOperator]);
await assert.rejects(syncBuildUp(recipes,true),/ITEM_BUILD_UP_NOT_AUTHORIZED/);
await assert.rejects(syncBuildUp(recipes,false),/ITEM_BUILD_UP_NOT_AUTHORIZED/);
await assert.rejects(db.exec("select * from public.item_build_up"),/permission denied/);
await db.query("select set_config('test.actor',$1,false)",[actor]);
assert.deepEqual(await syncBuildUp(recipes,true),{inserted:2,unchanged:0});
await db.exec("reset role");
assert.equal((await db.query("select count(*)::int as count from public.item_build_up")).rows[0].count,0);
await db.exec("set role authenticated");
await assert.rejects(syncBuildUp([recipes[0],{parent_itemcode:"0003",child_itemcode_1:12}],false),/ITEM_BUILD_UP_INVALID_ROW/);
await assert.rejects(syncBuildUp([recipes[0],recipes[0]],false),/ITEM_BUILD_UP_DUPLICATE_ROW/);
assert.deepEqual(await syncBuildUp(recipes,false),{inserted:2,unchanged:0});
assert.deepEqual(await syncBuildUp(recipes,false),{inserted:0,unchanged:2});
assert.deepEqual(await syncBuildUp([recipes[0],{...recipes[1],child_itemcode_3:"0004"}],false),{inserted:1,unchanged:1});
await db.exec("reset role");
assert.deepEqual((await db.query("select parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3,created_by from public.item_build_up order by id")).rows,
  [...recipes,{...recipes[1],child_itemcode_3:"0004"}].map(recipe=>({...recipe,created_by:actor})));
console.log("PASS: build-up reads A/C/E/G, preserves child positions and alternative recipes, and restricts idempotent writes to Super Admin.");

await migrate("20261112120000_warehouse_catalog_editors.sql");
await db.exec("insert into public.item_pallet_config(itemcode,customer) values ('OTHER-CUSTOMER-CODE',' Khách cũ '),('EMPTY-CUSTOMER',' ')");
const editCatalog=async (action,payload={})=>(await db.query("select public.warehouse_catalog_admin($1,$2::jsonb) as data",[action,JSON.stringify(payload)])).rows[0].data;
await db.exec("set role authenticated");
await db.query("select set_config('test.actor',$1,false)",[masterOperator]);
await assert.rejects(editCatalog("customers"),/WAREHOUSE_CATALOG_FORBIDDEN/);
await assert.rejects(editCatalog("save_item",{itemcode:"A",product_name:"Tên"}),/WAREHOUSE_CATALOG_FORBIDDEN/);
await db.query("select set_config('test.actor',$1,false)",[actor]);
const listedCustomers=(await editCatalog("customers")).customers;
assert.equal(listedCustomers.filter(name=>name==="Khách cũ").length,1);
assert.ok(listedCustomers.every(name=>name.trim()===name && name.length));
await assert.rejects(editCatalog("save_item",{itemcode:"A",product_name:" "}),/WAREHOUSE_CATALOG_INVALID/);
await assert.rejects(editCatalog("save_item",{itemcode:"A",product_name:"Tên",customer:"Chưa tồn tại"}),/WAREHOUSE_CATALOG_UNKNOWN_CUSTOMER/);
await editCatalog("save_item",{itemcode:"00011",product_name:"Tên chỉnh tay",customer:"Khách cũ"});
await editCatalog("save_item",{itemcode:"NEW-CATALOG",product_name:"Tên mới",customer:null});
assert.equal((await editCatalog("lookup",{itemcode:"NEW-CATALOG"})).catalog.product_name,"Tên mới");

const existingBuild=(await editCatalog("lookup",{itemcode:"0001",recipes:true}));
assert.equal(existingBuild.catalog,null);
assert.equal(existingBuild.recipes.length,3);
const recipe=existingBuild.recipes[0];
const changeBuild={itemcode:"0001",product_name:"Tên mã mẹ",children:["NEW-CATALOG",null,"0004"]};
await assert.rejects(editCatalog("save_build_up",changeBuild),/WAREHOUSE_CATALOG_CONFIRM_REPLACEMENT/);
await assert.rejects(editCatalog("save_build_up",{...changeBuild,replace_id:recipe.id,expected_children:[null,null,"MISMATCH"]}),/WAREHOUSE_CATALOG_STALE_RECIPE/);
await assert.rejects(editCatalog("save_build_up",{...changeBuild,children:existingBuild.recipes[1].children,
  replace_id:recipe.id,expected_children:recipe.children}),/WAREHOUSE_CATALOG_DUPLICATE_RECIPE/);
assert.equal((await editCatalog("lookup",{itemcode:"0001"})).catalog,null,"Rejected replacement does not create a catalog item");
const replacementResult=await editCatalog("save_build_up",{...changeBuild,replace_id:recipe.id,expected_children:recipe.children});
assert.equal(replacementResult.replaced,true);
const afterEdit=await editCatalog("lookup",{itemcode:"0001",recipes:true});
assert.equal(afterEdit.catalog.product_name,"Tên mã mẹ");
assert.deepEqual(afterEdit.recipes,[{id:recipe.id,children:changeBuild.children},...existingBuild.recipes.slice(1)]);
await assert.rejects(editCatalog("save_build_up",{itemcode:"NEW-PARENT",children:["C1",null,null]}),/WAREHOUSE_CATALOG_NAME_REQUIRED/);
assert.equal((await editCatalog("save_build_up",{itemcode:"NEW-PARENT",product_name:"Mã mẹ mới",children:["C1",null,null]})).replaced,false);
assert.equal((await editCatalog("lookup",{itemcode:"NEW-PARENT"})).catalog.product_name,"Mã mẹ mới");
await db.exec("reset role");
assert.deepEqual(await catalog("00011"),{product_name:"Tên chỉnh tay",customer:"Khách cũ",quantity_per_pallet:24,erp_name:"Tên ERP sửa",netweight:"1234.5"});
console.log("PASS: catalog editors validate required names and customer choices, preserve ERP metadata, and replace only the confirmed, current recipe.");

await migrate("20261116100000_warehouse_catalog_link_existing_items.sql");
await db.exec(`insert into public.item_pallet_config(itemcode,product_name,"ERP_name") values
  ('ERP-ONLY-PARENT',' ','ERP mẹ'),('ERP-ONLY-CHILD',null,'ERP con'),('NO-CATALOG-NAME',' ',null)`);
const manageCatalog=async (action,payload)=>(await db.query("select public.warehouse_catalog_manage($1,$2::jsonb) as data",[action,JSON.stringify(payload)])).rows[0].data;
await db.exec("set role authenticated");
await assert.rejects(editCatalog("save_build_up",{itemcode:"OLD-RPC",product_name:"Tên",children:["NEW-CATALOG",null,null]}),/permission denied/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"MISSING-PARENT",product_name:"Tên không được tạo",children:["NEW-CATALOG",null,null]}),/WAREHOUSE_CATALOG_UNKNOWN_ITEM:MISSING-PARENT/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"ERP-ONLY-PARENT",children:[null,"MISSING-CHILD",null]}),/WAREHOUSE_CATALOG_UNKNOWN_ITEM:MISSING-CHILD/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"ERP-ONLY-PARENT",children:[null,"NO-CATALOG-NAME",null]}),/WAREHOUSE_CATALOG_ITEM_WITHOUT_NAME:NO-CATALOG-NAME/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"NO-CATALOG-NAME",children:["ERP-ONLY-CHILD",null,null]}),/WAREHOUSE_CATALOG_ITEM_WITHOUT_NAME:NO-CATALOG-NAME/);
assert.equal((await manageCatalog("save_build_up",{itemcode:"ERP-ONLY-PARENT",children:[null,"ERP-ONLY-CHILD","NEW-CATALOG"]})).replaced,false);
assert.equal((await manageCatalog("lookup",{itemcode:"MISSING-PARENT"})).catalog,null);
const linked=await manageCatalog("lookup",{itemcode:"ERP-ONLY-PARENT",recipes:true});
assert.deepEqual(linked.catalog,{product_name:null,erp_name:"ERP mẹ",customer:null,netweight:null});
assert.deepEqual(linked.recipes[0].children,[null,"ERP-ONLY-CHILD","NEW-CATALOG"]);
await assert.rejects(manageCatalog("save_item",{itemcode:"00011",product_name:"Tên",netweight:-1}),/WAREHOUSE_CATALOG_INVALID/);
await manageCatalog("save_item",{itemcode:"00011",product_name:"Tên sản xuất",customer:"Khách cũ",erp_name:"ERP cập nhật",netweight:2.75});
assert.deepEqual((await manageCatalog("lookup",{itemcode:"00011"})).catalog,{product_name:"Tên sản xuất",erp_name:"ERP cập nhật",customer:"Khách cũ",netweight:2.75});
await manageCatalog("save_item",{itemcode:"00011",product_name:"Tên sản xuất đổi",customer:"Khách cũ"});
assert.equal((await manageCatalog("lookup",{itemcode:"00011"})).catalog.netweight,2.75);
await manageCatalog("save_item",{itemcode:"00011",product_name:"Tên sản xuất đổi",customer:"Khách cũ",erp_name:null,netweight:null});
await db.exec("reset role");
assert.deepEqual(await catalog("00011"),{product_name:"Tên sản xuất đổi",customer:"Khách cũ",quantity_per_pallet:24,erp_name:null,netweight:null});
assert.equal((await catalog("ERP-ONLY-PARENT")).product_name," ","Build-up linking does not fill production names");
console.log("PASS: build-up links only existing named items; ERP-only names qualify and optional ERP metadata can be edited or cleared.");

const originalRequest=(await get("P1"))[0];
await migrate("20261116110000_delivery_build_up.sql");
assert.equal((await request(originalRequest.id)).request_type,"origin");
assert.equal((await request(originalRequest.id)).parent_request_id,null);
await db.exec(`insert into public.item_pallet_config(itemcode,product_name,customer,"ERP_name") values
  ('BOM-KIT','Hàng mẹ','Khách ráp bộ',null),('BOM-CHILD-A','Hàng con A','Khách linh kiện',null),
  ('BOM-CHILD-B',null,null,'Hàng con B từ ERP');
  insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3) values
  ('BOM-KIT','BOM-CHILD-A','BOM-CHILD-A','BOM-CHILD-B'),
  ('BOM-OTHER','BOM-CHILD-A',null,null),('BOM-OTHER',null,'BOM-CHILD-B',null)`);
const undatedBomLot=(await seed("BOM-CHILD-A",4,null)).rows[0].id;
await seed("BOM-CHILD-A",7,"2026-09-01");
await seed("BOM-CHILD-B",20,"2026-10-01");
const lookupBuild=async item=>(await db.query("select public.lookup_delivery_build_up($1) as data",[item])).rows[0].data;
const buildRows=async (id)=>(await db.query("select * from public.inv_delivery_requests where parent_request_id=$1 order by itemcode",[id])).rows.map(normalizeDate);
await assert.rejects(db.exec("set role anon; select public.lookup_delivery_build_up('BOM-KIT')"),/permission denied/);
await db.exec("set role authenticated");
const buildItem=await lookupBuild("BOM-KIT");
assert.equal(buildItem.product_name,"Hàng mẹ");
const buildOption=buildItem.build_up_options[0];
assert.deepEqual(buildOption.components.map(c=>[c.itemcode,c.factor,c.item_stock_qty]),[["BOM-CHILD-A",2,11],["BOM-CHILD-B",1,20]]);
assert.equal(parseManualDeliveryInput({...input,build_up_token:buildOption.token}).build_up_token,buildOption.token);
await assert.rejects(postManual({...input,itemcode:"BOM-KIT",build_up_token:null}),/DELIVERY_BUILD_UP_CHANGED:BOM-KIT/);
assert.equal((await lookupBuild("BOM-OTHER")).build_up_options.length,2);
await assert.rejects(postManual({...input,itemcode:"BOM-OTHER",ordered_qty:1}),/DELIVERY_BUILD_UP_CHOOSE:BOM-OTHER/);
const manualKitPayload={...input,itemcode:"BOM-KIT",ordered_qty:2,build_up_token:buildOption.token};
const manualKitCommand=randomUUID();
const manualKit=(await postManual(manualKitPayload,manualKitCommand)).request_id;
assert.equal((await postManual(manualKitPayload,manualKitCommand)).request_id,manualKit);
assert.equal((await request(manualKit)).request_type,"parent");
const manualParts=await buildRows(manualKit);
assert.deepEqual(manualParts.map(r=>[r.request_type,r.itemcode,r.ordered_qty,r.delivery_source,r.product_name,r.customer]),[
  ["child","BOM-CHILD-A",4,"manual","Hàng con A","Khách ráp bộ"],
  ["child","BOM-CHILD-B",2,"manual","Hàng con B từ ERP","Khách ráp bộ"],
]);
assert.equal((await summary("BOM-KIT"))?.on_order_qty ?? 0,0);
assert.equal((await summary("BOM-CHILD-A")).on_order_qty,4);
const bomQueue=(await db.query("select public.list_delivery(0,'BOM-KIT',false) as data")).rows[0].data;
assert.deepEqual(bomQueue.rows.map(r=>[r.request_type,r.parent_itemcode,r.system_customer_name]),[
  ["child","BOM-KIT","Khách ráp bộ"],["child","BOM-KIT","Khách ráp bộ"]]);
assert.deepEqual((await reviewFifo([manualKit,...manualParts.map(r=>r.id)])).rows.map(r=>[r.itemcode,r.quantity]),[
  ["BOM-CHILD-A",4],["BOM-CHILD-B",2]]);
assert.equal(String((await fifo(manualParts[0].id,4)).fifo[0].incoming_id),String(undatedBomLot));
await assert.rejects(fifo(manualKit,1),/DELIVERY_INVALID|DELIVERY_SHIP_CHILDREN_ONLY/);
await assert.rejects(rpc("ship",{id:manualKit,version:(await request(manualKit)).version,quantity:1,shipped_date:"2026-11-16"}),/DELIVERY_SHIP_CHILDREN_ONLY/);

const erpKitLine=line("BOM-ERP","BOM-KIT",4,"2026-11-17",{excel_row:1});
const erpDirect=line("BOM-ERP","BOM-CHILD-A",2,"2026-11-17",{excel_row:2});
const erpOther=line("BOM-ERP","BOM-OTHER",1,"2026-11-17",{excel_row:3});
const bomPreview=await rpc("preview",{rows:[erpDirect,erpKitLine,erpOther]});
assert.equal(bomPreview.build_up_version,1);
assert.deepEqual(bomPreview.rows.map(r=>r.excel_row),[1,2,3]);
const otherOption=bomPreview.rows[2].build_up_options.find(o=>o.codes.includes("BOM-CHILD-A"));
const bomChoices={1:"new",2:"new",3:"new"};
const reviewBom=previewDeliveryDemand(bomPreview.rows,bomChoices,{3:otherOption.token});
assert.deepEqual(reviewBom.map(r=>r.item_shortage_after),[4,4,4],"Same component aggregated across manual, direct and two ERP parents");
assert.equal(previewDeliveryDemand(bomPreview.rows,bomChoices)[2].preview_components.length,0);
await assert.rejects(rpc("import",{rows:[erpOther]}),/DELIVERY_BUILD_UP_CHOOSE:BOM-OTHER/);
const erpBomPayload={rows:[{...erpKitLine,build_up_token:buildOption.token}, {...erpDirect,build_up_token:null}, {...erpOther,build_up_token:otherOption.token}]};
assert.equal((await rpc("import",erpBomPayload)).changed,3);
assert.equal((await rpc("import",erpBomPayload)).skipped,3);
const allErpBom=await get("BOM-ERP");
assert.equal(allErpBom.length,6);
assert.equal(allErpBom.filter(r=>r.itemcode==="BOM-CHILD-A").length,3);
assert.equal(allErpBom.find(r=>r.request_type==="origin").parent_request_id,null);
const erpParent=allErpBom.find(r=>r.itemcode==="BOM-KIT");

const bulkBuild=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[[manualKit,manualParts[0].id]])).rows[0].data;
assert.deepEqual(bulkBuild.requests.map(r=>r.id),[manualParts[0].id]);
const shipBuild={shipped_date:"2026-11-16",requests:bulkBuild.requests.map(({id,version})=>({id,version})),
  lots:[{incoming_id:String(undatedBomLot),quantity:4}]};
await assert.rejects(postBulk({...shipBuild,requests:[{id:manualKit,version:1}]}),/DELIVERY_STALE/);
assert.equal((await postBulk(shipBuild)).shipped,4);
assert.equal((await request(manualParts[0].id)).shipped_qty,4);
assert.equal((await request(manualKit)).shipped_qty,0);
assert.equal((await summary("BOM-CHILD-A")).balance_qty,7);

await db.exec("reset role; update public.item_build_up set child_itemcode_2=null where parent_itemcode='BOM-KIT'; set role authenticated");
await assert.rejects(postManual(manualKitPayload),/DELIVERY_BUILD_UP_CHANGED:BOM-KIT/);
const moveKit={...erpKitLine,delivery_date:"2026-11-18",ordered_qty:3, mode:"update",target_id:erpParent.id,expected_version:erpParent.version};
const moveKitPreview=(await rpc("preview",{rows:[moveKit]})).rows;
assert.deepEqual(previewDeliveryDemand(moveKitPreview,{1:erpParent.id})[0].preview_components.map(c=>c.requested_qty),[6,3]);
await rpc("import",{rows:[moveKit]});
assert.deepEqual((await buildRows(erpParent.id)).map(r=>[r.ordered_qty,r.delivery_date]),[[6,"2026-11-18"],[3,"2026-11-18"]]);
assert.equal((await summary("BOM-CHILD-A")).on_order_qty,9);
console.log("PASS: manual/ERP build-up, aggregate component shortage, source dedupe, stored recipes, child inventory and bulk FIFO.");

// The follow-up migration must repair old parent-inherited identities as well as new requests.
await db.exec("reset role");
const beforeIdentity=(await request(manualParts[0].id));
await migrate("20261118090000_delivery_component_identity.sql");
const repaired=await request(manualParts[0].id);
assert.equal(repaired.customer,"Khách linh kiện");
assert.equal(repaired.system_customer_name,"Khách linh kiện");
assert.equal(repaired.version,beforeIdentity.version);
assert.equal(repaired.shipped_qty,beforeIdentity.shipped_qty);
assert.equal(repaired.ordered_qty,beforeIdentity.ordered_qty);
await db.exec(`update public.item_pallet_config set customer='Khách con B riêng' where itemcode='BOM-CHILD-B';
  insert into public.item_pallet_config(itemcode,product_name,customer,"ERP_name") values
    ('BOM-NO-CUSTOMER','Con chưa có khách',null,null);
  insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3) values
    ('BOM-IDENTITY','BOM-CHILD-A','BOM-CHILD-B','BOM-NO-CUSTOMER')`);
await db.exec("set role authenticated");
const identityOption=(await lookupBuild("BOM-IDENTITY")).build_up_options[0];
const expectedIdentities=[
  ["BOM-CHILD-A","Hàng con A","Khách linh kiện"],
  ["BOM-CHILD-B","Hàng con B từ ERP","Khách con B riêng"],
  ["BOM-NO-CUSTOMER","Con chưa có khách",null],
];
assert.deepEqual(identityOption.components.map(c=>[c.itemcode,c.product_name,c.customer]),expectedIdentities);
const mixedManualPayload={...input,itemcode:"BOM-IDENTITY",ordered_qty:1,build_up_token:identityOption.token};
const mixedManual=await postManual(mixedManualPayload);
const mixedChildren=await buildRows(mixedManual.request_id);
assert.deepEqual(mixedChildren.map(c=>[c.itemcode,c.product_name,c.system_customer_name]),expectedIdentities);
assert.deepEqual(mixedChildren.map(c=>c.customer),["Khách linh kiện","Khách con B riêng",""]);
const mixedErpLine=line("BOM-MIXED-IDENTITY","BOM-IDENTITY",1,"2026-11-18",
  {customer:"Khách ERP mã mẹ",build_up_token:identityOption.token});
const identityPreview=await rpc("preview",{rows:[mixedErpLine]});
assert.deepEqual(previewDeliveryDemand(identityPreview.rows,{12:"new"})[0].preview_components.map(c=>
  [c.itemcode,c.product_name,c.customer]),expectedIdentities);
await rpc("import",{rows:[mixedErpLine]});
const mixedErpParent=(await get("BOM-MIXED-IDENTITY")).find(r=>r.request_type==="parent");
const mixedErpChildren=await buildRows(mixedErpParent.id);
assert.deepEqual(mixedErpChildren.map(c=>[c.itemcode,c.product_name,c.system_customer_name]),expectedIdentities);
assert.deepEqual(mixedErpChildren.map(c=>c.customer),["Khách linh kiện","Khách con B riêng",""]);
const mixedQueue=(await db.query("select public.list_delivery(0,'BOM-IDENTITY',false) as data")).rows[0].data.rows;
assert.equal(mixedQueue.length,6);
assert.ok(mixedQueue.every(r=>r.system_customer_name===expectedIdentities.find(c=>c[0]===r.itemcode)[2]));
const mixedReview=await reviewFifo(mixedErpChildren.map(c=>c.id));
assert.deepEqual(mixedReview.rows.map(r=>[r.itemcode,r.customer]),expectedIdentities.map(([code,,customer])=>[code,customer]));
const mixedSaved=(await rpc("preview",{rows:[mixedErpLine]})).rows[0].existing.components;
assert.deepEqual(mixedSaved.map(c=>[c.itemcode,c.product_name,c.customer]),expectedIdentities);
await db.exec("reset role; update public.item_pallet_config set customer='Khách con A mới' where itemcode='BOM-CHILD-A'; set role authenticated");
assert.equal((await request(mixedErpChildren[0].id)).system_customer_name,"Khách con A mới");
assert.equal((await request(mixedManual.request_id)).request_type,"parent");
assert.equal((await request(originalRequest.id)).request_type,"origin");
console.log("PASS: child-specific names/customers in manual and ERP preview, posting, queue, review, catalog refresh and migration repair; mixed or absent customers accepted.");


await db.exec("reset role");
await migrate("20261118100000_parent_delivery_workflow.sql");
await db.exec(`insert into public.item_pallet_config(itemcode,product_name,customer) values
 ('GROUP-P','Bộ mẹ','Khách mẹ'),('GROUP-A','Con A','Khách A'),('GROUP-B','Con B','Khách B');
 insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3) values
 ('GROUP-P','GROUP-A','GROUP-A','GROUP-B')`);
const groupLotA=(await seed("GROUP-A",40,null)).rows[0].id;
const groupLotB=(await seed("GROUP-B",20,"2026-10-01")).rows[0].id;
await db.exec("set role authenticated");
await rpc("import",{rows:[line("GROUP-SO1","GROUP-P",3,"2026-11-18"),line("GROUP-SO2","GROUP-P",2,"2026-11-18")]});
const groupSources=(await db.query("select id from public.inv_delivery_requests where itemcode='GROUP-P' order by purorder")).rows.map(r=>r.id);
const groupPreview=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[groupSources])).rows[0].data;
assert.equal(groupPreview.group_model_version,1);
assert.equal(groupPreview.request_count,2);
assert.equal(groupPreview.rows.length,1);
assert.equal(groupPreview.rows[0].quantity,5);
const groupKey=groupPreview.rows[0].group_key;
const allGroupKeys=new Set([groupKey]);
const initialPicks=suggestDeliveryGroups(groupPreview,allGroupKeys);
assert.equal(analyzeDeliveryGroups(groupPreview,initialPicks,allGroupKeys).canProceed,true);
const changedPicks=new Map(initialPicks).set(componentPickKey(groupPreview.rows[0],"GROUP-A"),{[String(groupLotA)]:9});
assert.equal(analyzeDeliveryGroups(groupPreview,changedPicks,allGroupKeys).canProceed,false);
const groupPayload={group_model_version:1,shipped_date:"2026-11-18",requests:groupPreview.requests.map(({id,version,components})=>({id,version,components})),
 lots:[{group_key:groupKey,incoming_id:String(groupLotA),quantity:6},{group_key:groupKey,incoming_id:String(groupLotB),quantity:3}]};
await assert.rejects(postBulk({...groupPayload,requests:groupPayload.requests.map(r=>({...r,components:[]}))}),/DELIVERY_STALE/);
await assert.rejects(postBulk({...groupPayload,lots:groupPayload.lots.map(l=>({...l,group_key:groupKey.replace("parent:","origin:")}))}),/DELIVERY_BULK_LOT_MISMATCH/);
await assert.rejects(postBulk({...groupPayload,lots:[{...groupPayload.lots[0],quantity:5},groupPayload.lots[1]]}),/DELIVERY_COMPONENT_QTY_MISMATCH/);
await assert.rejects(postBulk({...groupPayload,lots:[groupPayload.lots[0]]}),/DELIVERY_COMPONENT_QTY_MISMATCH/);
const groupCommand=randomUUID();
assert.equal((await postBulk(groupPayload,groupCommand)).shipped,3);
assert.equal((await postBulk(groupPayload,groupCommand)).shipped,3);
const afterGroup=(await db.query("select public.list_delivery(0,'GROUP-P',true) as data")).rows[0].data;
assert.equal(afterGroup.rows.length,2);
assert.ok(afterGroup.rows.every(r=>r.request_type==="parent" && !r.sync_error));
assert.equal(afterGroup.rows.reduce((sum,r)=>sum+r.shipped_qty,0),3);
assert.equal(afterGroup.rows.filter(r=>r.remaining_qty===0).length,1);
for(const source of afterGroup.rows) {
  const children=await buildRows(source.id);
  assert.deepEqual(children.map(c=>c.shipped_qty/(c.ordered_qty/source.ordered_qty)),[source.shipped_qty,source.shipped_qty]);
}
assert.equal((await summary("GROUP-A")).balance_qty,34);
await assert.rejects(postBulk(groupPayload),/DELIVERY_STALE/);
const doneParent=afterGroup.rows.find(r=>r.remaining_qty===0);
const parentDetails=(await db.query("select public.delivery_request_details($1) as data",[doneParent.id])).rows[0].data;
assert.equal(parentDetails.history.length,2);
assert.deepEqual(parentDetails.history.map(h=>h.itemcode).sort(),["GROUP-A","GROUP-B"]);
assert.ok(parentDetails.history.every(h=>h.inv_delivery_issue_lines.length>0));
const someChild=(await buildRows(groupSources[0]))[0];
await assert.rejects(rpc("ship",{id:someChild.id,version:someChild.version,quantity:1,shipped_date:"2026-11-18"}),/DELIVERY_SELECT_PARENT/);
await assert.rejects(rpc("cancel",{id:someChild.id,version:someChild.version}),/DELIVERY_SELECT_PARENT/);
await assert.rejects(postBulk({shipped_date:"2026-11-18",requests:[{id:someChild.id,version:someChild.version}],lots:[{incoming_id:String(groupLotA),quantity:1}]}),/DELIVERY_SELECT_PARENT/);
await assert.rejects(db.query("select public.manage_delivery_components_v1('reserve',$1,'{}')",[randomUUID()]),/permission denied/);
await assert.rejects(db.query("select public.post_bulk_delivery_components_v1($1,'{}')",[randomUUID()]),/permission denied/);
// A synchronized excess is assigned to one source SO across all its children.
const liveSources=afterGroup.rows.filter(r=>r.remaining_qty>0).map(r=>r.id);
const overGroup=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[liveSources])).rows[0].data;
const overGroupPayload={group_model_version:1,shipped_date:"2026-11-18",
 requests:overGroup.requests.map(({id,version,components})=>({id,version,components})),
 lots:[{group_key:groupKey,incoming_id:String(groupLotA),quantity:8},{group_key:groupKey,incoming_id:String(groupLotB),quantity:4}]};
const beforeOverChildren=await buildRows(liveSources[0]);
await postBulk(overGroupPayload);
const overGroupChildren=await buildRows(liveSources[0]);
assert.deepEqual(overGroupChildren.map((c,i)=>c.shipped_qty-beforeOverChildren[i].shipped_qty),[8,4]);
assert.deepEqual(overGroupChildren.map(c=>c.ordered_qty),beforeOverChildren.map(c=>c.ordered_qty));
// Different parent codes and a direct item share the same physical FIFO pool.
await db.exec("reset role");
await db.exec(`insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2) values
 ('GROUP-Q','GROUP-A',null);
 insert into public.item_pallet_config(itemcode,product_name) values ('GROUP-Q','Bộ khác')`);
await db.exec("set role authenticated");
await rpc("import",{rows:[line("GROUP-Q1","GROUP-Q",20,"2026-11-18"),line("GROUP-DIRECT","GROUP-A",10,"2026-11-18")]});
const sharedSources=(await db.query("select id from public.inv_delivery_requests where purorder in ('GROUP-Q1','GROUP-DIRECT') and request_type<>'child'")).rows.map(r=>r.id);
const sharedPreview=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[sharedSources])).rows[0].data;
assert.equal(sharedPreview.rows.length,2);
const sharedKeys=new Set(sharedPreview.rows.map(r=>r.group_key));
const sharedPicks=suggestDeliveryGroups(sharedPreview,sharedKeys);
assert.equal(analyzeDeliveryGroups(sharedPreview,sharedPicks,sharedKeys).canProceed,false);
assert.ok([...analyzeDeliveryGroups(sharedPreview,sharedPicks,sharedKeys).groups.values()].every(g=>g.short));
const sourcePayload=(data,picks,selected=new Set(data.rows.map(r=>r.group_key)))=>({
 group_model_version:1,shipped_date:"2026-11-18",
 requests:data.requests.filter(r=>selected.has(r.group_key)).map(({id,version,components})=>({id,version,components})),
 lots:data.rows.filter(r=>selected.has(r.group_key)).flatMap(g=>g.components.flatMap(c=>
  Object.entries(picks.get(componentPickKey(g,c.itemcode))??{}).map(([incoming_id,quantity])=>({group_key:g.group_key,incoming_id,quantity})))),
});
await assert.rejects(postBulk(sourcePayload(sharedPreview,sharedPicks)),/DELIVERY_BULK_SHORT_STOCK:GROUP-A/);
const chosenGroup=sharedPreview.rows.find(g=>g.itemcode==="GROUP-Q");
const onlyOne=new Set([chosenGroup.group_key]);
const onlyPicks=suggestDeliveryGroups(sharedPreview,onlyOne);
assert.equal(analyzeDeliveryGroups(sharedPreview,onlyPicks,onlyOne).canProceed,true);
const untouchedDirect=(await get("GROUP-DIRECT"))[0];
await postBulk(sourcePayload(sharedPreview,onlyPicks,onlyOne));
assert.equal((await request(untouchedDirect.id)).shipped_qty,0);
assert.equal((await summary("GROUP-A")).balance_qty,6);
// Reusing one code with a different recipe is never merged into one group.
await db.exec("reset role; insert into public.item_build_up(parent_itemcode,child_itemcode_1) values ('GROUP-P','GROUP-B'); set role authenticated");
const altOptions=(await lookupBuild("GROUP-P")).build_up_options;
const altToken=altOptions.find(o=>o.codes.filter(Boolean).length===1).token;
await rpc("import",{rows:[line("GROUP-ALT","GROUP-P",1,"2026-11-18",{build_up_token:altToken}),line("GROUP-BASE","GROUP-P",1,"2026-11-18",{build_up_token:altOptions.find(o=>o.token!==altToken).token})]});
const altIds=(await db.query("select id from public.inv_delivery_requests where purorder in ('GROUP-ALT','GROUP-BASE') and request_type='parent'")).rows.map(r=>r.id);
assert.equal((await reviewFifo(altIds)).rows.length,2);
await rpc("import",{rows:[line("GROUP-DOUBLE","GROUP-A",2,"2026-11-18")]});
const doubleIds=(await db.query("select id from public.inv_delivery_requests where purorder in ('GROUP-DOUBLE','GROUP-BASE') and request_type<>'child'")).rows.map(r=>r.id);
const doublePreview=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[doubleIds])).rows[0].data;
const doubleKeys=new Set(doublePreview.rows.map(g=>g.group_key));
const doublePicks=suggestDeliveryGroups(doublePreview,doubleKeys);
const directGroup=doublePreview.rows.find(g=>g.request_type==="origin");
const parentGroup=doublePreview.rows.find(g=>g.request_type==="parent");
const zeroDirect=new Map(doublePicks).set(componentPickKey(directGroup,directGroup.itemcode),{});
assert.equal(analyzeDeliveryGroups(doublePreview,zeroDirect,doubleKeys).groups.get(directGroup.group_key).mismatch,false);
assert.equal(analyzeDeliveryGroups(doublePreview,zeroDirect,doubleKeys).canProceed,true,"A regular item with no lots does not block a valid selected parent");
const zeroParent=new Map(doublePicks).set(componentPickKey(parentGroup,parentGroup.components[0].itemcode),{});
assert.equal(analyzeDeliveryGroups(doublePreview,zeroParent,doubleKeys).canProceed,false,"Only parent recipes require all their components to be picked together");
const onlyDirect=new Set([directGroup.group_key]);
assert.equal(analyzeDeliveryGroups(doublePreview,zeroDirect,onlyDirect).canProceed,false,"Cannot submit an empty regular shipment");
for(const g of doublePreview.rows) for(const c of g.components) {
  doublePicks.set(componentPickKey(g,c.itemcode),{[String(c.itemcode==="GROUP-A"?groupLotA:groupLotB)]:c.factor*4});
}
assert.equal(analyzeDeliveryGroups(doublePreview,doublePicks,doubleKeys).canProceed,false);
assert.equal(analyzeDeliveryGroups(doublePreview,doublePicks,doubleKeys).overdrawn,true);
await assert.rejects(postBulk(sourcePayload(doublePreview,doublePicks)),/DELIVERY_INSUFFICIENT_STOCK/);
assert.equal((await summary("GROUP-A")).balance_qty,6);
// Origin-only old browsers remain compatible, and parent cancellation covers all children.
await db.exec("reset role");
const legacyOriginLot=(await seed("GROUP-LEGACY",2,"2026-10-01")).rows[0].id;
await db.exec("set role authenticated");
await rpc("import",{rows:[line("GROUP-LEGACY","GROUP-LEGACY",1,"2026-11-18")]});
const legacyOrigin=(await get("GROUP-LEGACY"))[0];
assert.equal((await postBulk({shipped_date:"2026-11-18",requests:[{id:legacyOrigin.id,version:legacyOrigin.version}],
 lots:[{incoming_id:String(legacyOriginLot),quantity:1}]})).shipped,1);
const toCancel=(await get("GROUP-BASE")).find(r=>r.request_type==="parent");
await rpc("cancel",{id:toCancel.id,version:toCancel.version});
assert.ok((await buildRows(toCancel.id)).every(c=>c.cancelled));
assert.equal((await summary("GROUP-A")).on_order_qty,12);
// Historical mismatches remain visible and cannot be shipped by the new workflow.
const invalidOld=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[[manualKit]])).rows[0].data;
assert.equal(invalidOld.rows[0].sync_error,true);
const invalidPicks=suggestDeliveryGroups(invalidOld,new Set(invalidOld.rows.map(r=>r.group_key)));
await assert.rejects(postBulk(sourcePayload(invalidOld,invalidPicks)),/DELIVERY_COMPONENTS_OUT_OF_SYNC/);
await db.exec("select set_config('test.permission','no',false)");
await assert.rejects(reviewFifo(groupSources),/DELIVERY_NOT_AUTHORIZED/);
await assert.rejects(postBulk(groupPayload,groupCommand),/DELIVERY_NOT_AUTHORIZED/);
await db.exec("select set_config('test.permission','yes',false)");
console.log("PASS: parent groups, synchronized ratio validation and atomic parent-first SO allocation.");

await db.exec("reset role; drop function public.resolve_warehouse_item(text)");
await migrate("20261118110000_unified_warehouse_item_lookup.sql");
await db.exec(`insert into public.item_pallet_config(itemcode,product_name,"ERP_name",customer) values
 ('LOOKUP-ERP',null,'Tên ERP dùng được',null),('LOOKUP-PROD','Tên sản xuất ưu tiên','Tên ERP không ưu tiên','Khách master'),
 ('LOOKUP-FIELDS',null,null,null),('LOOKUP-NONAME',' ',null,'Khách có sẵn'),
 ('LOOKUP-PARENT','Bộ mới',null,null),('LOOKUP-BAD-PARENT','Bộ lỗi',null,null);
 insert into public.pallet_data(id,itemcode,product_name,customer,effect_to,updated_at) values
 (900001,'LOOKUP-FIELDS','Tên từ pallet',null,null,now()),
 (900002,'LOOKUP-FIELDS',null,'Khách từ pallet',null,now()),
 (900003,'LOOKUP-LEGACY','Tên legacy','Khách legacy',null,now());
 insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2) values
 ('LOOKUP-PARENT','LOOKUP-ERP','LOOKUP-PROD'),('LOOKUP-BAD-PARENT','LOOKUP-ERP','LOOKUP-NONAME')`);
const unified=async code=>(await db.query("select * from public.warehouse_item_identity($1)",[code])).rows[0];
assert.equal((await unified("LOOKUP-ERP")).product_name,"Tên ERP dùng được");
assert.equal((await unified("LOOKUP-ERP")).customer,null);
assert.equal((await unified("LOOKUP-PROD")).product_name,"Tên sản xuất ưu tiên");
assert.equal((await unified("LOOKUP-FIELDS")).product_name,"Tên từ pallet");
assert.equal((await unified("LOOKUP-FIELDS")).customer,"Khách từ pallet");
assert.match((await unified("LOOKUP-NONAME")).lookup_error,/chưa có tên sản phẩm/);
assert.match((await unified("LOOKUP-NOT-DECLARED")).lookup_error,/chưa được khai báo/);
await seed("LOOKUP-STOCK-ONLY",2,"2026-11-01");
assert.equal((await unified("LOOKUP-STOCK-ONLY")).declared,false,"Stock is not a master declaration");
await db.exec("set role authenticated");
const validManualLookup=await lookupBuild("LOOKUP-ERP");
assert.equal(validManualLookup.catalog_lookup_version,1);
assert.equal(validManualLookup.product_name,"Tên ERP dùng được");
assert.equal(validManualLookup.customer,null);
assert.match((await lookupBuild("LOOKUP-NOT-DECLARED")).lookup_error,/chưa được khai báo/);
const blankCustomerInput={itemcode:"LOOKUP-ERP",received_date:"2026-11-18",production_date:"2026-11-17",quantity:2,note:"",wo:null};
const emptyCustomerID=randomUUID();
await postIncoming(emptyCustomerID,[blankCustomerInput]);
assert.deepEqual(await postIncoming(emptyCustomerID,[blankCustomerInput]),await postIncoming(emptyCustomerID,[blankCustomerInput]));
assert.deepEqual((await db.query("select product_name,customer from public.inv_incoming where manual_batch_id=$1",[emptyCustomerID])).rows,[{product_name:"Tên ERP dùng được",customer:""}]);
const validDelivery={...input,itemcode:"LOOKUP-ERP",ordered_qty:1,build_up_token:null};
assert.equal((await request((await postManual(validDelivery)).request_id)).product_name,"Tên ERP dùng được");
await assert.rejects(postManual({...validDelivery,itemcode:"LOOKUP-NOT-DECLARED"}),/DELIVERY_CATALOG_REJECTED/);
await assert.rejects(postManual({...validDelivery,itemcode:"LOOKUP-NONAME"}),/DELIVERY_CATALOG_REJECTED/);
await assert.rejects(rpc("import",{rows:[line("LOOKUP-STOCK-ONLY","LOOKUP-STOCK-ONLY",1)]}),/DELIVERY_CATALOG_REJECTED/);
const badBuild=await lookupBuild("LOOKUP-BAD-PARENT");
assert.ok(badBuild.build_up_options[0].components.some(c=>c.lookup_error));
await assert.rejects(postManual({...validDelivery,itemcode:"LOOKUP-BAD-PARENT",build_up_token:badBuild.build_up_options[0].token}),/DELIVERY_CATALOG_REJECTED/);
const erpInvalidRows=[line("LOOKUP-VALID","LOOKUP-ERP",1),line("LOOKUP-UNKNOWN","LOOKUP-NOT-DECLARED",1,"2026-11-18",{excel_row:13,product_name:"Tên trong file không khai báo item"}),
 line("LOOKUP-NONAME","LOOKUP-NONAME",1,"2026-11-18",{excel_row:14})];
const invalidCatalogPreview=await rpc("preview",{rows:erpInvalidRows});
assert.equal(invalidCatalogPreview.catalog_lookup_version,1);
assert.equal(invalidCatalogPreview.rows.filter(r=>r.catalog_error).length,2);
await assert.rejects(rpc("import",{rows:erpInvalidRows}),(error)=>{
  assert.ok(error.message.startsWith("DELIVERY_CATALOG_REJECTED:"));
  const rejection=JSON.parse(error.message.slice("DELIVERY_CATALOG_REJECTED:".length));
  assert.deepEqual(rejection.errors.map(e=>e.row),[13,14]);
  assert.match(rejection.errors[0].reason,/chưa được khai báo/);
  assert.match(rejection.errors[1].reason,/chưa có tên sản phẩm/);
  return true;
});
assert.equal((await get("LOOKUP-VALID")).length,0,"A file rejection is atomic, including valid rows");
const badChildrenPreview=(await rpc("preview",{rows:[line("LOOKUP-BAD-CHILD","LOOKUP-BAD-PARENT",1)]})).rows;
assert.ok(deliveryPreviewErrors(previewDeliveryDemand(badChildrenPreview,{12:"new"})[0]).length>0);
const goodPreview=await rpc("preview",{rows:[line("LOOKUP-GOOD","LOOKUP-PARENT",1)]});
const goodOption=goodPreview.rows[0].build_up_options[0];
assert.ok(goodOption.components.every(c=>!c.lookup_error));
await rpc("import",{rows:[line("LOOKUP-GOOD","LOOKUP-PARENT",1,"2026-11-18",{build_up_token:goodOption.token})]});
const newGoodParent=(await get("LOOKUP-GOOD")).find(r=>r.request_type==="parent");
assert.deepEqual((await buildRows(newGoodParent.id)).map(c=>[c.product_name,c.customer]),[
 ["Tên ERP dùng được",""],["Tên sản xuất ưu tiên","Khách master"]]);
await db.exec("reset role");
await seed("LOOKUP-PROD",2,"2026-11-17");
await db.exec("set role authenticated");
const declaredParentBulk=(await db.query("select public.preview_bulk_delivery($1::uuid[]) as data",[[newGoodParent.id]])).rows[0].data;
assert.equal(declaredParentBulk.rows[0].product_name,"Bộ mới");
const declaredKeys=new Set(declaredParentBulk.rows.map(g=>g.group_key));
await postBulk(sourcePayload(declaredParentBulk,suggestDeliveryGroups(declaredParentBulk,declaredKeys)));
assert.ok((await buildRows(newGoodParent.id)).every(c=>c.shipped_qty===1),"Unified lookup preserves synchronized parent shipping");
const rawErpLine=line("LOOKUP-RAW","LOOKUP-PROD",1,"2026-11-18",{product_name:"Tên ERP gốc trong file",customer:"Khách ERP gốc"});
const rawPreview=(await rpc("preview",{rows:[rawErpLine]})).rows[0];
assert.equal(rawPreview.product_name,rawErpLine.product_name);
assert.equal(rawPreview.system_product_name,"Tên sản xuất ưu tiên");
await rpc("import",{rows:[rawErpLine]});
assert.equal((await get("LOOKUP-RAW"))[0].product_name,"Tên ERP gốc trong file","Keep ERP evidence separately from system display");
const legacyLookup=await manageCatalog("lookup",{itemcode:"LOOKUP-LEGACY",recipes:true});
assert.equal(legacyLookup.catalog_lookup_version,1);
assert.equal(legacyLookup.catalog,null);
assert.equal(legacyLookup.resolved.product_name,"Tên legacy");
assert.equal(legacyLookup.resolved.customer,"Khách legacy");
await manageCatalog("save_build_up",{itemcode:"LOOKUP-LEGACY",children:["LOOKUP-FIELDS","LOOKUP-ERP",null]});
await assert.rejects(manageCatalog("save_build_up",{itemcode:"LOOKUP-UNKNOWN-LINK",children:["LOOKUP-ERP",null,null]}),/WAREHOUSE_CATALOG_LOOKUP_REJECTED/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"LOOKUP-NONAME",children:["LOOKUP-ERP",null,null]}),/WAREHOUSE_CATALOG_LOOKUP_REJECTED/);
await db.exec("reset role");
assert.equal((await catalog("LOOKUP-LEGACY")).product_name,"Tên legacy");
assert.equal((await catalog("LOOKUP-FIELDS")).product_name,"Tên từ pallet");
assert.equal((await catalog("LOOKUP-FIELDS")).customer,"Khách từ pallet");
assert.equal((await catalog("LOOKUP-ERP")).product_name,null,"ERP display fallback never overwrites production name");
await db.exec(`insert into public.item_pallet_config(itemcode,product_name) values
 ('LOOKUP-RACE','Tên trước khi kiểm tra'),('LOOKUP-RETRY','Tên đã ghi lịch');
 insert into public.item_build_up(parent_itemcode,child_itemcode_1) values ('LOOKUP-PARENT','LOOKUP-NONAME')`);
await db.exec("set role authenticated");
const raceLine=line("LOOKUP-RACE","LOOKUP-RACE",1);
assert.equal((await rpc("preview",{rows:[raceLine]})).rows[0].catalog_error,null);
const retryLine=line("LOOKUP-RETRY","LOOKUP-RETRY",1);
const catalogCommand=randomUUID();
const alreadyPosted=await rpc("import",{rows:[retryLine]},catalogCommand);
const alternativePreview=(await rpc("preview",{rows:[line("LOOKUP-ALT","LOOKUP-PARENT",1)]})).rows;
const invalidAlternative=alternativePreview[0].build_up_options.find(o=>o.components.some(c=>c.lookup_error));
const validAlternative=alternativePreview[0].build_up_options.find(o=>o.components.every(c=>!c.lookup_error));
assert.equal(deliveryPreviewErrors(previewDeliveryDemand(alternativePreview,{12:"new"},{12:validAlternative.token})[0]).length,0);
assert.ok(deliveryPreviewErrors(previewDeliveryDemand(alternativePreview,{12:"new"},{12:invalidAlternative.token})[0]).length>0);
await assert.rejects(rpc("import",{rows:[line("LOOKUP-ALT","LOOKUP-PARENT",1,"2026-11-18",{build_up_token:invalidAlternative.token})]}),/DELIVERY_CATALOG_REJECTED/);
await db.exec("reset role; delete from public.item_pallet_config where itemcode in ('LOOKUP-RACE','LOOKUP-RETRY'); set role authenticated");
await assert.rejects(rpc("import",{rows:[raceLine]}),/DELIVERY_CATALOG_REJECTED/);
assert.equal((await get("LOOKUP-RACE")).length,0,"Posting rechecks a declaration removed after preview");
assert.deepEqual(await rpc("import",{rows:[retryLine]},catalogCommand),alreadyPosted,"A successful prior operation remains safely retryable");
await assert.rejects(rpc("import",{rows:[retryLine]}),/DELIVERY_CATALOG_REJECTED/);
await db.exec("reset role");
await db.exec(`grant select,insert,update on public.item_pallet_config to service_role;
 grant select on public.pallet_data to service_role;
 insert into public.pallet_data(id,itemcode,product_name,customer,effect_to,updated_at)
 values(900004,'LOOKUP-SERVICE','Tên qua server',null,null,now());
 set role service_role`);
assert.deepEqual((await db.query("select * from public.resolve_warehouse_item('LOOKUP-SERVICE')")).rows,
 [{itemcode:"LOOKUP-SERVICE",product_name:"Tên qua server",customer:""}],"The real service-role lookup can call the shared helper and backfill the catalog");
await db.exec("set role authenticated");
await assert.rejects(db.query("select * from public.warehouse_item_identity('LOOKUP-ERP')"),/permission denied/);
await assert.rejects(db.query("select public.post_manual_delivery_catalog_v1($1,'{}')",[randomUUID()]),/permission denied/);
console.log("PASS: unified catalog lookup, ERP-name priority, independent field fallbacks, optional customer intake, strict ERP/manual declarations, recipe checks and ERP evidence preservation.");

await db.exec("reset role");
const preActiveRecipes=(await db.query("select parent_itemcode,count(*)::int as count from public.item_build_up group by parent_itemcode")).rows;
await migrate("20261118120000_active_item_build_up.sql");
for(const before of preActiveRecipes){
 const rows=(await db.query("select active from public.item_build_up where parent_itemcode=$1",[before.parent_itemcode])).rows;
 assert.equal(rows.filter(r=>r.active).length,before.count===1?1:0);
}
await db.exec(`insert into public.item_pallet_config(itemcode,product_name) values
 ('ACTIVE-P','Mẹ nhiều bộ'),('ACTIVE-A','Con A'),('ACTIVE-B','Con B'),
 ('ACTIVE-C','Con C'),('ACTIVE-D','Con D'),('ACTIVE-ONLY','Chỉ một bộ mới');
 insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2) values
 ('ACTIVE-P','ACTIVE-A','ACTIVE-B'),('ACTIVE-P','ACTIVE-C','ACTIVE-D'),('ACTIVE-ONLY','ACTIVE-A',null)`);
await db.exec("set role authenticated");
const activeRecipes=async code=>(await lookupBuild(code)).build_up_options;
const activeRows=async code=>(await manageCatalog("lookup",{itemcode:code,recipes:true})).recipes;
const initialActiveOptions=await activeRecipes("ACTIVE-P");
assert.equal((await lookupBuild("ACTIVE-P")).build_up_active_version,1);
assert.ok(initialActiveOptions.every(o=>o.active===false));
assert.equal(selectDeliveryBuildUp(initialActiveOptions),undefined);
assert.equal(selectDeliveryBuildUp(await activeRecipes("ACTIVE-ONLY")),undefined,"One inactive recipe still requires a first choice");
const firstOption=initialActiveOptions[0],secondOption=initialActiveOptions[1];
const needsActive=deliveryBuildUpSelection(initialActiveOptions,firstOption.token);
assert.equal(needsActive.needs_activation,true);
assert.equal(needsActive.expected_active_token,null);
assert.equal(parseManualDeliveryInput({...input,...needsActive}).needs_activation,true);
assert.equal(parseManualDeliveryInput({...input}).needs_activation,undefined,"Old retry payloads are preserved");
assert.throws(()=>parseManualDeliveryInput({...input,needs_activation:"yes"}),/active không hợp lệ/);
assert.throws(()=>parseManualDeliveryInput({...input,expected_active_token:"not-a-recipe"}),/active không hợp lệ/);
await assert.rejects(postManual({...input,itemcode:"ACTIVE-P"}),/DELIVERY_BUILD_UP_CHOOSE/);
const activeManualPayload={...input,itemcode:"ACTIVE-P",ordered_qty:1,...needsActive};
const activeManualCommand=randomUUID();
const activatedManual=await postManual(activeManualPayload,activeManualCommand);
assert.equal((await activeRows("ACTIVE-P")).filter(r=>r.active).length,1);
assert.equal((await activeRecipes("ACTIVE-P")).find(o=>o.active).token,firstOption.token);
const afterFirst=await activeRecipes("ACTIVE-P");
assert.equal(selectDeliveryBuildUp(afterFirst,secondOption.token).token,firstOption.token,"An active recipe is selected automatically");
assert.equal(deliveryBuildUpSelection(afterFirst).needs_activation,false);
await postManual({...input,itemcode:"ACTIVE-P",ordered_qty:1,...needsActive});
await postManual({...input,itemcode:"ACTIVE-P",ordered_qty:1,...needsActive,needs_activation:false});
await assert.rejects(postManual({...input,itemcode:"ACTIVE-P",build_up_token:secondOption.token,needs_activation:true,expected_active_token:null}),/DELIVERY_BUILD_UP_ACTIVE_CHANGED/);
await assert.rejects(db.exec("update public.item_build_up set active=true where parent_itemcode='ACTIVE-P'"),/permission denied/);
await db.exec("reset role");
await assert.rejects(db.exec("update public.item_build_up set active=true where parent_itemcode='ACTIVE-P'"),/duplicate key/);
await db.exec("set role authenticated");
const editorLookup=await manageCatalog("lookup",{itemcode:"ACTIVE-P",recipes:true});
assert.ok(editorLookup.recipes[0].active);
const deactive=editorLookup.recipes.find(r=>!r.active);
await manageCatalog("save_build_up",{itemcode:"ACTIVE-P",children:deactive.children,replace_id:deactive.id,expected_children:deactive.children});
assert.equal((await activeRecipes("ACTIVE-P")).find(o=>o.active).token,secondOption.token);
assert.deepEqual(await postManual(activeManualPayload,activeManualCommand),activatedManual,"Retry never reactivates an old default");
assert.equal((await activeRecipes("ACTIVE-P")).find(o=>o.active).token,secondOption.token);
const newRecipe=await manageCatalog("save_build_up",{itemcode:"ACTIVE-P",children:["ACTIVE-A","ACTIVE-D",null],create_new:true});
assert.equal(newRecipe.active,true);
assert.equal((await activeRows("ACTIVE-P")).filter(r=>r.active).length,1);
const newActiveOptions=await activeRecipes("ACTIVE-P");
assert.equal(newActiveOptions.find(o=>o.active).token.split(":")[0],newRecipe.recipe_id);
const oldSnapshot=await buildRows(activatedManual.request_id);
assert.deepEqual(oldSnapshot.map(r=>r.itemcode),firstOption.components.map(c=>c.itemcode),"Changing active never edits created requests");
await assert.rejects(postManual({...input,itemcode:"ACTIVE-P",...deliveryBuildUpSelection(afterFirst)}),/DELIVERY_BUILD_UP_ACTIVE_CHANGED/);
// ERP creates new schedules and activates once; repeated rows share one choice.
const noActiveSingle=await activeRecipes("ACTIVE-ONLY");
const erpSingleChoice=deliveryBuildUpSelection(noActiveSingle,noActiveSingle[0].token);
const activeERPFile={rows:[line("ACTIVE-ERP1","ACTIVE-ONLY",1,"2026-11-18",{excel_row:1,...erpSingleChoice}),
 line("ACTIVE-ERP2","ACTIVE-ONLY",2,"2026-11-18",{excel_row:2,...erpSingleChoice})]};
const previewBeforeActive=await rpc("preview",activeERPFile);
assert.equal(previewBeforeActive.build_up_active_version,1);
assert.equal((await activeRows("ACTIVE-ONLY")).some(r=>r.active),false,"Preview does not activate");
const activeERPCommand=randomUUID();
const activeERPResult=await rpc("import",activeERPFile,activeERPCommand);
assert.equal(activeERPResult.changed,2);
assert.equal((await activeRows("ACTIVE-ONLY")).filter(r=>r.active).length,1);
await db.exec("reset role");
const activeXminBefore=(await db.query("select xmin::text as version from public.item_build_up where parent_itemcode='ACTIVE-ONLY' and active")).rows[0].version;
await db.exec("set role authenticated");
const autoDefault=await activeRecipes("ACTIVE-ONLY");
assert.equal(deliveryBuildUpSelection(autoDefault).needs_activation,false);
await rpc("import",{rows:[line("ACTIVE-ERP3","ACTIVE-ONLY",1,"2026-11-18",deliveryBuildUpSelection(autoDefault))]});
await db.exec("reset role");
assert.equal((await db.query("select xmin::text as version from public.item_build_up where parent_itemcode='ACTIVE-ONLY' and active")).rows[0].version,activeXminBefore,"Using active performs no default-row update");
await db.exec(`insert into public.item_pallet_config(itemcode,product_name) values
 ('ACTIVE-FAIL','Mẹ kiểm tra rollback'),('ACTIVE-FILE','Mẹ dùng trong file');
 insert into public.item_build_up(parent_itemcode,child_itemcode_1) values
 ('ACTIVE-FAIL','ACTIVE-A'),('ACTIVE-FAIL','ACTIVE-B'),('ACTIVE-FILE','ACTIVE-A'),('ACTIVE-FILE','ACTIVE-B')`);
await db.exec("set role authenticated");
const failChoices=await activeRecipes("ACTIVE-FAIL");
const failSelection=deliveryBuildUpSelection(failChoices,failChoices[0].token);
await assert.rejects(postManual({...input,itemcode:"ACTIVE-FAIL",ordered_qty:0,...failSelection}),/DELIVERY_INVALID_QUANTITY/);
assert.ok((await activeRows("ACTIVE-FAIL")).every(r=>!r.active),"A failed manual post does not activate");
await assert.rejects(rpc("import",{rows:[line("ACTIVE-FAIL1","ACTIVE-FAIL",1,"2026-11-18",failSelection),line("ACTIVE-FAIL2","NEVER-DECLARED-ACTIVE",1)]}),/DELIVERY_CATALOG_REJECTED/);
assert.equal((await get("ACTIVE-FAIL1")).length,0);
assert.ok((await activeRows("ACTIVE-FAIL")).every(r=>!r.active),"A rejected file does not activate a valid row");
await postManual({...input,itemcode:"ACTIVE-FAIL",...failSelection,needs_activation:false});
assert.equal((await activeRecipes("ACTIVE-FAIL")).find(o=>o.active).token,failChoices[0].token,"Backend derives activation even if a client flag is false");
const fileChoices=await activeRecipes("ACTIVE-FILE");
const fileRows=[line("ACTIVE-MULTI1","ACTIVE-FILE",1,"2026-11-18",{excel_row:1,...deliveryBuildUpSelection(fileChoices,fileChoices[0].token)}),
 line("ACTIVE-MULTI2","ACTIVE-FILE",1,"2026-11-18",{excel_row:2,...deliveryBuildUpSelection(fileChoices,fileChoices[1].token)})];
await assert.rejects(rpc("import",{rows:fileRows}),/DELIVERY_BUILD_UP_CONFLICT:ACTIVE-FILE/);
assert.ok((await activeRows("ACTIVE-FILE")).every(r=>!r.active));
assert.equal((await get("ACTIVE-MULTI1")).length,0);
const mergedChoice=previewDeliveryDemand((await rpc("preview",{rows:fileRows})).rows,{1:"new",2:"new"},{"ACTIVE-FILE":fileChoices[1].token});
assert.ok(mergedChoice.every(r=>r.preview_components[0].itemcode===fileChoices[1].components[0].itemcode),"A single frontend parent choice applies to every new ERP row");
fileRows[0]={...fileRows[0],...deliveryBuildUpSelection(fileChoices,fileChoices[1].token)};
const fileCommand=randomUUID();
const fileResult=await rpc("import",{rows:fileRows},fileCommand);
assert.equal((await activeRecipes("ACTIVE-FILE")).find(o=>o.active).token,fileChoices[1].token);
const currentFileRecipes=(await manageCatalog("lookup",{itemcode:"ACTIVE-FILE",recipes:true})).recipes;
const previouslyInactive=currentFileRecipes.find(r=>!r.active);
await manageCatalog("save_build_up",{itemcode:"ACTIVE-FILE",replace_id:previouslyInactive.id,expected_children:previouslyInactive.children,children:previouslyInactive.children});
const expectedDefault=(await activeRecipes("ACTIVE-FILE")).find(o=>o.active).token;
assert.deepEqual(await rpc("import",{rows:fileRows},fileCommand),fileResult);
assert.equal((await activeRecipes("ACTIVE-FILE")).find(o=>o.active).token,expectedDefault,"ERP retry never reactivates a previous choice");
const historicalParent=(await get("ACTIVE-MULTI1")).find(r=>r.request_type==="parent");
await rpc("import",{rows:[line("ACTIVE-MULTI1","ACTIVE-FILE",2,"2026-11-19",{target_id:historicalParent.id,expected_version:historicalParent.version,mode:"update"})]});
assert.equal((await activeRecipes("ACTIVE-FILE")).find(o=>o.active).token,expectedDefault,"Rescheduling old orders does not replace the active recipe");
assert.equal((await buildRows(historicalParent.id))[0].itemcode,fileChoices[1].components[0].itemcode);
await assert.rejects(db.query("select public.delivery_activate_build_up('ACTIVE-P',$1,true)",[firstOption.token]),/permission denied/);
await assert.rejects(db.query("select public.post_manual_delivery_before_active($1,'{}')",[randomUUID()]),/permission denied/);
await assert.rejects(db.query("select public.manage_delivery_before_active('import',$1,'{}')",[randomUUID()]),/permission denied/);
await assert.rejects(manageCatalog("save_build_up",{itemcode:"ACTIVE-P",children:["ACTIVE-A","ACTIVE-D",null],create_new:true}),/WAREHOUSE_CATALOG_DUPLICATE_RECIPE/);
console.log("PASS: active recipe migration, default selection, manual/ERP activation, editor changes, uniqueness, stale snapshots and retries.");
await db.close();
console.log("PASS: merged parser, FIFO allocation, aggregate shortage, import/update dedupe, partial/done, cancellation, reschedule, units, rollback, access control and ledger consistency.");
