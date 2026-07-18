-- Fix PostgreSQL error: FOR UPDATE is not allowed with aggregate functions.
-- Lock pallet rows first, then validate the locked set without combining
-- aggregate functions and FOR UPDATE in the same SELECT.

create or replace function public.confirm_pending_pallets_tracked(
  p_pallet_ids text[]
)
returns setof public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_requested_count integer;
  v_locked_count integer;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if p_pallet_ids is null or cardinality(p_pallet_ids) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  select count(distinct pallet_id)
    into v_requested_count
  from unnest(p_pallet_ids) as requested(pallet_id)
  where nullif(btrim(pallet_id), '') is not null;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  -- Row locking must be performed on real pallet rows, not on count(*).
  perform 1
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
  for update;

  select count(*)
    into v_locked_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  if v_locked_count <> v_requested_count then
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

revoke all on function public.confirm_pending_pallets_tracked(text[]) from public;
grant execute on function public.confirm_pending_pallets_tracked(text[]) to authenticated, service_role;
