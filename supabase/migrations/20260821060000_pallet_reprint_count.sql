begin;

alter table public.pallet_data
  add column if not exists reprint_count integer not null default 0;

alter table public.pallet_data
  drop constraint if exists pallet_data_reprint_count_check;

alter table public.pallet_data
  add constraint pallet_data_reprint_count_check check (reprint_count >= 0);

create or replace function public.increment_pallet_reprint_count(
  p_pallet_id text
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pallet public.pallet_data;
begin
  if not public.has_permission('pallet.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.pallet_data
  set reprint_count = reprint_count + 1,
      updated_at = now()
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  returning * into v_pallet;

  if not found then
    raise exception 'PALLET_NOT_FOUND';
  end if;

  return v_pallet;
end;
$$;

-- Editing creates a new active physical row. Carry the reprint counter to the
-- new version so it remains attached to the business pallet ID.
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
    reprint_count,
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
    coalesce(v_old.reprint_count, 0),
    v_now,
    v_now
  )
  returning * into v_new;

  return v_new;
end;
$$;

revoke all on function public.increment_pallet_reprint_count(text) from public;
revoke all on function public.increment_pallet_reprint_count(text) from anon;
grant execute on function public.increment_pallet_reprint_count(text) to authenticated;
grant execute on function public.increment_pallet_reprint_count(text) to service_role;

revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from public;
revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from anon;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to authenticated;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to service_role;

commit;
