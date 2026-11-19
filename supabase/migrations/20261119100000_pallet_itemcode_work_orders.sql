begin;

-- Read-only lookup for the pallet label module. No table data, receipt or
-- inventory trigger is changed, and the pending scan activation stays separate.
create function public.pallet_itemcode_work_orders(p_itemcode text)
returns table (
  wo text, itemcode text, product_name text, customer text, machine text,
  quanorder numeric, produced_quantity bigint, warehouse_quantity bigint,
  pallet_count bigint, last_created_at timestamptz
)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not public.has_permission('pallet.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_itemcode is null or btrim(p_itemcode) !~ '^[^[:space:]*]{1,200}$' then
    raise exception 'INVALID_ITEMCODE';
  end if;
  return query
  with matching as materialized (
    select p.* from public.pallet_data p
    where p.itemcode=btrim(p_itemcode) and nullif(btrim(p.wo),'') is not null and btrim(p.wo)<>'0'
  ), latest as (
    -- Edits preserve created_at; prefer the current version, then the newer ID.
    select distinct on (p.wo) p.wo,p.itemcode,p.product_name,p.customer,p.machine,p.quanorder,p.created_at
    from matching p order by p.wo,p.created_at desc,(p.effect_to is null) desc,p.id desc
  ), totals as (
    select p.wo,
      coalesce(sum(p.quantity) filter(where p.effect_to is null),0)::bigint as produced,
      coalesce(sum(p.quantity) filter(where p.effect_to is null and lower(p.status)='whdone'),0)::bigint as received,
      count(*) filter(where p.effect_to is null) as pallets
    from matching p group by p.wo
  )
  select l.wo,l.itemcode,coalesce(btrim(l.product_name),''),coalesce(btrim(l.customer),''),coalesce(btrim(l.machine),''),
    l.quanorder,t.produced,t.received,t.pallets,l.created_at
  from latest l join totals t on t.wo=l.wo order by l.created_at desc,l.wo;
end $$;

revoke all on function public.pallet_itemcode_work_orders(text) from public,anon,authenticated,service_role;
grant execute on function public.pallet_itemcode_work_orders(text) to authenticated;
notify pgrst,'reload schema';
commit;
