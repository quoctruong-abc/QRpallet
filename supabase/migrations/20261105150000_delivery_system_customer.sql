begin;

select pg_advisory_xact_lock(72638104112000::bigint);

alter table public.inv_delivery_requests add column system_customer_name text;
comment on column public.inv_delivery_requests.system_customer_name is
  'Current customer name from the internal item catalog or incoming lots. ERP customer remains in customer.';

create function public.resolve_delivery_system_customer(p_itemcode text)
returns text language sql stable set search_path=public as $$
  select coalesce(
    (select nullif(btrim(c.customer),'') from public.item_pallet_config c where c.itemcode=p_itemcode),
    (select btrim(i.customer) from public.inv_incoming i
      where i.itemcode=p_itemcode and nullif(btrim(i.customer),'') is not null
      order by i.id desc limit 1)
  );
$$;

create function public.set_delivery_system_customer()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  new.system_customer_name := public.resolve_delivery_system_customer(new.itemcode);
  return new;
end $$;
create trigger delivery_system_customer before insert or update of itemcode on public.inv_delivery_requests
  for each row execute function public.set_delivery_system_customer();

create function public.refresh_delivery_system_customers(p_items text[])
returns void language sql security definer set search_path=public as $$
  with names as materialized (
    select d.itemcode, public.resolve_delivery_system_customer(d.itemcode) as customer
    from (select distinct r.itemcode from public.inv_delivery_requests r where r.itemcode=any(p_items)) d
  )
  update public.inv_delivery_requests r set system_customer_name=n.customer
  from names n where r.itemcode=n.itemcode and r.system_customer_name is distinct from n.customer;
$$;

revoke all on function public.resolve_delivery_system_customer(text),public.set_delivery_system_customer(),
  public.refresh_delivery_system_customers(text[]) from public,anon,authenticated,service_role;

-- Use the existing source triggers and transaction lock. Request updates can
-- refresh the summary, but do not run this customer synchronization recursively.
create or replace function public.refresh_changed_stock_items()
returns trigger language plpgsql security definer set search_path=public as $$
declare items text[];
begin
  if tg_op='INSERT' then select array_agg(distinct itemcode) into items from changed_new;
  elsif tg_op='DELETE' then select array_agg(distinct itemcode) into items from changed_old;
  else select array_agg(distinct itemcode) into items from (select itemcode from changed_new union select itemcode from changed_old) x;
  end if;
  if cardinality(items)>0 then
    if tg_table_name in ('item_pallet_config','inv_incoming') then
      perform public.refresh_delivery_system_customers(items);
    end if;
    perform public.refresh_stock_summary(items);
  end if;
  return null;
end $$;

select public.refresh_delivery_system_customers(array(select distinct itemcode from public.inv_delivery_requests));

notify pgrst,'reload schema';
commit;
