begin;

-- Scan input guard:
--   * a scanner may hold at most 200 active pendingWH pallets at a time;
--   * one warehouse receipt confirmation may contain at most 200 pallet IDs;
--   * pallet IDs are bounded to a sane request length;
--   * advisory locking prevents two concurrent scan requests from bypassing the cap.

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
      scanned_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.create_warehouse_receipt_from_scan(
  p_pallet_ids text[]
)
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
  v_requested_count integer := coalesce(array_length(p_pallet_ids, 1), 0);
  v_distinct_count integer;
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  if v_requested_count > 200 then
    raise exception 'MAX_CONFIRM_PALLETS';
  end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) x(pallet_id)
    where x.pallet_id is null
       or trim(x.pallet_id) = ''
       or length(trim(x.pallet_id)) > 128
  ) then
    raise exception 'INVALID_PALLET_ID';
  end if;

  select count(distinct trim(x.pallet_id))::integer
    into v_distinct_count
  from unnest(p_pallet_ids) x(pallet_id);

  if v_distinct_count <> v_requested_count then
    raise exception 'DUPLICATE_PALLETS';
  end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) x(pallet_id)
    left join public.pallet_data p
      on p.pallet_id = trim(x.pallet_id)
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

  if v_total_pallet <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED_OR_NOT_OWNER';
  end if;

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

revoke all on function public.scan_pallet_to_pending(text) from public;
revoke all on function public.scan_pallet_to_pending(text) from anon;
grant execute on function public.scan_pallet_to_pending(text) to authenticated;
grant execute on function public.scan_pallet_to_pending(text) to service_role;

revoke all on function public.create_warehouse_receipt_from_scan(text[]) from public;
revoke all on function public.create_warehouse_receipt_from_scan(text[]) from anon;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to authenticated;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to service_role;

commit;
