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
const { parseDeliverySheet } = require("../../lib/warehouse-receipt/outgoing.ts");
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
await db.close();
console.log("PASS: merged parser, FIFO allocation, aggregate shortage, import/update dedupe, partial/done, cancellation, reschedule, units, rollback, access control and ledger consistency.");
