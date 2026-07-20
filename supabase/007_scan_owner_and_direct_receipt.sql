begin;

alter table public.pallet_data
  add column if not exists scanned_by uuid references auth.users(id);

-- Some existing databases were created before wh_receipt.user_id was added.
-- Keep this migration repeatable so the direct scan confirmation can record
-- who created the warehouse receipt.
alter table public.wh_receipt
  add column if not exists user_id uuid references auth.users(id);

create index if not exists pallet_data_scanned_by_status_idx
  on public.pallet_data(scanned_by, status)
  where effect_to is null;

create index if not exists wh_receipt_user_id_idx
  on public.wh_receipt(user_id);

create or replace function public.scan_pallet_to_pending(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.pallet_data;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'warehouse'
  ) then raise exception 'Not authorized'; end if;

  update public.pallet_data
  set status = 'pendingWH', scanned_by = auth.uid()
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
    and status = 'production'
  returning * into v_row;

  if found then return v_row; end if;

  select * into v_row from public.pallet_data
  where pallet_id = trim(p_pallet_id) and effect_to is null;
  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  raise exception 'INVALID_STATUS:%', v_row.status;
end;
$$;

create or replace function public.cancel_pending_pallet(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.pallet_data;
begin
  select * into v_row from public.pallet_data
  where pallet_id = trim(p_pallet_id) and effect_to is null;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if v_row.status <> 'pendingWH' then raise exception 'INVALID_STATUS:%', v_row.status; end if;
  if not public.is_admin() and v_row.scanned_by is distinct from auth.uid() then
    raise exception 'NOT_SCAN_OWNER';
  end if;

  update public.pallet_data
  set status = 'production', scanned_by = null
  where pallet_id = v_row.pallet_id and effect_to is null
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.create_warehouse_receipt_from_scan(p_pallet_ids text[])
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
  v_date date := current_date;
  v_order integer;
  v_receipt_id text;
  v_total_pallet integer;
  v_total_quantity bigint;
begin
  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'warehouse'
  ) then raise exception 'Not authorized'; end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) x(pallet_id)
    left join public.pallet_data p
      on p.pallet_id = x.pallet_id and p.effect_to is null
    where p.pallet_id is null
       or p.status <> 'pendingWH'
       or (not public.is_admin() and p.scanned_by is distinct from auth.uid())
  ) then raise exception 'PALLET_STATUS_CHANGED_OR_NOT_OWNER'; end if;

  perform pg_advisory_xact_lock(hashtext('WH_RECEIPT_' || to_char(v_date, 'YYYYMMDD')));

  select count(*)::integer, coalesce(sum(quantity), 0)::bigint
    into v_total_pallet, v_total_quantity
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  select coalesce(max((regexp_match(w.receipt_id, '-([0-9]+)$'))[1]::integer), 0) + 1
    into v_order
  from public.wh_receipt w
  where w.receipt_date = v_date;

  v_receipt_id := 'WH-' || to_char(v_date, 'DDMMYY') || '-' || lpad(v_order::text, 3, '0');

  insert into public.wh_receipt(receipt_id, receipt_date, total_pallet, total_quantity, user_id)
  values (v_receipt_id, v_date, v_total_pallet, v_total_quantity, auth.uid());

  update public.pallet_data
  set status = 'WHdone', wh_receipt = v_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  return query select v_receipt_id, v_date, v_total_pallet, v_total_quantity;
end;
$$;

grant execute on function public.scan_pallet_to_pending(text) to authenticated;
grant execute on function public.cancel_pending_pallet(text) to authenticated;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to authenticated;

commit;
