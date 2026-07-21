-- Fix Module 4 confirmation: lock pallet rows before aggregate queries.
-- Also align database ownership with the UI/API rule: Production confirms receipt.

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
  v_date date := current_date;
  v_order integer;
  v_receipt_id text;
  v_total_pallet integer;
  v_total_quantity bigint;
  v_requested_count integer := coalesce(array_length(p_pallet_ids, 1), 0);
begin
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
  end if;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  perform pg_advisory_xact_lock(hashtext('WH_RECEIPT_' || to_char(v_date, 'YYYYMMDD')));

  -- Lock the actual pallet rows first. FOR UPDATE cannot be used on count/sum.
  perform p.pallet_id
  from public.pallet_data p
  where p.pallet_id = any(p_pallet_ids)
    and p.effect_to is null
  for update;

  -- Validate every requested pallet after acquiring the row locks.
  select count(*)::integer,
         coalesce(sum(p.quantity), 0)::bigint
    into v_total_pallet, v_total_quantity
  from public.pallet_data p
  where p.pallet_id = any(p_pallet_ids)
    and p.effect_to is null
    and p.status = 'processingWH';

  if v_total_pallet <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  select coalesce(max((regexp_match(w.receipt_id, '-([0-9]+)$'))[1]::integer), 0) + 1
    into v_order
  from public.wh_receipt w
  where w.receipt_date = v_date;

  v_receipt_id := 'WH-' || to_char(v_date, 'DDMMYY') || '-' || lpad(v_order::text, 3, '0');

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
  set status = 'WHdone',
      wh_receipt = v_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  if not found then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  select v_receipt_id, v_date, v_total_pallet, v_total_quantity;
end;
$$;

revoke all on function public.create_warehouse_receipt(text[]) from public;
grant execute on function public.create_warehouse_receipt(text[]) to authenticated, service_role;
