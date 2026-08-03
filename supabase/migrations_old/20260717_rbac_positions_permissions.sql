-- RBAC migration for QRpallet.
-- This migration intentionally converts legacy enum-backed profile columns to text
-- before introducing the new role/position values. It temporarily removes existing
-- public-schema RLS policies because PostgreSQL blocks ALTER COLUMN TYPE when a policy
-- depends directly or indirectly on profiles.role or profiles.position.

begin;

-- 0. Preserve and temporarily remove every existing policy in schema public.
-- All definitions are restored after role/position conversion in the same transaction.
create temporary table _saved_public_policies (
  schema_name text not null,
  table_name text not null,
  policy_name text not null,
  create_sql text not null
) on commit drop;

do $$
declare
  policy_record record;
  command_name text;
  role_list text;
  using_clause text;
  check_clause text;
begin
  for policy_record in
    select
      n.nspname as schema_name,
      c.relname as table_name,
      p.polname as policy_name,
      p.polpermissive,
      p.polcmd,
      p.polroles,
      pg_get_expr(p.polqual, p.polrelid) as using_expression,
      pg_get_expr(p.polwithcheck, p.polrelid) as check_expression
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  loop
    command_name := case policy_record.polcmd
      when 'r' then 'SELECT'
      when 'a' then 'INSERT'
      when 'w' then 'UPDATE'
      when 'd' then 'DELETE'
      else 'ALL'
    end;

    select string_agg(
      case when role_oid = 0 then 'public' else quote_ident(pg_get_userbyid(role_oid)) end,
      ', '
    )
    into role_list
    from unnest(policy_record.polroles) as role_oid;

    if role_list is null or role_list = '' then
      role_list := 'public';
    end if;

    using_clause := case
      when policy_record.using_expression is null then ''
      else format(' USING (%s)', policy_record.using_expression)
    end;

    check_clause := case
      when policy_record.check_expression is null then ''
      else format(' WITH CHECK (%s)', policy_record.check_expression)
    end;

    insert into _saved_public_policies (
      schema_name,
      table_name,
      policy_name,
      create_sql
    ) values (
      policy_record.schema_name,
      policy_record.table_name,
      policy_record.policy_name,
      format(
        'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
        policy_record.policy_name,
        policy_record.schema_name,
        policy_record.table_name,
        case when policy_record.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
        command_name,
        role_list,
        using_clause,
        check_clause
      )
    );

    execute format(
      'DROP POLICY %I ON %I.%I',
      policy_record.policy_name,
      policy_record.schema_name,
      policy_record.table_name
    );
  end loop;
end
$$;

-- 1. Normalize legacy roles and positions while preserving existing profiles.
alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  drop constraint if exists profiles_position_check;

-- Enum defaults can block ALTER COLUMN TYPE, so remove them first.
alter table public.profiles
  alter column role drop default;
alter table public.profiles
  alter column position drop default;

-- Convert enum or varchar columns to text. USING ...::text works for both.
alter table public.profiles
  alter column role type text using role::text;
alter table public.profiles
  alter column position type text using position::text;

update public.profiles
set role = 'admin'
where role is null
   or role not in ('superadmin', 'admin', 'user');

update public.profiles
set position = case position
  when 'planning' then 'planning'
  when 'pallet' then 'production'
  when 'scanner' then 'warehouse'
  when 'warehouse' then 'production'
  when 'production' then 'production'
  else position
end;

-- Existing global admins are promoted so they keep their previous global access.
update public.profiles
set role = 'superadmin', position = null
where role = 'admin' and position is null;

alter table public.profiles
  alter column role set default 'user';

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('superadmin', 'admin', 'user'));

alter table public.profiles
  add constraint profiles_position_check
  check (position is null or position in ('planning', 'production', 'warehouse'));

-- Restore all policies that existed before the column conversion.
do $$
declare
  saved_policy record;
begin
  for saved_policy in
    select create_sql
    from _saved_public_policies
    order by schema_name, table_name, policy_name
  loop
    execute saved_policy.create_sql;
  end loop;
end
$$;

-- 2. Permission catalog.
create table if not exists public.permissions (
  permission_key text primary key,
  module text not null,
  description text not null,
  created_at timestamptz not null default now()
);

insert into public.permissions (permission_key, module, description) values
  ('planning.upload', 'planning', 'Upload/replace Planning Inject data'),
  ('planning.change', 'planning', 'Change Planning Inject data'),
  ('pallet.create', 'production', 'Create and print pallet labels'),
  ('pallet.edit', 'production', 'Edit, cancel, merge or reprint pallet labels'),
  ('scan.standard', 'warehouse', 'Scan, cancel and confirm scanned pallets'),
  ('receipt.create', 'production', 'Create warehouse receipts'),
  ('receipt.edit', 'production', 'Edit, cancel and reprint warehouse receipts')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

-- 3. Explicit permissions. New users intentionally receive no rows.
create table if not exists public.user_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.permissions(permission_key) on delete cascade,
  granted_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);
create index if not exists user_permissions_permission_key_idx
  on public.user_permissions(permission_key);

-- 4. Configurable position-to-page mapping.
create table if not exists public.position_page_access (
  position text not null check (position in ('planning', 'production', 'warehouse')),
  path text not null,
  is_enabled boolean not null default true,
  updated_by uuid null references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (position, path)
);

insert into public.position_page_access (position, path, is_enabled) values
  ('planning', '/planning-inject', true),
  ('production', '/pallet-label', true),
  ('production', '/warehouse-receipt', true),
  ('warehouse', '/scan-qr', true)
on conflict (position, path) do nothing;

-- 5. Helpers used by RLS and RPCs.
create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active = true
$$;

create or replace function public.current_profile_position()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select position from public.profiles where id = auth.uid() and is_active = true
$$;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when p.role = 'superadmin' then true
      when p.role = 'admin' then
        (p.position = 'planning' and p_permission in ('planning.upload', 'planning.change'))
        or (p.position = 'production' and p_permission in ('pallet.create', 'pallet.edit', 'receipt.create', 'receipt.edit'))
        or (p.position = 'warehouse' and p_permission = 'scan.standard')
      else exists (
        select 1 from public.user_permissions up
        where up.user_id = p.id and up.permission_key = p_permission
      )
    end
    from public.profiles p
    where p.id = auth.uid() and p.is_active = true
  ), false)
$$;

-- 6. RLS. Service-role requests continue to bypass RLS.
alter table public.permissions enable row level security;
alter table public.user_permissions enable row level security;
alter table public.position_page_access enable row level security;

drop policy if exists permissions_read_authenticated on public.permissions;
create policy permissions_read_authenticated on public.permissions
for select to authenticated using (true);

drop policy if exists user_permissions_read_scope on public.user_permissions;
create policy user_permissions_read_scope on public.user_permissions
for select to authenticated using (
  user_id = auth.uid()
  or public.current_profile_role() = 'superadmin'
  or (
    public.current_profile_role() = 'admin'
    and exists (
      select 1 from public.profiles target
      where target.id = user_permissions.user_id
        and target.role = 'user'
        and target.position = public.current_profile_position()
    )
  )
);

drop policy if exists user_permissions_manage_scope on public.user_permissions;
create policy user_permissions_manage_scope on public.user_permissions
for all to authenticated
using (
  public.current_profile_role() = 'superadmin'
  or (
    public.current_profile_role() = 'admin'
    and exists (
      select 1 from public.profiles target
      where target.id = user_permissions.user_id
        and target.role = 'user'
        and target.position = public.current_profile_position()
    )
  )
)
with check (
  public.current_profile_role() = 'superadmin'
  or (
    public.current_profile_role() = 'admin'
    and exists (
      select 1 from public.profiles target
      where target.id = user_permissions.user_id
        and target.role = 'user'
        and target.position = public.current_profile_position()
    )
  )
);

drop policy if exists position_page_access_read on public.position_page_access;
create policy position_page_access_read on public.position_page_access
for select to authenticated using (true);

drop policy if exists position_page_access_superadmin_manage on public.position_page_access;
create policy position_page_access_superadmin_manage on public.position_page_access
for all to authenticated
using (public.current_profile_role() = 'superadmin')
with check (public.current_profile_role() = 'superadmin');

commit;
