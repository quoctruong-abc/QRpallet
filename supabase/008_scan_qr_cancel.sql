begin;

create or replace function public.cancel_pending_pallet(p_pallet_id text)
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
  set status = 'production'
  where pallet_id = trim(p_pallet_id)
    and status = 'pendingWH'
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

grant execute on function public.cancel_pending_pallet(text) to authenticated;

commit;
