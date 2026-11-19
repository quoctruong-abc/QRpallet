import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
let allowed = true, calls = [], queryFields = '', error = null;
const rows = [
  { itemcode: 'ITEM-X', product_name: ' ', ERP_name: 'ERP fallback', customer: null, quantity_per_pallet: 50, updated_at: '2026-11-19' },
  { itemcode: 'ITEM', product_name: 'Production name', ERP_name: 'ERP name', customer: 'Old customer', quantity_per_pallet: 100, updated_at: '2026-11-19' },
];
const supabase = {
  from(table) {
    assert.equal(table, 'item_pallet_config');
    const builder = { select: fields => { queryFields = fields; return builder; }, ilike: () => builder, order: () => builder, limit: async () => ({ data: rows, error }) };
    return builder;
  },
  rpc: async (name, args) => {
    calls.push({ name, args });
    return { error, data: name === 'pallet_customer_options' ? { customers: ['Customer A', 'Customer B'] } : { itemcode: args.p_itemcode, quantity_per_pallet: args.p_quantity_per_pallet, customer: args.p_customer ?? 'Old customer', updated_at: '2026-11-19' } };
  },
};
const mocks = { '@/lib/auth': { authorizePermission: async key => { assert.equal(key, 'pallet.create'); return allowed ? { ok: true } : { ok: false, status: 403, error: 'Denied' }; } }, '@/lib/supabase/server': { createClient: async () => supabase } };
function load(file) {
  const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = id => mocks[id] ?? (id.startsWith('@/') ? load(new URL('../../' + id.slice(2) + '.ts', import.meta.url).pathname) : require(id));
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports;
}
const { GET, POST } = load(new URL('../../app/api/pallet-label/config/route.ts', import.meta.url).pathname);
const get = code => new Request('http://localhost/api/pallet-label/config?' + new URLSearchParams({ itemcode: code }));
const post = body => new Request('http://localhost/api/pallet-label/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
allowed = false;
assert.equal((await GET(get('ITEM'))).status, 403); assert.equal((await POST(post({ itemcode: 'ITEM', quantity_per_pallet: 200 }))).status, 403); assert.equal(calls.length, 0);
allowed = true;
assert.equal((await GET(get(''))).status, 400);
const response = await GET(get('ITEM')), result = await response.json();
assert.equal(response.status, 200); assert.equal(result.configs[0].itemcode, 'ITEM');
assert.equal(result.configs[0].product_name, 'Production name'); assert.equal(result.configs[1].product_name, 'ERP fallback');
assert.equal(result.configs[1].customer, ''); assert.deepEqual(result.customers, ['Customer A', 'Customer B']);
assert.ok(queryFields.includes('customer') && queryFields.includes('product_name'));
calls = [];
for (const body of [{ itemcode: '', quantity_per_pallet: 10 }, { itemcode: 'ITEM', quantity_per_pallet: 0 }, { itemcode: 'ITEM', quantity_per_pallet: 1.5 }, { itemcode: 'ITEM', quantity_per_pallet: 2147483648 }, { itemcode: 'ITEM', quantity_per_pallet: 10, customer: {} }, { itemcode: 'ITEM', quantity_per_pallet: 10, customer: null }]) assert.equal((await POST(post(body))).status, 400);
assert.equal(calls.length, 0);
assert.equal((await POST(post({ itemcode: 'ITEM', quantity_per_pallet: 200 }))).status, 200);
assert.deepEqual(calls.at(-1), { name: 'pallet_config_save', args: { p_itemcode: 'ITEM', p_quantity_per_pallet: 200 } }, 'Legacy quantity-only caller does not clear customer');
assert.equal((await POST(post({ itemcode: 'ITEM', quantity_per_pallet: 250, customer: ' Customer B ' }))).status, 200);
assert.deepEqual(calls.at(-1).args, { p_itemcode: 'ITEM', p_quantity_per_pallet: 250, p_customer: 'Customer B' });
for (const [message, status] of [['PALLET_CONFIG_UNKNOWN_CUSTOMER', 409], ['PALLET_CONFIG_CUSTOMER_REQUIRED', 400], ['PALLET_CONFIG_BUSY', 503], ['NOT_AUTHORIZED', 403]]) {
  error = { message }; assert.equal((await POST(post({ itemcode: 'ITEM', quantity_per_pallet: 200, customer: 'Customer A' }))).status, status);
}
console.log('PASS API: product/customer settings lookup, ERP fallback, pallet-source options, quantity-only compatibility, validated customer writes and safe permission/busy errors.');
