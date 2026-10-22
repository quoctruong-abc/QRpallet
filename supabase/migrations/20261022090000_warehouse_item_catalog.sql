begin;

alter table public.item_pallet_config
  add column if not exists product_name text,
  add column if not exists customer text;

-- Metadata-only items must not invent a standard pallet quantity. The existing
-- positive-quantity CHECK still applies whenever a quantity is configured.
alter table public.item_pallet_config
  alter column quantity_per_pallet drop not null;

-- One-time backfill: keep a complete name/customer pair, preferring active
-- versions, then the most recently updated. Preserve nonblank catalog values and all
-- standard pallet quantities. This statement is safe to run again.
with latest as (
  select distinct on (p.itemcode)
    p.itemcode,
    btrim(p.product_name) as product_name,
    btrim(p.customer) as customer
  from public.pallet_data p
  where nullif(btrim(p.itemcode), '') is not null
    and nullif(btrim(p.product_name), '') is not null
    and nullif(btrim(p.customer), '') is not null
  order by p.itemcode, (p.effect_to is null) desc, p.updated_at desc, p.id desc
)
insert into public.item_pallet_config as c (itemcode, product_name, customer)
select itemcode, product_name, customer from latest
on conflict on constraint item_pallet_config_pkey do update
set product_name = coalesce(nullif(btrim(c.product_name), ''), excluded.product_name),
    customer = coalesce(nullif(btrim(c.customer), ''), excluded.customer)
where nullif(btrim(c.product_name), '') is null
   or nullif(btrim(c.customer), '') is null;

-- Called only through an authorized server route. A cache miss and its catalog
-- update share one transaction; a failed write cannot report lookup success.
create or replace function public.resolve_warehouse_item(p_itemcode text)
returns table (itemcode text, product_name text, customer text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_itemcode text := btrim(coalesce(p_itemcode, ''));
  v_config public.item_pallet_config%rowtype;
  v_source record;
begin
  if v_itemcode = '' or length(v_itemcode) > 200 then
    raise exception 'INVALID_ITEMCODE';
  end if;

  select c.* into v_config
  from public.item_pallet_config c
  where c.itemcode = v_itemcode;

  if nullif(btrim(v_config.product_name), '') is not null
     and nullif(btrim(v_config.customer), '') is not null then
    return query select v_config.itemcode, btrim(v_config.product_name), btrim(v_config.customer);
    return;
  end if;

  select btrim(p.product_name) as product_name, btrim(p.customer) as customer
    into v_source
  from public.pallet_data p
  where p.itemcode = v_itemcode
    and nullif(btrim(p.product_name), '') is not null
    and nullif(btrim(p.customer), '') is not null
  order by (p.effect_to is null) desc, p.updated_at desc, p.id desc
  limit 1;

  if not found then return; end if;

  return query
  insert into public.item_pallet_config as c (itemcode, product_name, customer)
  values (v_itemcode, v_source.product_name, v_source.customer)
  on conflict on constraint item_pallet_config_pkey do update
  set product_name = coalesce(nullif(btrim(c.product_name), ''), excluded.product_name),
      customer = coalesce(nullif(btrim(c.customer), ''), excluded.customer)
  returning c.itemcode, c.product_name, c.customer;
end;
$$;

revoke all on function public.resolve_warehouse_item(text) from public, anon, authenticated;
grant execute on function public.resolve_warehouse_item(text) to service_role;

commit;
