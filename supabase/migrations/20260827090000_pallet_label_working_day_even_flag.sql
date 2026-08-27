begin;

-- Persist whether the operator created a full (even) or partial (odd) pallet.
-- Historical rows are inferred from the current item configuration; rows that
-- cannot be matched are conservatively treated as partial pallets.
alter table public.pallet_data
  add column if not exists even_pallet boolean;

update public.pallet_data p
set even_pallet = p.quantity = c.quantity_per_pallet
from public.item_pallet_config c
where p.even_pallet is null
  and p.itemcode = c.itemcode;

update public.pallet_data
set even_pallet = false
where even_pallet is null;

alter table public.pallet_data
  alter column even_pallet set default false,
  alter column even_pallet set not null;

comment on column public.pallet_data.even_pallet is
  'True when created as a full/even pallet; false when created as a partial/odd pallet.';

-- Extend pallet creation with an optional working-day override and the pallet
-- type selected by the operator. A null working day is filled by the existing
-- pallet_data_set_working_day trigger.
drop function if exists public.create_pallet_record(
  text, text, text, text, numeric, text, integer, text
);

create function public.create_pallet_record(
  p_itemcode text,
  p_product_name text,
  p_customer text,
  p_wo text,
  p_quanorder numeric,
  p_machine text,
  p_quantity integer,
  p_note text default null,
  p_working_day date default null,
  p_even_pallet boolean default false
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare
  next_number integer;
  new_pallet_id text;
  new_row public.pallet_data;
begin
  if not public.has_permission('pallet.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(trim(p_wo), '') = '' then raise exception 'WO_REQUIRED'; end if;
  if coalesce(trim(p_itemcode), '') = '' then raise exception 'ITEMCODE_REQUIRED'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  perform pg_advisory_xact_lock(hashtext(p_wo));

  select coalesce(max((regexp_match(pallet_id, '-([0-9]+)$'))[1]::integer), 0) + 1
  into next_number
  from public.pallet_data
  where wo = p_wo;

  new_pallet_id := p_wo || '-' || lpad(next_number::text, 3, '0');

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
    note,
    created_by,
    working_day,
    even_pallet
  ) values (
    new_pallet_id,
    p_itemcode,
    p_product_name,
    p_customer,
    p_wo,
    p_quanorder,
    p_machine,
    p_quantity,
    'production',
    p_note,
    auth.uid(),
    p_working_day,
    coalesce(p_even_pallet, false)
  )
  returning * into new_row;

  return new_row;
end;
$$;

-- Editing creates a new physical version. Preserve the original pallet type
-- while the working-day trigger preserves the original working day.
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
    even_pallet,
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
    v_old.even_pallet,
    v_now,
    v_now
  )
  returning * into v_new;

  return v_new;
end;
$$;

-- Deleted versions also retain the pallet type for dashboard/history queries.
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
    effect_to,
    even_pallet,
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
    v_old.even_pallet,
    v_now,
    v_now
  )
  returning * into v_deleted;

  return v_deleted;
end;
$$;

revoke all on function public.create_pallet_record(
  text, text, text, text, numeric, text, integer, text, date, boolean
) from public;
revoke all on function public.create_pallet_record(
  text, text, text, text, numeric, text, integer, text, date, boolean
) from anon;
grant execute on function public.create_pallet_record(
  text, text, text, text, numeric, text, integer, text, date, boolean
) to authenticated, service_role;

revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from public;
revoke all on function public.edit_pallet_quantity_tracked(text, integer, text) from anon;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text)
  to authenticated, service_role;

revoke all on function public.delete_pallet_record_tracked(text, text) from public;
revoke all on function public.delete_pallet_record_tracked(text, text) from anon;
grant execute on function public.delete_pallet_record_tracked(text, text)
  to authenticated, service_role;

commit;
