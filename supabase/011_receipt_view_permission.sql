begin;

-- Replace the obsolete receipt.create / receipt.edit permissions with one
-- read-only module access permission: receipt.view.

-- Remove legacy CHECK constraints that enumerate permission keys before
-- migrating existing rows.
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

-- user_permissions.permission_key has a foreign key to public.permissions.
-- Clone one existing receipt permission so every required metadata column is
-- preserved, then replace its key and common display fields.
insert into public.permissions
select (
  jsonb_populate_record(
    null::public.permissions,
    to_jsonb(source_permission)
      || jsonb_build_object(
        'permission_key', 'receipt.view',
        'label', 'Xem phiếu nhập kho',
        'name', 'Xem phiếu nhập kho',
        'description', 'Truy cập module 4 để xem và in lại phiếu nhập kho'
      )
  )
).*
from public.permissions source_permission
where source_permission.permission_key in ('receipt.create', 'receipt.edit')
order by case when source_permission.permission_key = 'receipt.create' then 1 else 2 end
limit 1
on conflict (permission_key) do nothing;

-- Fail with a clear message if the permission catalog did not contain either
-- legacy receipt permission to clone.
do $$
begin
  if not exists (
    select 1 from public.permissions where permission_key = 'receipt.view'
  ) then
    raise exception 'Cannot create receipt.view: receipt.create/receipt.edit not found in public.permissions';
  end if;
end;
$$;

-- Keep one receipt.view row for every user that previously had either receipt
-- permission. ON CONFLICT uses the existing unique key on user + permission.
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

-- Legacy catalog rows are no longer used after all user assignments are moved.
delete from public.permissions
where permission_key in ('receipt.create', 'receipt.edit');

-- Add the current permission-key constraint only after legacy rows are removed.
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

-- Module 4 now belongs to Warehouse. Production no longer receives this route
-- or permission by default.
insert into public.position_page_access (position, path, is_enabled)
values
  ('warehouse', '/warehouse-receipt', true),
  ('production', '/warehouse-receipt', false)
on conflict (position, path)
do update set is_enabled = excluded.is_enabled;

commit;
