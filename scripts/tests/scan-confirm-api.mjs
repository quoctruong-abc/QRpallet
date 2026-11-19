import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire,Module } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
const require=createRequire(import.meta.url),profile={id:randomUUID(),role:'user'};
let calls=[],filters=[],pending=[],createError=null,recoveryError=null,recovered=null,allowed=true;
const receipt={receipt_id:'WH-191126-001',receipt_date:'2026-11-19',total_pallet:2,total_quantity:12};
const client={from:()=>{const builder={select:()=>builder,in:()=>builder,is:()=>builder,eq:(key,value)=>{filters.push([key,value]);return builder;},then:(resolve,reject)=>Promise.resolve({data:pending,error:null}).then(resolve,reject)};return builder;},rpc:async(name,args)=>{
 calls.push({name,args});return name==='recover_scan_receipt'?{data:recovered?[recovered]:[],error:recoveryError}:{data:createError?null:[receipt],error:createError};
}};
const mocks={'@/lib/auth':{authorizePermission:async key=>{assert.equal(key,'scan.standard');return allowed?{ok:true,profile}:{ok:false,status:403,error:'Denied'};}},'@/lib/supabase/server':{createClient:async()=>client}};
function load(file){const mod=new Module(file);mod.filename=file;mod.paths=Module._nodeModulePaths(process.cwd());mod.require=id=>mocks[id]??(id.startsWith('@/')?load(new URL('../../'+id.slice(2)+'.ts',import.meta.url).pathname):require(id));mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
const {POST}=load(new URL('../../app/api/scan-qr/confirm/route.ts',import.meta.url).pathname);
const req=ids=>new Request('http://localhost/api/scan-qr/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({palletIds:ids})});
pending=[{pallet_id:'A'},{pallet_id:'B'}];
let response=await POST(req(['A','B']));assert.equal(response.status,200);assert.equal(calls[0].name,'create_warehouse_receipt_from_scan');assert.equal(calls.length,1);assert.ok(filters.some(([k,v])=>k==='scanned_by'&&v===profile.id));
calls=[];pending=[];recoveryError={code:'PGRST202',message:'missing preparation'};response=await POST(req(['A','B']));assert.equal(response.status,409);assert.equal(calls.length,1,'App remains compatible before preparation is installed');
recoveryError=null;recovered=receipt;response=await POST(req(['A','B']));assert.equal(response.status,200);assert.equal((await response.json()).receiptId,receipt.receipt_id);
pending=[{pallet_id:'A'},{pallet_id:'B'}];createError={message:'PALLET_STATUS_CHANGED_OR_NOT_OWNER'};response=await POST(req(['A','B']));assert.equal(response.status,200,'A concurrent successful confirmation is recovered');
for(const [message,status] of [['SCAN_STOCK_BUSY',503],['SCAN_STOCK_MISSING_NAME:ITEM-A',409],['SCAN_STOCK_RECEIPT_MISMATCH:WH-1',409]]){
 createError={message};response=await POST(req(['A','B']));assert.equal(response.status,status);assert.equal((await response.json()).success,false);
}
calls=[];response=await POST(req(['A','A']));assert.equal(response.status,400);assert.equal(calls.length,0);
allowed=false;response=await POST(req(['A','B']));assert.equal(response.status,403);assert.equal(calls.length,0);
console.log('PASS: scan API keeps the old RPC contract/permission, tolerates preparation not installed, recovers lost/concurrent confirmations and reports atomic stock failures.');
