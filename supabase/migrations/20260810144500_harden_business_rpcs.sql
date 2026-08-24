begin;

-- Harden the currently supported business RPC surface.
-- Security model:
--   * every business RPC must enforce the same permission as its Next.js API;
--   * scan cancel / receipt creation additionally preserve owner-or-admin rules;
--   * anonymous/PUBLIC callers cannot execute business RPCs;
--   * obsolete workflow RPCs are removed without CASCADE so hidden DB dependencies
--     fail the migration safely instead of being deleted implicitly.

-- ---------------------------------------------------------------------------
-- 1. Current RPCs: align database authorization with application permissions.
-- ---------------------------------------------------------------------------

create or replace function public.edit_pallet_quantity_tracked(
  p_pallet_id text,
  p_quantity integer,
  p_reason text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.pallet_data;
  v_new public.pallet_data;
  v_now timestamptz := now();
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_old
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if v_old.status <> 'production' then
    raise exception 'INVALID_STATUS:%', v_old.status;
  end if;

  update public.pallet_data
  set effect_to = v_now,
      updated_at = v_now
  where id = v_old.id;

  insert into public.pallet_data (
    pallet_id,
    itemcode,
    product_name,
    customer,
    wo,
    quanorder,
    machine,
    quantity,
    status,
    created_by,
    note,
    old_data_refer,
    has_been_edited,
    edit_count,
    has_been_return,
    created_at,
    updated_at
  ) values (
    v_old.pallet_id,
    v_old.itemcode,
    v_old.product_name,
    v_old.customer,
    v_old.wo,
    v_old.quanorder,
    v_old.machine,
    p_quantity,
    v_old.status,
    auth.uid(),
    'edit: ' || trim(p_reason),
    v_old.id,
    true,
    coalesce(v_old.edit_count, 0) + 1,
    coalesce(v_old.has_been_return, false),
    v_now,
    v_now
  )
  returning * into v_new;

  return v_new;
end;
$$;

create or replace function public.delete_pallet_record_tracked(
  p_pallet_id text,
  p_reason text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.pallet_data;
  v_deleted public.pallet_data;
  v_now timestamptz := now();
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_old
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then
    raise exception 'PALLET_NOT_FOUND';
  end if;

  if v_old.status <> 'production' then
    raise exception 'INVALID_STATUS:%', v_old.status;
  end if;

  update public.pallet_data
  set effect_to = v_now,
      updated_at = v_now
  where id = v_old.id;

  insert into public.pallet_data (
    pallet_id,
    itemcode,
    product_name,
    customer,
    wo,
    quanorder,
    machine,
    quantity,
    status,
    created_by,
    note,
    old_data_refer,
    effect_to,
    created_at,
    updated_at
  ) values (
    v_old.pallet_id,
    v_old.itemcode,
    v_old.product_name,
    v_old.customer,
    v_old.wo,
    v_old.quanorder,
    v_old.machine,
    v_old.quantity,
    v_old.status,
    auth.uid(),
    'delete: ' || trim(p_reason),
    v_old.id,
    v_now,
    v_now,
    v_now
  )
  returning * into v_deleted;

  return v_deleted;
end;
$$;

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
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.pallet_data
  set status = 'pendingWH',
      scanned_by = auth.uid(),
      scanned_at = now()
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
    and status = 'production'
  returning * into v_row;

  if found then return v_row; end if;

  select * into v_row
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  raise exception 'INVALID_STATUS:%', v_row.status;
end;
$$;

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
  -- Permission is mandatory even for the original scanner.
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

  -- Normal users may only cancel their own scan. Admin/superadmin may operate
  -- across scanners, but only after passing scan.standard above.
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
      has_been_return = true,
      updated_at = v_cancelled_at
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
begin
  -- Permission is mandatory before owner/admin scope is evaluated.
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  -- Normal users may only complete pallets they scanned themselves.
  -- Admin/superadmin may complete across scanners, but only after passing
  -- scan.standard above.
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

-- ---------------------------------------------------------------------------
-- 2. Remove obsolete business RPCs from superseded workflows.
--    Intentionally no CASCADE: a real DB dependency must stop this migration.
-- ---------------------------------------------------------------------------

drop function if exists public.confirm_pending_pallets_tracked(text[]);
drop function if exists public.confirm_pending_pallets(text[]);
drop function if exists public.create_warehouse_receipt(text[]);
drop function if exists public.cancel_processing_pallets(text[]);
drop function if exists public.cancel_warehouse_receipt(text);
drop function if exists public.edit_pallet_quantity(text, integer);
drop function if exists public.delete_pallet_record(text);

-- ---------------------------------------------------------------------------
-- 3. Restrict execution of the supported business RPCs.
--    Permissions are still checked inside each SECURITY DEFINER function.
-- ---------------------------------------------------------------------------

revoke all on function public.replace_planning_inject(jsonb, text) from public;
revoke all on function public.replace_planning_inject(jsonb, text) from anon;
grant execute on function public.replace_planning_inject(jsonb, text) to authenticated;
grant execute on function public.replace_planning_inject(jsonb, text) to service_role;

revoke all on function public.create_pallet_record(text, text, text, text, numeric, text, integer, text) from public;
revoke all on function public.create_pallet_record(text, text, text, text, numeric, text, integer, text) from anon;
grant execute on function public.create_pallet_record(text, text, text, text, numeric, text, integer, text) to authenticated;
grant execute on function public.create_pallet_record(text, text, text, text, numeric, text, integer, text) to service_role;

revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from public;
revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from anon;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to authenticated;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to service_role;

revoke all on function public.delete_pallet_record_tracked(text, text) from public;
revoke all on function public.delete_pallet_record_tracked(text, text) from anon;
grant execute on function public.delete_pallet_record_tracked(text, text) to authenticated;
grant execute on function public.delete_pallet_record_tracked(text, text) to service_role;

revoke all on function public.scan_pallet_to_pending(text) from public;
revoke all on function public.scan_pallet_to_pending(text) from anon;
grant execute on function public.scan_pallet_to_pending(text) to authenticated;
grant execute on function public.scan_pallet_to_pending(text) to service_role;

revoke all on function public.cancel_pending_pallet(text) from public;
revoke all on function public.cancel_pending_pallet(text) from anon;
grant execute on function public.cancel_pending_pallet(text) to authenticated;
grant execute on function public.cancel_pending_pallet(text) to service_role;

revoke all on function public.create_warehouse_receipt_from_scan(text[]) from public;
revoke all on function public.create_warehouse_receipt_from_scan(text[]) from anon;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to authenticated;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to service_role;

revoke all on function public.dashboard_progress(text, text, date, date) from public;
revoke all on function public.dashboard_progress(text, text, date, date) from anon;
grant execute on function public.dashboard_progress(text, text, date, date) to authenticated;
grant execute on function public.dashboard_progress(text, text, date, date) to service_role;

commit;
