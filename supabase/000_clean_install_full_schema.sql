-- QRpallet clean installation schema
-- WARNING: This file DROPS all application tables and application functions in public schema.
-- It keeps Supabase auth.users, then rebuilds public.profiles from existing Auth users.
-- Run the entire file once in Supabase SQL Editor.

begin;

-- =========================================================
-- 0. CLEAN OLD APPLICATION OBJECTS
-- =========================================================

drop trigger if exists on_auth_user_created on auth.users;

drop table if exists public.user_permissions cascade;
drop table if exists public.position_page_access cascade;
drop table if exists public.permissions cascade;
drop table if exists public.wh_receipt cascade;
drop table if exists public.pallet_data cascade;
drop table if exists public.item_pallet_config cascade;
drop table if exists public.planning_inject cascade;
drop table if exists public.profiles cascade;

drop function if exists public.handle_new_auth_user() cascade;
drop function if exists public.set_updated_at() cascade;
drop function if exists public.current_profile_role() cascade;
drop function if exists public.current_profile_position() cascade;
drop function if exists public.has_permission(text) cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.replace_planning_inject(jsonb,text) cascade;
drop function if exists public.create_pallet_record(text,text,text,text,numeric,text,integer) cascade;
drop function if exists public.create_pallet_record(text,text,text,text,numeric,text,integer,text) cascade;
drop function if exists public.edit_pallet_quantity(text,integer) cascade;
drop function if exists public.delete_pallet_record(text) cascade;
drop function if exists public.scan_pallet_to_pending(text) cascade;
drop function if exists public.cancel_pending_pallet(text) cascade;
drop function if exists public.confirm_pending_pallets(text[]) cascade;
drop function if exists public.cancel_processing_pallets(text[]) cascade;
drop function if exists public.create_warehouse_receipt(text[]) cascade;
drop function if exists public.cancel_warehouse_receipt(text) cascade;

drop type if exists public.app_role cascade;
drop type if exists public.app_position cascade;

-- =========================================================
-- 1. COMMON UPDATED_AT TRIGGER
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================
-- 2. PROFILES / AUTH
-- role: superadmin | admin | user
-- position: planning | production | warehouse
-- =========================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default 'New user',
  employee_code text unique,
  role text not null default 'user'
    check (role in ('superadmin','admin','user')),
  position text null
    check (position is null or position in ('planning','production','warehouse')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_role_position_check check (
    (role = 'superadmin' and position is null)
    or (role in ('admin','user') and position is not null)
  )
);

create index profiles_role_idx on public.profiles(role);
create index profiles_position_idx on public.profiles(position);
create index profiles_active_idx on public.profiles(is_active);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,email,full_name,employee_code,role,position,is_active
  ) values (
    new.id,
    coalesce(new.email, new.id::text || '@no-email.local'),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name',''),
      split_part(coalesce(new.email,'New user'),'@',1)
    ),
    nullif(new.raw_user_meta_data ->> 'employee_code',''),
    'user',
    'warehouse',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Backfill profiles for Auth users that already exist.
insert into public.profiles (
  id,email,full_name,employee_code,role,position,is_active
)
select
  u.id,
  coalesce(u.email, u.id::text || '@no-email.local'),
  coalesce(
    nullif(u.raw_user_meta_data ->> 'full_name',''),
    split_part(coalesce(u.email,'New user'),'@',1)
  ),
  nullif(u.raw_user_meta_data ->> 'employee_code',''),
  'user',
  'warehouse',
  true
from auth.users u
on conflict (id) do nothing;

-- =========================================================
-- 3. RBAC CATALOG
-- =========================================================

create table public.permissions (
  permission_key text primary key,
  module text not null,
  description text not null,
  created_at timestamptz not null default now()
);

insert into public.permissions (permission_key,module,description) values
  ('planning.upload','planning','Upload or replace Planning Inject data'),
  ('planning.change','planning','Change Planning Inject data'),
  ('pallet.create','production','Create and print pallet labels'),
  ('pallet.edit','production','Edit, delete, merge and reprint pallet labels'),
  ('scan.standard','warehouse','Scan, cancel and confirm scanned pallets'),
  ('receipt.create','production','Create warehouse receipts'),
  ('receipt.edit','production','Cancel and reprint warehouse receipts');

create table public.user_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.permissions(permission_key) on delete cascade,
  granted_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id,permission_key)
);

create index user_permissions_permission_key_idx
  on public.user_permissions(permission_key);

create table public.position_page_access (
  position text not null
    check (position in ('planning','production','warehouse')),
  path text not null,
  is_enabled boolean not null default true,
  updated_by uuid null references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (position,path)
);

insert into public.position_page_access (position,path,is_enabled) values
  ('planning','/planning-inject',true),
  ('production','/pallet-label',true),
  ('production','/warehouse-receipt',true),
  ('warehouse','/scan-qr',true);

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.is_active = true
$$;

create or replace function public.current_profile_position()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.position
  from public.profiles p
  where p.id = auth.uid() and p.is_active = true
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
        (p.position = 'planning' and p_permission in ('planning.upload','planning.change'))
        or (p.position = 'production' and p_permission in ('pallet.create','pallet.edit','receipt.create','receipt.edit'))
        or (p.position = 'warehouse' and p_permission = 'scan.standard')
      else exists (
        select 1
        from public.user_permissions up
        where up.user_id = p.id
          and up.permission_key = p_permission
      )
    end
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active = true
  ),false)
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_profile_role() in ('superadmin','admin'),false)
$$;

-- =========================================================
-- 4. PLANNING INJECT
-- =========================================================

create table public.planning_inject (
  id bigint generated by default as identity primary key,
  machine text,
  itemcode text,
  product_name text,
  customer text,
  wo text,
  netweight numeric,
  quanperh numeric,
  quanperday numeric,
  color text,
  material text,
  package text,
  quanorder numeric,
  source_file text,
  imported_by uuid null references auth.users(id) on delete set null,
  imported_at timestamptz not null default now()
);

create index planning_inject_machine_idx on public.planning_inject(machine);
create index planning_inject_wo_idx on public.planning_inject(wo);
create index planning_inject_itemcode_idx on public.planning_inject(itemcode);

create or replace function public.replace_planning_inject(
  p_rows jsonb,
  p_source_file text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if not public.has_permission('planning.upload') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  truncate table public.planning_inject restart identity;

  insert into public.planning_inject (
    machine,itemcode,product_name,customer,wo,netweight,quanperh,quanperday,
    color,material,package,quanorder,source_file,imported_by,imported_at
  )
  select
    x.machine,x.itemcode,x.product_name,x.customer,x.wo,x.netweight,x.quanperh,x.quanperday,
    x.color,x.material,x.package,x.quanorder,p_source_file,auth.uid(),now()
  from jsonb_to_recordset(p_rows) as x(
    machine text,itemcode text,product_name text,customer text,wo text,
    netweight numeric,quanperh numeric,quanperday numeric,color text,
    material text,package text,quanorder numeric
  );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

-- =========================================================
-- 5. PALLET LABEL / PALLET DATA
-- =========================================================

create table public.item_pallet_config (
  itemcode text primary key,
  quantity_per_pallet integer not null check (quantity_per_pallet > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger item_pallet_config_set_updated_at
before update on public.item_pallet_config
for each row execute function public.set_updated_at();

create table public.pallet_data (
  id bigint generated by default as identity primary key,
  pallet_id text not null,
  itemcode text not null,
  product_name text,
  customer text,
  wo text not null,
  quanorder numeric,
  machine text,
  quantity integer not null check (quantity > 0),
  status text not null default 'production'
    check (status in ('production','pendingWH','processingWH','WHdone')),
  effect_to timestamptz null,
  note text null,
  wh_receipt text null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index pallet_data_active_pallet_id_uidx
  on public.pallet_data(pallet_id)
  where effect_to is null;
create index pallet_data_wo_idx on public.pallet_data(wo);
create index pallet_data_itemcode_idx on public.pallet_data(itemcode);
create index pallet_data_machine_idx on public.pallet_data(machine);
create index pallet_data_status_idx on public.pallet_data(status);
create index pallet_data_receipt_idx on public.pallet_data(wh_receipt);

create trigger pallet_data_set_updated_at
before update on public.pallet_data
for each row execute function public.set_updated_at();

create or replace function public.create_pallet_record(
  p_itemcode text,
  p_product_name text,
  p_customer text,
  p_wo text,
  p_quanorder numeric,
  p_machine text,
  p_quantity integer,
  p_note text default null
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  next_number integer;
  new_pallet_id text;
  new_row public.pallet_data;
begin
  if not public.has_permission('pallet.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(trim(p_wo),'') = '' then raise exception 'WO_REQUIRED'; end if;
  if coalesce(trim(p_itemcode),'') = '' then raise exception 'ITEMCODE_REQUIRED'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  perform pg_advisory_xact_lock(hashtext(p_wo));

  select coalesce(max((regexp_match(pallet_id,'-([0-9]+)$'))[1]::integer),0) + 1
  into next_number
  from public.pallet_data
  where wo = p_wo;

  new_pallet_id := p_wo || '-' || lpad(next_number::text,3,'0');

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,
    quantity,status,note,created_by
  ) values (
    new_pallet_id,p_itemcode,p_product_name,p_customer,p_wo,p_quanorder,p_machine,
    p_quantity,'production',p_note,auth.uid()
  ) returning * into new_row;

  return new_row;
end;
$$;

create or replace function public.edit_pallet_quantity(
  p_pallet_id text,
  p_quantity integer
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.pallet_data;
  new_row public.pallet_data;
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select * into current_row
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if current_row.status <> 'production' then
    raise exception 'INVALID_STATUS:%',current_row.status;
  end if;

  update public.pallet_data
  set effect_to = now(), note = concat_ws(' | ',note,'edit old quantity=' || quantity)
  where id = current_row.id;

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,
    quantity,status,effect_to,note,wh_receipt,created_by,created_at
  ) values (
    current_row.pallet_id,current_row.itemcode,current_row.product_name,current_row.customer,
    current_row.wo,current_row.quanorder,current_row.machine,p_quantity,current_row.status,
    null,concat_ws(' | ',current_row.note,'edit new quantity=' || p_quantity),
    current_row.wh_receipt,auth.uid(),now()
  ) returning * into new_row;

  return new_row;
end;
$$;

create or replace function public.delete_pallet_record(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_row public.pallet_data;
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into deleted_row
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if deleted_row.status <> 'production' then
    raise exception 'INVALID_STATUS:%',deleted_row.status;
  end if;

  update public.pallet_data
  set effect_to = now(), note = concat_ws(' | ',note,'delete')
  where id = deleted_row.id
  returning * into deleted_row;

  return deleted_row;
end;
$$;

-- =========================================================
-- 6. SCAN QR STATUS FLOW
-- production -> pendingWH -> processingWH -> WHdone
-- =========================================================

create or replace function public.scan_pallet_to_pending(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.pallet_data;
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into row_data
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if row_data.status <> 'production' then
    raise exception 'INVALID_STATUS:%',row_data.status;
  end if;

  update public.pallet_data
  set status = 'pendingWH'
  where id = row_data.id
  returning * into row_data;

  return row_data;
end;
$$;

create or replace function public.cancel_pending_pallet(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.pallet_data;
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into row_data
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if row_data.status <> 'pendingWH' then
    raise exception 'INVALID_STATUS:%',row_data.status;
  end if;

  update public.pallet_data
  set status = 'production'
  where id = row_data.id
  returning * into row_data;

  return row_data;
end;
$$;

create or replace function public.confirm_pending_pallets(p_pallet_ids text[])
returns setof public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_count integer;
  matched_count integer;
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  expected_count := coalesce(array_length(p_pallet_ids,1),0);
  if expected_count = 0 then raise exception 'EMPTY_LIST'; end if;

  select count(*) into matched_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH'
  for update;

  if matched_count <> expected_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH'
  returning *;
end;
$$;

-- =========================================================
-- 7. WAREHOUSE RECEIPT
-- =========================================================

create table public.wh_receipt (
  receipt_id text primary key,
  receipt_date date not null default current_date,
  total_pallet integer not null check (total_pallet > 0),
  total_quantity bigint not null check (total_quantity > 0),
  uid_user uuid null references auth.users(id) on delete set null,
  status text not null default 'active'
    check (status in ('active','cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz null,
  cancelled_by uuid null references auth.users(id) on delete set null
);

create index wh_receipt_date_idx on public.wh_receipt(receipt_date desc);
create index wh_receipt_status_idx on public.wh_receipt(status);

alter table public.pallet_data
  add constraint pallet_data_wh_receipt_fk
  foreign key (wh_receipt)
  references public.wh_receipt(receipt_id)
  on delete set null;

create or replace function public.cancel_processing_pallets(p_pallet_ids text[])
returns setof public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_count integer;
  matched_count integer;
begin
  if not public.has_permission('receipt.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  expected_count := coalesce(array_length(p_pallet_ids,1),0);
  if expected_count = 0 then raise exception 'EMPTY_LIST'; end if;

  select count(*) into matched_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH'
  for update;

  if matched_count <> expected_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'production', wh_receipt = null
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH'
  returning *;
end;
$$;

create or replace function public.create_warehouse_receipt(p_pallet_ids text[])
returns table (
  receipt_id text,
  receipt_date date,
  total_pallet integer,
  total_quantity bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_count integer;
  matched_count integer;
  quantity_sum bigint;
  next_number integer;
  new_receipt_id text;
begin
  if not public.has_permission('receipt.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  expected_count := coalesce(array_length(p_pallet_ids,1),0);
  if expected_count = 0 then raise exception 'EMPTY_LIST'; end if;

  select count(*),coalesce(sum(quantity),0)::bigint
  into matched_count,quantity_sum
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH'
  for update;

  if matched_count <> expected_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  perform pg_advisory_xact_lock(hashtext('WH-' || to_char(current_date,'DDMMYY')));

  select coalesce(max((regexp_match(receipt_id,'-([0-9]+)$'))[1]::integer),0) + 1
  into next_number
  from public.wh_receipt
  where receipt_date = current_date;

  new_receipt_id := 'WH-' || to_char(current_date,'DDMMYY') || '-' || lpad(next_number::text,3,'0');

  insert into public.wh_receipt (
    receipt_id,receipt_date,total_pallet,total_quantity,uid_user,status
  ) values (
    new_receipt_id,current_date,matched_count,quantity_sum,auth.uid(),'active'
  );

  update public.pallet_data
  set status = 'WHdone', wh_receipt = new_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  return query
  select new_receipt_id,current_date,matched_count,quantity_sum;
end;
$$;

create or replace function public.cancel_warehouse_receipt(p_receipt_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_receipt public.wh_receipt;
  pallet_count integer;
begin
  if not public.has_permission('receipt.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into target_receipt
  from public.wh_receipt
  where receipt_id = p_receipt_id
  for update;

  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if target_receipt.status = 'cancelled' then
    raise exception 'RECEIPT_ALREADY_CANCELLED';
  end if;

  update public.pallet_data
  set status = 'production', wh_receipt = null
  where wh_receipt = p_receipt_id
    and effect_to is null
    and status = 'WHdone';

  get diagnostics pallet_count = row_count;

  update public.wh_receipt
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where receipt_id = p_receipt_id;

  return pallet_count;
end;
$$;

-- =========================================================
-- 8. ROW LEVEL SECURITY
-- Service-role calls bypass RLS.
-- All writes from authenticated clients use SECURITY DEFINER RPCs.
-- =========================================================

alter table public.profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.user_permissions enable row level security;
alter table public.position_page_access enable row level security;
alter table public.planning_inject enable row level security;
alter table public.item_pallet_config enable row level security;
alter table public.pallet_data enable row level security;
alter table public.wh_receipt enable row level security;

create policy profiles_select_scope on public.profiles
for select to authenticated
using (
  id = auth.uid()
  or public.current_profile_role() = 'superadmin'
  or (
    public.current_profile_role() = 'admin'
    and role = 'user'
    and position = public.current_profile_position()
  )
);

create policy permissions_read_authenticated on public.permissions
for select to authenticated using (true);

create policy user_permissions_read_scope on public.user_permissions
for select to authenticated
using (
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

create policy position_page_access_read on public.position_page_access
for select to authenticated using (true);

create policy position_page_access_superadmin_manage on public.position_page_access
for all to authenticated
using (public.current_profile_role() = 'superadmin')
with check (public.current_profile_role() = 'superadmin');

create policy planning_inject_select_authorized on public.planning_inject
for select to authenticated
using (
  public.has_permission('planning.upload')
  or public.has_permission('planning.change')
  or public.has_permission('pallet.create')
  or public.has_permission('pallet.edit')
);

create policy item_pallet_config_select_authorized on public.item_pallet_config
for select to authenticated
using (
  public.has_permission('pallet.create')
  or public.has_permission('pallet.edit')
);

create policy pallet_data_select_authorized on public.pallet_data
for select to authenticated
using (
  public.has_permission('pallet.create')
  or public.has_permission('pallet.edit')
  or public.has_permission('scan.standard')
  or public.has_permission('receipt.create')
  or public.has_permission('receipt.edit')
);

create policy wh_receipt_select_authorized on public.wh_receipt
for select to authenticated
using (
  public.has_permission('receipt.create')
  or public.has_permission('receipt.edit')
);

-- =========================================================
-- 9. GRANTS
-- =========================================================

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

revoke all on public.profiles from authenticated;
revoke all on public.permissions from authenticated;
revoke all on public.user_permissions from authenticated;
revoke all on public.position_page_access from authenticated;
revoke all on public.planning_inject from authenticated;
revoke all on public.item_pallet_config from authenticated;
revoke all on public.pallet_data from authenticated;
revoke all on public.wh_receipt from authenticated;

grant select on public.profiles to authenticated;
grant select on public.permissions to authenticated;
grant select,insert,update,delete on public.user_permissions to authenticated;
grant select,insert,update,delete on public.position_page_access to authenticated;
grant select on public.planning_inject to authenticated;
grant select on public.item_pallet_config to authenticated;
grant select on public.pallet_data to authenticated;
grant select on public.wh_receipt to authenticated;

grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.current_profile_position() to authenticated;
grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.replace_planning_inject(jsonb,text) to authenticated;
grant execute on function public.create_pallet_record(text,text,text,text,numeric,text,integer,text) to authenticated;
grant execute on function public.edit_pallet_quantity(text,integer) to authenticated;
grant execute on function public.delete_pallet_record(text) to authenticated;
grant execute on function public.scan_pallet_to_pending(text) to authenticated;
grant execute on function public.cancel_pending_pallet(text) to authenticated;
grant execute on function public.confirm_pending_pallets(text[]) to authenticated;
grant execute on function public.cancel_processing_pallets(text[]) to authenticated;
grant execute on function public.create_warehouse_receipt(text[]) to authenticated;
grant execute on function public.cancel_warehouse_receipt(text) to authenticated;

commit;

-- =========================================================
-- AFTER RUNNING THIS FILE
-- =========================================================
-- Existing Supabase Auth users are recreated in public.profiles as:
-- role=user, position=warehouse, no explicit permissions.
-- Promote your first superadmin by replacing the email below:
--
-- update public.profiles
-- set role='superadmin', position=null, is_active=true
-- where email='YOUR_EMAIL';
--
-- Optional item pallet configuration example:
-- insert into public.item_pallet_config(itemcode,quantity_per_pallet)
-- values ('ITEM001',1000)
-- on conflict(itemcode) do update
-- set quantity_per_pallet=excluded.quantity_per_pallet;
