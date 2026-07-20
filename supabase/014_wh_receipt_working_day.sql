begin;

-- Warehouse receipt day follows the Vietnam production working day:
-- 06:00 today through before 06:00 tomorrow belongs to the same receipt_date.
create or replace function public.vietnam_working_day(p_timestamp timestamptz default now())
returns date
language sql
stable
set search_path = public
as $$
  select (
    timezone('Asia/Ho_Chi_Minh', p_timestamp) - interval '6 hours'
  )::date;
$$;

-- Correct existing receipt dates from their actual creation timestamps.
update public.wh_receipt
set receipt_date = public.vietnam_working_day(created_at)
where receipt_date is distinct from public.vietnam_working_day(created_at);

-- Protect direct inserts as well as RPC inserts.
create or replace function public.set_wh_receipt_working_day()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.receipt_date := public.vietnam_working_day(coalesce(new.created_at, now()));
  return new;
end;
$$;

drop trigger if exists wh_receipt_set_working_day on public.wh_receipt;
create trigger wh_receipt_set_working_day
before insert on public.wh_receipt
for each row
execute function public.set_wh_receipt_working_day();

-- Recreate scan confirmation so receipt numbering also uses the working day.
drop function if exists public.create_warehouse_receipt_from_scan(text[]);

create function public.create_warehouse_receipt_from_scan(p_pallet_ids text[])
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
  v_date date := public.vietnam_working_day(now());
  v_order integer;
  v_receipt_id text;
  v_total_pallet integer;
  v_total_quantity bigint;
begin
  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'warehouse'
  ) then
    raise exception 'Not authorized';
  end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) x(pallet_id)
    left join public.pallet_data p
      on p.pallet_id = x.pallet_id
     and p.effect_to is null
    where p.pallet_id is null
       or p.status <> 'pendingWH'
       or (not public.is_admin() and p.scanned_by is distinct from auth.uid())
  ) then
    raise exception 'PALLET_STATUS_CHANGED_OR_NOT_OWNER';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('WH_RECEIPT_' || to_char(v_date, 'YYYYMMDD'))
  );

  select count(*)::integer,
         coalesce(sum(quantity), 0)::bigint
    into v_total_pallet, v_total_quantity
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  select coalesce(
           max((regexp_match(w.receipt_id, '-([0-9]+)$'))[1]::integer),
           0
         ) + 1
    into v_order
  from public.wh_receipt w
  where w.receipt_date = v_date;

  v_receipt_id :=
    'WH-' || to_char(v_date, 'DDMMYY') || '-' || lpad(v_order::text, 3, '0');

  insert into public.wh_receipt (
    receipt_id,
    receipt_date,
    total_pallet,
    total_quantity,
    user_id
  ) values (
    v_receipt_id,
    v_date,
    v_total_pallet,
    v_total_quantity,
    auth.uid()
  );

  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  update public.pallet_data
  set status = 'WHdone',
      wh_receipt = v_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  return query
  select v_receipt_id, v_date, v_total_pallet, v_total_quantity;
end;
$$;

grant execute on function public.vietnam_working_day(timestamptz) to authenticated;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to authenticated;

commit;
