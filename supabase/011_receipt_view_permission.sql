begin;

-- Replace the obsolete receipt.create / receipt.edit permissions with one
-- read-only module access permission: receipt.view.

-- Remove legacy CHECK constraints that enumerate permission keys, then recreate
-- one constraint containing the current permission set.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.user_permissions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%permission_key%'
  loop
    execute format(
      'alter table public.user_permissions drop constraint if exists %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.user_permissions
  add constraint user_permissions_permission_key_check
  check (permission_key in (
    'planning.upload',
    'planning.change',
    'pallet.create',
    'pallet.edit',
    'scan.standard',
    'receipt.view'
  ));

-- Keep one receipt.view row for every user that previously had either receipt
-- permission. ON CONFLICT assumes the existing unique key on user + permission.
insert into public.user_permissions (user_id, permission_key, granted_by)
select distinct
  user_id,
  'receipt.view',
  granted_by
from public.user_permissions
where permission_key in ('receipt.create', 'receipt.edit')
on conflict (user_id, permission_key) do nothing;

delete from public.user_permissions
where permission_key in ('receipt.create', 'receipt.edit');

-- Module 4 now belongs to Warehouse. Production no longer receives this route
-- or permission by default.
insert into public.position_page_access (position, path, is_enabled)
values
  ('warehouse', '/warehouse-receipt', true),
  ('production', '/warehouse-receipt', false)
on conflict (position, path)
do update set is_enabled = excluded.is_enabled;

commit;