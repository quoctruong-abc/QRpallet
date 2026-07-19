-- Fix Module 4 cancel/return-to-production flow.
-- Lock pallet rows first, then validate count/status separately.

create or replace function public.cancel_processing_pallets(p_pallet_ids text[])
returns setof public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer := coalesce(array_length(p_pallet_ids, 1), 0);
  v_locked_count integer;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
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

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  -- Lock each active pallet row. Do not combine FOR UPDATE with aggregate queries.
  perform 1
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
  order by pallet_id
  for update;

  select count(*)::integer
    into v_locked_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  if v_locked_count <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'production',
      wh_receipt = null
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH'
  returning *;
end;
$$;

revoke all on function public.cancel_processing_pallets(text[]) from public;
grant execute on function public.cancel_processing_pallets(text[]) to authenticated, service_role;
