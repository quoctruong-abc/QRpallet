begin;

-- Track the previous physical row directly in pallet_data.
alter table public.pallet_data
  add column if not exists old_data_refer bigint references public.pallet_data(id);

create index if not exists pallet_data_old_data_refer_idx
  on public.pallet_data(old_data_refer);

-- Versioning needs multiple physical rows with the same business pallet_id.
-- Keep only one active version for each pallet_id.
alter table public.pallet_data
  drop constraint if exists pallet_data_pallet_id_key;

drop index if exists public.pallet_data_pallet_id_key;

create unique index if not exists pallet_data_one_active_version_idx
  on public.pallet_data(pallet_id)
  where effect_to is null;

-- PostgreSQL cannot change an existing function return type with CREATE OR REPLACE.
-- Drop the old signatures first, then recreate them with the new return type.
drop function if exists public.edit_pallet_quantity_tracked(text, integer, text);
drop function if exists public.delete_pallet_record_tracked(text, text);

-- Editing does not update the active row in place.
-- It expires the old row and creates an identical active version with only
-- quantity/note changed. old_data_refer points to the expired physical row.
create function public.edit_pallet_quantity_tracked(
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
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
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
    v_now,
    v_now
  )
  returning * into v_new;

  return v_new;
end;
$$;

-- Deleting also creates a trace row. Both the former active row and the new
-- tombstone row are inactive, so normal application queries no longer show it.
-- The tombstone points back to the deleted physical row through old_data_refer.
create function public.delete_pallet_record_tracked(
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
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
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

grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to authenticated;
grant execute on function public.delete_pallet_record_tracked(text, text) to authenticated;

commit;
