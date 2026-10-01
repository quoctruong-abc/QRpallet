begin;

-- Searchable warehouse-position catalog used by the Scan Pallet workflow.
create table if not exists public.warehouse_positions (
  code text primary key,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouse_positions_code_format_check
    check (code = upper(btrim(code)) and length(code) between 1 and 50),
  constraint warehouse_positions_name_check
    check (length(btrim(name)) between 1 and 160)
);

alter table public.warehouse_positions enable row level security;

revoke all on table public.warehouse_positions from public, anon, authenticated;
grant select on table public.warehouse_positions to service_role;

alter table public.pallet_data
  add column if not exists position text;

alter table public.pallet_data
  drop constraint if exists pallet_data_position_fkey;

alter table public.pallet_data
  add constraint pallet_data_position_fkey
  foreign key (position)
  references public.warehouse_positions(code)
  on update cascade
  on delete restrict;

create index if not exists pallet_data_active_position_idx
  on public.pallet_data(position)
  where effect_to is null and position is not null;

-- Sample locations for the first production test. They can be disabled or
-- replaced later without changing pallet history.
insert into public.warehouse_positions (code, name)
values
  ('A-01-01', 'Kho A - Dãy 01 - Ô 01'),
  ('A-01-02', 'Kho A - Dãy 01 - Ô 02'),
  ('A-01-03', 'Kho A - Dãy 01 - Ô 03'),
  ('A-02-01', 'Kho A - Dãy 02 - Ô 01'),
  ('A-02-02', 'Kho A - Dãy 02 - Ô 02'),
  ('A-02-03', 'Kho A - Dãy 02 - Ô 03'),
  ('B-01-01', 'Kho B - Dãy 01 - Ô 01'),
  ('B-01-02', 'Kho B - Dãy 01 - Ô 02'),
  ('B-01-03', 'Kho B - Dãy 01 - Ô 03'),
  ('QC-HOLD', 'Khu vực chờ kiểm tra chất lượng'),
  ('WH-TEMP', 'Khu vực kho tạm')
on conflict (code) do nothing;

-- A new scan always starts without a location. The user may assign one from
-- the popup after the scan succeeds.
create or replace function public.scan_pallet_to_pending(
  p_pallet_id text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pallet_data;
  v_pending_count integer;
  v_pallet_id text := trim(coalesce(p_pallet_id, ''));
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_pallet_id = '' or length(v_pallet_id) > 128 then
    raise exception 'INVALID_PALLET_ID';
  end if;

  select * into v_row
  from public.pallet_data
  where pallet_id = v_pallet_id
    and effect_to is null
  for update;

  if not found then
    raise exception 'PALLET_NOT_FOUND';
  end if;

  if v_row.status <> 'production' then
    raise exception 'INVALID_STATUS:%', v_row.status;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('SCAN_PENDING_' || auth.uid()::text)
  );

  select count(*)::integer
    into v_pending_count
  from public.pallet_data p
  where p.effect_to is null
    and p.status = 'pendingWH'
    and p.scanned_by = auth.uid();

  if v_pending_count >= 200 then
    raise exception 'MAX_SCAN_PALLETS';
  end if;

  update public.pallet_data
  set status = 'pendingWH',
      scanned_by = auth.uid(),
      scanned_at = now(),
      position = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- Position can only be attached to an active pending pallet owned by the
-- current scanner. Admins retain their existing cross-scanner capability.
create or replace function public.set_pending_pallet_position(
  p_pallet_id text,
  p_position text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pallet_data;
  v_pallet_id text := trim(coalesce(p_pallet_id, ''));
  v_position text := upper(trim(coalesce(p_position, '')));
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_pallet_id = '' or length(v_pallet_id) > 128 then
    raise exception 'INVALID_PALLET_ID';
  end if;

  if v_position = '' or length(v_position) > 50 then
    raise exception 'INVALID_POSITION';
  end if;

  if not exists (
    select 1
    from public.warehouse_positions wp
    where wp.code = v_position
      and wp.is_active = true
  ) then
    raise exception 'POSITION_NOT_FOUND';
  end if;

  update public.pallet_data
  set position = v_position,
      updated_at = now()
  where pallet_id = v_pallet_id
    and effect_to is null
    and status = 'pendingWH'
    and (public.is_admin() or scanned_by = auth.uid())
  returning * into v_row;

  if not found then
    raise exception 'PALLET_NOT_PENDING_OR_NOT_OWNER';
  end if;

  return v_row;
end;
$$;

-- Returning a scan to production clears the warehouse location together with
-- the scanner metadata, so a later scan cannot inherit stale row data.
create or replace function public.cancel_pending_pallet(
  p_pallet_id text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pallet_data;
  v_cancelled_at timestamptz := now();
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into v_row
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if v_row.status <> 'pendingWH' then
    raise exception 'INVALID_STATUS:%', v_row.status;
  end if;

  if not public.is_admin() and v_row.scanned_by is distinct from auth.uid() then
    raise exception 'NOT_SCAN_OWNER';
  end if;

  insert into public.pallet_change_history (
    pallet_data_id,
    pallet_id,
    change_type,
    scanned_by,
    scanned_at,
    cancelled_by,
    cancelled_at
  ) values (
    v_row.id,
    v_row.pallet_id,
    'scan_return',
    v_row.scanned_by,
    coalesce(v_row.scanned_at, v_row.updated_at, v_cancelled_at),
    auth.uid(),
    v_cancelled_at
  );

  update public.pallet_data
  set status = 'production',
      scanned_by = null,
      scanned_at = null,
      position = null,
      has_been_return = true,
      updated_at = v_cancelled_at
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.scan_pallet_to_pending(text) from public, anon;
grant execute on function public.scan_pallet_to_pending(text) to authenticated, service_role;

revoke all on function public.set_pending_pallet_position(text, text) from public, anon;
grant execute on function public.set_pending_pallet_position(text, text) to authenticated, service_role;

revoke all on function public.cancel_pending_pallet(text) from public, anon;
grant execute on function public.cancel_pending_pallet(text) to authenticated, service_role;

commit;
