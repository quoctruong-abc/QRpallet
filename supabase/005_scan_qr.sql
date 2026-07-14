begin;

create or replace function public.scan_pallet_to_pending(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pallet_data;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'scanner'
  ) then
    raise exception 'Not authorized';
  end if;

  update public.pallet_data
  set status = 'pendingWH'
  where pallet_id = trim(p_pallet_id)
    and status = 'production'
  returning * into v_row;

  if found then
    return v_row;
  end if;

  select * into v_row
  from public.pallet_data
  where pallet_id = trim(p_pallet_id);

  if not found then
    raise exception 'PALLET_NOT_FOUND';
  end if;

  raise exception 'INVALID_STATUS:%', v_row.status;
end;
$$;

create or replace function public.confirm_pending_pallets(p_pallet_ids text[])
returns setof public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'scanner'
  ) then
    raise exception 'Not authorized';
  end if;

  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) as x(pallet_id)
    left join public.pallet_data p on p.pallet_id = x.pallet_id
    where p.pallet_id is null or p.status <> 'pendingWH'
  ) then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and status = 'pendingWH'
  returning *;
end;
$$;

grant execute on function public.scan_pallet_to_pending(text) to authenticated;
grant execute on function public.confirm_pending_pallets(text[]) to authenticated;

commit;
