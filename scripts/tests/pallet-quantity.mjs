import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const catalog = Array.from({ length: 2005 }, (_, i) => ({ itemcode: `ITEM-${String(i).padStart(4, '0')}`, quantity_per_pallet: i + 1 }));
const target = catalog[1999];
let allowed = true, databaseError = null, queries = [], calls = [], pallets = [];
const client = {
  from(table) {
    const query = { table, filters: [], values: null, offset: 0, end: 999 }; queries.push(query);
    const nonNull = []; let prefix = null;
    const source = () => table === 'item_pallet_config' ? catalog : table === 'planning_inject' ? [{ machine: 'M1', itemcode: ` ${target.itemcode} `, wo: 'WO-1', quanorder: 10000, product_name: 'Name', customer: 'Customer' }] : pallets;
    const data = () => source().filter(row => query.filters.every(([key, value]) => row[key] === value)
      && (!query.values || query.values.includes(row.itemcode)) && nonNull.every(key => row[key] != null)
      && (!prefix || row.note?.toLowerCase().startsWith(prefix))).slice(query.offset, query.end + 1);
    const builder = {
      select: () => builder, order: () => builder,
      not: (key, op, value) => { assert.equal(op, 'is'); assert.equal(value, null); nonNull.push(key); return builder; },
      is: (key, value) => { query.filters.push([key, value]); return builder; },
      ilike: (key, value) => { assert.equal(key, 'note'); prefix = value.slice(0, -1).toLowerCase(); return builder; },
      eq: (key, value) => { query.filters.push([key, value]); return builder; },
      in: (key, values) => { assert.equal(key, 'itemcode'); query.values = values; return builder; },
      range: (offset, end) => { query.offset = offset; query.end = end; return builder; },
      maybeSingle: async () => ({ data: data()[0] ?? null, error: databaseError }),
      then: (resolve, reject) => Promise.resolve({ data: data(), error: databaseError }).then(resolve, reject),
    };
    return builder;
  },
  rpc: async (name, args) => { calls.push({ name, args }); return { data: { pallet_id: 'WO-1-001' }, error: null }; },
};
const StubClient = () => null;
const mocks = {
  '@/lib/auth': { authorizePermission: async key => { assert.equal(key, 'pallet.create'); return allowed ? { ok: true } : { ok: false, status: 403, error: 'Denied' }; }, requirePermission: async () => ({ id: 'operator', role: 'user', position: 'production', is_active: true }), hasPermission: () => true },
  '@/lib/supabase/server': { createClient: async () => client },
  '@/components/page-shell': { PageShell: () => null }, './pallet-label-client': { PalletLabelClient: StubClient },
};
function load(file) {
  const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = id => mocks[id] ?? (id.startsWith('@/') ? load(new URL('../../' + id.slice(2) + '.ts', import.meta.url).pathname) : require(id));
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
  return mod.exports;
}
const { palletQuantity, loadPalletQuantities } = load(new URL('../../lib/pallet-label/quantity.ts', import.meta.url).pathname);
for (const value of [null, undefined, 0, -1, true, '', 'NaN', 1.5, 2147483648]) assert.equal(palletQuantity(value), null);
assert.equal(palletQuantity('300'), 300);
const oldResponse = await client.from('item_pallet_config').select();
assert.equal(oldResponse.data.length, 1000); assert.ok(!oldResponse.data.some(row => row.itemcode === target.itemcode), 'Reproduce the old unfiltered catalog truncation');
queries = [];
const loaded = await loadPalletQuantities(client, [...catalog.map(row => row.itemcode), ` ${target.itemcode} `]);
assert.equal(loaded.quantities.size, 2005); assert.equal(loaded.quantities.get(target.itemcode), 2000);
assert.ok(queries.every(query => query.values.length <= 100), 'No response can hit the default 1000-row cap');
function findClient(element) {
  if (!element || typeof element !== 'object') return null;
  if (element.type === StubClient) return element;
  for (const child of [element.props?.children].flat(Infinity)) { const found = findClient(child); if (found) return found; }
  return null;
}
for (const file of ['app/pallet-label/page.tsx', 'app/login/pallet-label/page.tsx']) {
  queries = [];
  const page = await load(new URL('../../' + file, import.meta.url).pathname).default();
  const props = findClient(page).props;
  assert.equal(props.rows[0].itemcode, target.itemcode); assert.equal(props.rows[0].quantity_per_pallet, 2000, `${file} gets a planned item's quantity beyond catalog row 1000`);
  assert.ok(queries.filter(q => q.table === 'item_pallet_config').every(q => q.values?.includes(target.itemcode)));
}
const { GET } = load(new URL('../../app/api/pallet-label/quantity/route.ts', import.meta.url).pathname);
const { POST } = load(new URL('../../app/api/pallet-label/create/route.ts', import.meta.url).pathname);
const request = code => new Request('http://localhost/api/pallet-label/quantity?' + new URLSearchParams({ itemcode: code }));
const post = body => new Request('http://localhost/api/pallet-label/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let response = await GET(request(` ${target.itemcode} `));
assert.equal((await response.json()).quantity_per_pallet, 2000); assert.equal(response.headers.get('Cache-Control'), 'no-store');
assert.equal((await (await GET(request('MISSING'))).json()).quantity_per_pallet, null);
allowed = false; assert.equal((await GET(request(target.itemcode))).status, 403); allowed = true;
assert.equal((await GET(request(''))).status, 400);
const full = { itemcode: target.itemcode, wo: 'WO-1', quantity: 2000, quantity_per_pallet: 123, even_pallet: true };
calls = []; response = await POST(post(full)); assert.equal(response.status, 200);
assert.equal(calls[0].args.p_quantity, 2000); assert.equal(calls[0].args.p_even_pallet, true);
target.quantity_per_pallet = 3000; calls = [];
response = await POST(post(full)); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PALLET_QUANTITY_CHANGED'); assert.equal(calls.length, 0);
target.quantity_per_pallet = null;
response = await POST(post(full)); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PALLET_QUANTITY_MISSING');
databaseError = { message: 'offline' };
const log = console.error; console.error = () => {};
assert.equal((await GET(request(target.itemcode))).status, 503); console.error = log;
assert.equal((await POST(post(full))).status, 503); assert.equal(calls.length, 0);
assert.equal((await POST(post({ ...full, even_pallet: false, quantity: 35 }))).status, 200, 'Deliberate partial-pallet entry remains independent of a config read');
assert.equal(calls[0].args.p_even_pallet, false);
databaseError = null; target.quantity_per_pallet = 3000;
pallets = [{ pallet_id: 'OLD-001', itemcode: target.itemcode, wo: 'OLD', quantity: 77, even_pallet: true, product_name: 'Name', customer: 'Customer', machine: 'M1', quanorder: 10000, status: 'production', effect_to: null, note: null, created_at: '2026-11-18' }];
const oldWo = load(new URL('../../app/api/pallet-label/old-wo/route.ts', import.meta.url).pathname);
response = await oldWo.GET(new Request('http://localhost/api/pallet-label/old-wo?wo=OLD'));
assert.equal((await response.json()).workOrder.quantity_per_pallet, 3000, 'Compensation print uses the current config, not an old even pallet quantity');
console.log('PASS: reproduce/fix >1000 catalog truncation in both pages, exact uncached lookup, current full-pallet validation/stale rejection, old-WO config priority and preserved partial printing.');
