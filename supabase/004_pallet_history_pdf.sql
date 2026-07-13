begin;

alter table public.pallet_data
  add column if not exists effect_to timestamptz,
  add column if not exists note text;

alter table public.pallet_data drop constraint if exists pallet_data_pallet_id_key;
create unique index if not exists pallet_data_active_pallet_id_uidx
  on public.pallet_data(pallet_id) where effect_to is null;

create index if not exists pallet_data_active_wo_idx
  on public.pallet_data(wo) where effect_to is null;

create or replace function public.create_pallet_record(
  p_itemcode text,
  p_product_name text,
  p_customer text,
  p_wo text,
  p_quanorder numeric,
  p_machine text,
  p_quantity integer,
  p_note text default null
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
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'pallet'
  ) then raise exception 'Not authorized'; end if;

  if coalesce(trim(p_wo), '') = '' then raise exception 'WO is required'; end if;
  if coalesce(trim(p_itemcode), '') = '' then raise exception 'Itemcode is required'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  perform pg_advisory_xact_lock(hashtext(p_wo));
  select coalesce(max((regexp_match(pallet_id, '-([0-9]+)$'))[1]::integer), 0) + 1
    into next_number
  from public.pallet_data
  where wo = p_wo;

  new_pallet_id := p_wo || '-' || lpad(next_number::text, 3, '0');

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,note,created_by
  ) values (
    new_pallet_id,p_itemcode,p_product_name,p_customer,p_wo,p_quanorder,p_machine,p_quantity,'production',p_note,auth.uid()
  ) returning * into new_row;

  return new_row;
end;
$$;

create or replace function public.edit_pallet_quantity(
  p_pallet_id text,
  p_quantity integer
)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare old_row public.pallet_data; new_row public.pallet_data;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles where id = auth.uid() and is_active = true and position = 'pallet'
  ) then raise exception 'Not authorized'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  select * into old_row from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null for update;
  if not found then raise exception 'Active pallet not found'; end if;

  update public.pallet_data set effect_to = now(), note = 'edit'
  where id = old_row.id;

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,quantity,status,note,created_by
  ) values (
    old_row.pallet_id,old_row.itemcode,old_row.product_name,old_row.customer,old_row.wo,
    old_row.quanorder,old_row.machine,p_quantity,old_row.status,
    old_row.note,auth.uid()
  ) returning * into new_row;
  return new_row;
end;
$$;

create or replace function public.delete_pallet_record(p_pallet_id text)
returns public.pallet_data
language plpgsql
security definer
set search_path = public
as $$
declare old_row public.pallet_data;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles where id = auth.uid() and is_active = true and position = 'pallet'
  ) then raise exception 'Not authorized'; end if;

  update public.pallet_data set effect_to = now(), note = 'delete'
  where pallet_id = p_pallet_id and effect_to is null
  returning * into old_row;
  if not found then raise exception 'Active pallet not found'; end if;
  return old_row;
end;
$$;

revoke all on function public.create_pallet_record(text,text,text,text,numeric,text,integer,text) from public;
grant execute on function public.create_pallet_record(text,text,text,text,numeric,text,integer,text) to authenticated;
grant execute on function public.edit_pallet_quantity(text,integer) to authenticated;
grant execute on function public.delete_pallet_record(text) to authenticated;

commit;
