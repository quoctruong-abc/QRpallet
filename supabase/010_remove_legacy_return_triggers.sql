begin;

-- Remove legacy triggers on pallet_data whose trigger functions still reference
-- the old return columns removed by migration 009.
do $$
declare
  trigger_row record;
begin
  for trigger_row in
    select
      trigger_info.tgname as trigger_name,
      namespace_info.nspname as function_schema,
      function_info.proname as function_name,
      pg_get_function_identity_arguments(function_info.oid) as function_arguments
    from pg_trigger trigger_info
    join pg_class table_info
      on table_info.oid = trigger_info.tgrelid
    join pg_namespace table_namespace
      on table_namespace.oid = table_info.relnamespace
    join pg_proc function_info
      on function_info.oid = trigger_info.tgfoid
    join pg_namespace namespace_info
      on namespace_info.oid = function_info.pronamespace
    where table_namespace.nspname = 'public'
      and table_info.relname = 'pallet_data'
      and not trigger_info.tgisinternal
      and (
        pg_get_functiondef(function_info.oid) ilike '%returned_at%'
        or pg_get_functiondef(function_info.oid) ilike '%returned_by%'
        or pg_get_functiondef(function_info.oid) ilike '%returned_from%'
        or pg_get_functiondef(function_info.oid) ilike '%return_at%'
        or pg_get_functiondef(function_info.oid) ilike '%return_by%'
        or pg_get_functiondef(function_info.oid) ilike '%return_from%'
      )
  loop
    execute format(
      'drop trigger if exists %I on public.pallet_data',
      trigger_row.trigger_name
    );

    -- Drop the legacy trigger function only when nothing else still depends on it.
    begin
      execute format(
        'drop function if exists %I.%I(%s)',
        trigger_row.function_schema,
        trigger_row.function_name,
        trigger_row.function_arguments
      );
    exception
      when dependent_objects_still_exist then
        null;
    end;
  end loop;
end;
$$;

-- Recreate the current cancel RPC so it is guaranteed to use only the new fields.
drop function if exists public.cancel_pending_pallet(text);

create function public.cancel_pending_pallet(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pallet_data;
  v_cancelled_at timestamptz := now();
begin
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
      has_been_return = true,
      updated_at = v_cancelled_at
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.cancel_pending_pallet(text) to authenticated;

commit;
