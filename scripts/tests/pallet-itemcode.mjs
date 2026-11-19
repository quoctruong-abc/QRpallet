import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
let allowed = true, rows = [], summaries = [], config = null, databaseError = null, createError = null, woStatus = { wo: 'FRESH', valid: true }, calls = [], queries = [];
const client = {
  from(table) {
    const query = { table, filters: [], offset: 0, end: 999 };
    queries.push(query);
    const builder = {
      select: () => builder,
      eq: (key, value) => { query.filters.push([key, value]); return builder; },
      is: (key, value) => { query.filters.push([key, value]); return builder; },
      not: (key) => { query.nonNull = key; return builder; },
      ilike: (key, pattern) => { query.prefix = [key, pattern.slice(0, -1).toLowerCase()]; return builder; },
      order: () => builder,
      range: (offset, end) => { query.offset = offset; query.end = end; return builder; },
      maybeSingle: async () => ({ data: config, error: databaseError }),
      then: (resolve, reject) => Promise.resolve({ data: rows.filter(row => query.filters.every(([k, v]) => row[k] === v)
        && (!query.nonNull || row[query.nonNull] != null)
        && (!query.prefix || row[query.prefix[0]]?.toLowerCase().startsWith(query.prefix[1])))
        .slice(query.offset, query.end + 1), error: databaseError }).then(resolve, reject),
    };
    return builder;
  },
  rpc: (name, args) => {
    if (name === 'pallet_itemcode_work_orders') {
      const query = { table: 'WO summary RPC', args, offset: 0, end: 999 }; queries.push(query);
      const builder = { order: () => builder, range: (offset, end) => { query.offset = offset; query.end = end; return builder; },
        then: (resolve, reject) => Promise.resolve({ data: summaries.slice(query.offset, query.end + 1), error: databaseError }).then(resolve, reject) };
      return builder;
    }
    if (name === 'check_new_pallet_wo') return Promise.resolve({ data: woStatus, error: databaseError });
    calls.push({ name, args }); return Promise.resolve({ data: createError ? null : { pallet_id: 'WO-NEW-001' }, error: createError });
  },
};
const mocks = {
  '@/lib/auth': { authorizePermission: async key => { assert.equal(key, 'pallet.create'); return allowed ? { ok: true, profile: { id: 'operator' } } : { ok: false, status: 403, error: 'Denied' }; } },
  '@/lib/supabase/server': { createClient: async () => client },
};
function load(file) {
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = id => mocks[id] ?? (id.startsWith('@/') ? load(new URL('../../' + id.slice(2) + '.ts', import.meta.url).pathname) : require(id));
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports;
}
const { GET } = load(new URL('../../app/api/pallet-label/old-itemcode/route.ts', import.meta.url).pathname);
const checkNewWo = load(new URL('../../app/api/pallet-label/check-new-wo/route.ts', import.meta.url).pathname);
const oldWo = load(new URL('../../app/api/pallet-label/old-wo/route.ts', import.meta.url).pathname);
const { POST } = load(new URL('../../app/api/pallet-label/create/route.ts', import.meta.url).pathname);
const get = code => new Request('http://localhost/api/pallet-label/old-itemcode?' + new URLSearchParams({ itemcode: code }));
const valid = { source: 'old-itemcode', itemcode: '11011*209', wo: ' WO-NEW ', quantity: 100, quanorder: 500, working_day: '2026-11-18', product_name: 'forged', customer: 'forged' };
const post = body => new Request('http://localhost/api/pallet-label/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const catalog = { itemcode: '1101100000209', product_name: ' Production name ', ERP_name: 'ERP name', customer: ' Customer ', quantity_per_pallet: 100 };

allowed = false;
assert.equal((await GET(get('ITEM'))).status, 403);
assert.equal((await POST(post(valid))).status, 403);
assert.equal(queries.length, 0);
allowed = true;
for (const code of ['', 'A B', '*', '1**2', 'x'.repeat(201)]) assert.equal((await GET(get(code))).status, 400);

const base = { itemcode: 'ITEM', wo: 'WO-1', product_name: 'Name', customer: 'Client', machine: 'M1', quanorder: 500, quantity: 20, status: 'production', effect_to: null, created_at: '2026-11-18T03:00:00Z' };
summaries = Array.from({ length: 1001 }, (_, index) => ({ ...base, wo: 'WO-' + index, quanorder: '500', produced_quantity: '20', warehouse_quantity: '0', pallet_count: '1' }));
let response = await GET(get('ITEM')), result = await response.json();
assert.equal(response.status, 200);
assert.equal(result.workOrders.length, 1001, 'All summary pages are included');
assert.equal(result.workOrders[0].produced_quantity, 20);
assert.equal(queries.filter(q => q.table === 'item_pallet_config').length, 1, 'Existing WO results also offer a catalog-backed new-WO form');
assert.ok(result.newWoError, 'Missing catalog does not hide existing WOs');
config = { ...catalog };
assert.ok((await (await GET(get('ITEM'))).json()).item, 'Existing WOs and a valid new-WO form can be returned together');
assert.equal(queries.filter(q => q.table === 'pallet_data').length, 0, 'Lookup never downloads raw pallet history');
assert.deepEqual(queries.find(q => q.table === 'WO summary RPC').args, { p_itemcode: 'ITEM' });
summaries = [];

rows = []; config = { ...catalog };
response = await GET(get('11011*209')); result = await response.json();
assert.equal(response.status, 200); assert.equal(result.itemcode, catalog.itemcode);
assert.equal(result.item.product_name, 'Production name'); assert.equal(result.item.customer, 'Customer');
config.product_name = '  ';
assert.equal((await (await GET(get(catalog.itemcode))).json()).item.product_name, 'ERP name');
config.customer = ' ';
assert.equal((await GET(get(catalog.itemcode))).status, 409);
config = { ...catalog, product_name: '', ERP_name: '' };
assert.equal((await GET(get(catalog.itemcode))).status, 409);
config = null;
assert.equal((await GET(get('UNKNOWN'))).status, 404);
databaseError = { message: 'offline' };
const previousConsoleError = console.error; console.error = () => {};
assert.equal((await GET(get('ITEM'))).status, 500, 'DB error must not switch to manual printing');
console.error = previousConsoleError; databaseError = null;

config = { ...catalog };
for (const change of [
  { wo: '' }, { wo: 'W'.repeat(121) }, { working_day: '' }, { working_day: '2026-02-30' },
  { quanorder: null }, { quanorder: '' }, { quanorder: -1 }, { quanorder: 'NaN' },
  { quantity: 0 }, { quantity: 1.5 }, { quantity: 2147483648 },
]) assert.equal((await POST(post({ ...valid, ...change }))).status, 400);
assert.equal(calls.length, 0, 'Required-field validation happens before any write');
response = await POST(post(valid));
assert.equal(response.status, 200);
assert.equal(calls[0].name, 'create_pallet_from_new_wo');
assert.deepEqual(calls[0].args, {
  p_itemcode: catalog.itemcode, p_wo: 'WO-NEW', p_quanorder: 500, p_quantity: 100, p_working_day: '2026-11-18',
}, 'New-WO API never passes browser product/customer identity or calls the unguarded legacy RPC');
for (const [message, status] of [['PALLET_NEW_WO_CUSTOMER_MISSING',409],['PALLET_NEW_WO_ITEM_MISSING',409],['PALLET_NEW_WO_EXISTS',409],['PALLET_NEW_WO_ID_CONFLICT',409],['PALLET_NEW_WO_BUSY',503],['PALLET_NEW_WO_INVALID',400],['NOT_AUTHORIZED',403]]) {
  createError = { message }; assert.equal((await POST(post(valid))).status, status);
}
createError = null;
calls = [];
assert.equal((await POST(post({ itemcode: 'OLD', wo: 'WO-OLD', quantity: 10, quanorder: null }))).status, 200, 'Existing WO printing keeps its optional date and order quantity');
assert.equal(calls[0].args.p_working_day, null);

queries = []; rows = [{ ...base, pallet_id: 'P-1', reprint_count: 0, even_pallet: false }];
response = await oldWo.GET(new Request('http://localhost/api/pallet-label/old-wo?wo=WO-1&itemcode=ITEM'));
assert.equal(response.status, 200);
assert.ok(queries.filter(q => q.table === 'pallet_data').every(q => q.filters.some(([key, value]) => key === 'itemcode' && value === 'ITEM')), 'WO selection remains scoped to the searched item');
rows = [{ ...base, pallet_id: 'P-OLD', effect_to: '2026-11-19', note: 'edit: quantity', even_pallet: false }];
response = await oldWo.GET(new Request('http://localhost/api/pallet-label/old-wo?wo=WO-1&itemcode=ITEM'));
result = await response.json();
assert.equal(response.status, 200, 'A WO discovered only in expired history can still be inspected');
assert.equal(result.pallets[0].status, 'historical');
assert.equal(result.pallets[0].is_deleted, true, 'Expired versions cannot be sent to reprint');
assert.equal(result.workOrder.produced_quantity, 0);
assert.equal((await oldWo.GET(new Request('http://localhost/api/pallet-label/old-wo?wo=WO-1'))).status, 404, 'WO tab keeps its original current/deleted history scope');
const checkRequest = wo => new Request('http://localhost/api/pallet-label/check-new-wo?' + new URLSearchParams({ wo }));
allowed = false; assert.equal((await checkNewWo.GET(checkRequest('FRESH'))).status, 403); allowed = true;
for (const wo of ['', '0', 'X'.repeat(121)]) assert.equal((await checkNewWo.GET(checkRequest(wo))).status, 400);
response = await checkNewWo.GET(checkRequest('FRESH')); assert.equal((await response.json()).valid, true);
woStatus = { wo: 'TAKEN', valid: false, reason: 'EXISTS' };
response = await checkNewWo.GET(checkRequest('TAKEN')); assert.equal(response.status, 200); assert.equal((await response.json()).valid, false);
databaseError = { message: 'offline' }; assert.equal((await checkNewWo.GET(checkRequest('FRESH'))).status, 503);
console.log('PASS API: historical/new-WO choice, catalog gates, blur checks, required fields, atomic new-WO RPC contract, duplicate/busy errors, item-scoped history and existing WO print compatibility.');
