import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
let actor = { id: 'wh-admin', role: 'admin', position: 'warehouse', is_active: true, permissions: [] };
const targets = new Map([
  ['wh-user', { id: 'wh-user', role: 'user', position: 'warehouse' }],
  ['planning-user', { id: 'planning-user', role: 'user', position: 'planning' }],
  ['wh-admin', actor], ['other-admin', { id: 'other-admin', role: 'admin', position: 'warehouse' }],
]);
const grants = new Map([['wh-user', new Set(['dashboard.view', 'receipt.view'])]]);
const changes = [];
const admin = { from(table) {
  let id;
  const builder = {
    select: () => builder, eq: (key, value) => { assert.equal(key, table === 'profiles' ? 'id' : 'user_id'); id = value; return builder; },
    maybeSingle: async () => ({ data: targets.get(id) ?? null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: [...(grants.get(id) ?? [])].map(permission_key => ({ permission_key })), error: null }).then(resolve, reject),
    insert: async rows => { for (const row of rows) { const set = grants.get(row.user_id) ?? new Set(); set.add(row.permission_key); grants.set(row.user_id, set); changes.push(row); } return { error: null }; },
    delete: () => builder,
    in: async (key, values) => { assert.equal(key, 'permission_key'); for (const value of values) grants.get(id)?.delete(value); return { error: null }; },
  };
  return builder;
} };
const mocks = {
  '@/lib/auth': { requireAdmin: async () => { if (!actor.is_active || !['admin', 'superadmin'].includes(actor.role)) throw Error('Denied'); return actor; } },
  '@/lib/supabase/admin': { createAdminClient: () => admin }, '@/lib/supabase/server': { createClient: async () => ({}) },
  'next/navigation': { redirect: () => { throw Error('redirect'); } }, 'next/cache': { revalidatePath: () => {} },
};
function load(file) {
  const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = id => mocks[id] ?? (id.startsWith('@/') ? load(new URL('../../' + id.slice(2) + '.ts', import.meta.url).pathname) : require(id));
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports;
}
const { hasPermission } = load(new URL('../../lib/auth.ts', import.meta.url).pathname);
const { POSITION_GRANTABLE_PERMISSIONS } = load(new URL('../../lib/routes.ts', import.meta.url).pathname);
for (const permission of ['view-WH', 'edit-WH']) {
  assert.equal(hasPermission(actor, permission), true, 'Warehouse admin role grants work without user_permissions');
  for (const position of ['planning', 'production']) assert.equal(hasPermission({ ...actor, position }, permission), false);
  assert.equal(hasPermission({ ...actor, role: 'user' }, permission), false, 'Warehouse users still need explicit grants');
  assert.equal(hasPermission({ ...actor, role: 'user', permissions: [permission] }, permission), true);
  assert.equal(hasPermission({ ...actor, position: 'planning', permissions: [permission] }, permission), true, 'Super Admin explicit extra grants remain supported');
  assert.ok(POSITION_GRANTABLE_PERMISSIONS.warehouse.includes(permission));
  assert.ok(!POSITION_GRANTABLE_PERMISSIONS.planning.includes(permission));
}
assert.equal(new Set(POSITION_GRANTABLE_PERMISSIONS.warehouse).size, POSITION_GRANTABLE_PERMISSIONS.warehouse.length);
const { updateUserPermissions } = load(new URL('../../app/admin/actions.ts', import.meta.url).pathname);
const save = async (id, permissions) => {
  const form = new FormData(); form.set('user_id', id); for (const permission of permissions) form.append('permissions', permission);
  return updateUserPermissions({ error: '', success: '' }, form);
};
assert.equal((await save('wh-user', ['edit-WH'])).error, '');
assert.deepEqual([...grants.get('wh-user')].sort(), ['dashboard.view', 'edit-WH', 'view-WH']);
assert.ok(changes.every(row => row.granted_by === 'wh-admin'));
await save('wh-user', ['view-WH']); assert.ok(!grants.get('wh-user').has('edit-WH')); assert.ok(grants.get('wh-user').has('dashboard.view'));
await save('wh-user', []); assert.deepEqual([...grants.get('wh-user')], ['dashboard.view'], 'Department admin preserves Super Admin dashboard grants');
for (const target of ['planning-user', 'wh-admin', 'other-admin']) assert.ok((await save(target, ['view-WH', 'edit-WH'])).error);
grants.set('wh-user', new Set()); await save('wh-user', ['view-WH', 'edit-WH', 'dashboard.view']);
assert.ok(!grants.get('wh-user').has('dashboard.view'), 'Warehouse admin cannot grant Dashboard');
actor = { ...actor, id: 'planning-admin', position: 'planning' };
await save('planning-user', ['view-WH', 'edit-WH']); assert.equal(grants.get('planning-user')?.size ?? 0, 0);
assert.ok((await save('wh-user', ['view-WH'])).error);
actor = { ...actor, role: 'user' }; await assert.rejects(save('planning-user', ['view-WH']), /Denied/);
actor = { ...actor, role: 'admin', is_active: false }; await assert.rejects(save('planning-user', ['view-WH']), /Denied/);
actor = { ...actor, role: 'superadmin', is_active: true };
assert.equal((await save('planning-user', ['edit-WH'])).error, ''); assert.ok(grants.get('planning-user').has('view-WH'));
console.log('PASS APP: Warehouse admin defaults, own-department grant/revoke, edit implies view, no self/other-admin/cross-department grant, preserved Dashboard restrictions and explicit Super Admin grants.');
