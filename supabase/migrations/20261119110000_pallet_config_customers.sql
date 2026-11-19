begin;

-- The label settings use customer names from pallet history, not from the
-- warehouse catalog's customer picker. No historical pallet is rewritten.
create function public.pallet_customer_options()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not public.has_permission('pallet.create') then raise exception 'NOT_AUTHORIZED'; end if;
  return jsonb_build_object('customers',coalesce((
    select jsonb_agg(c.customer order by c.customer) from (
      select distinct btrim(p.customer) as customer from public.pallet_data p
      where nullif(btrim(p.customer),'') is not null
    ) c
  ),'[]'::jsonb));
end $$;

create function public.pallet_config_save(p_itemcode text,p_quantity_per_pallet integer,p_customer text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare code text:=btrim(p_itemcode); customer_name text:=nullif(btrim(p_customer),''); existing_customer text;
  saved public.item_pallet_config%rowtype;
begin
  if auth.uid() is null or not public.has_permission('pallet.create') then raise exception 'NOT_AUTHORIZED'; end if;
  if code is null or code !~ '^[^[:space:]*]{1,200}$' or p_quantity_per_pallet is null or p_quantity_per_pallet<=0
    or length(customer_name)>500 then raise exception 'PALLET_CONFIG_INVALID'; end if;
  -- Catalog triggers also refresh inventory/requests. Keep the same global-lock
  -- then catalog-row order as the other catalog writers to avoid inversion.
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select nullif(btrim(c.customer),'') into existing_customer from public.item_pallet_config c where c.itemcode=code for update;
  if p_customer is not null then
    if customer_name is null and existing_customer is not null then raise exception 'PALLET_CONFIG_CUSTOMER_REQUIRED'; end if;
    if customer_name is not null and customer_name is distinct from existing_customer and not exists(
      select 1 from public.pallet_data p where btrim(p.customer)=customer_name
    ) then raise exception 'PALLET_CONFIG_UNKNOWN_CUSTOMER'; end if;
  end if;
  insert into public.item_pallet_config as c(itemcode,quantity_per_pallet,customer)
  values(code,p_quantity_per_pallet,customer_name)
  on conflict(itemcode) do update set quantity_per_pallet=excluded.quantity_per_pallet,
    customer=case when customer_name is null then c.customer else excluded.customer end
  returning * into saved;
  return jsonb_build_object('itemcode',saved.itemcode,'quantity_per_pallet',saved.quantity_per_pallet,
    'customer',coalesce(btrim(saved.customer),''),'updated_at',saved.updated_at);
exception when lock_not_available then raise exception using errcode='55P03',message='PALLET_CONFIG_BUSY';
end $$;

revoke all on function public.pallet_customer_options(),public.pallet_config_save(text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.pallet_customer_options(),public.pallet_config_save(text,integer,text) to authenticated;
notify pgrst,'reload schema';
commit;
