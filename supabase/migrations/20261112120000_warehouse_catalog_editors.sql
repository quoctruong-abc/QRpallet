begin;

create function public.warehouse_catalog_admin(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  code text;
  title text;
  customer_name text;
  item jsonb;
  recipes jsonb;
  children text[];
  replace_id text;
  existing public.item_build_up%rowtype;
  saved_id bigint;
begin
  if not exists(select 1 from public.profiles p where p.id=actor and p.is_active and p.role='superadmin') then
    raise exception 'WAREHOUSE_CATALOG_FORBIDDEN';
  end if;
  if p_action='customers' then
    return jsonb_build_object('customers',coalesce((
      select jsonb_agg(q.customer order by lower(q.customer),q.customer)
      from (select distinct btrim(c.customer) as customer from public.item_pallet_config c where nullif(btrim(c.customer),'') is not null) q
    ),'[]'));
  end if;
  if p_action is null or p_action not in ('lookup','save_item','save_build_up')
    or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;

  code := btrim(p_payload->>'itemcode');
  if jsonb_typeof(p_payload->'itemcode') is distinct from 'string' or code !~ '^[^[:space:]*]{1,200}$' then
    raise exception 'WAREHOUSE_CATALOG_INVALID';
  end if;

  if p_action='lookup' then
    select jsonb_build_object('product_name',nullif(btrim(c.product_name),''),'customer',nullif(btrim(c.customer),''),
      'erp_name',nullif(btrim(c."ERP_name"),'')) into item from public.item_pallet_config c where c.itemcode=code;
    if p_payload->'recipes' = 'true'::jsonb then
      select jsonb_agg(jsonb_build_object('id',b.id::text,
        'children',jsonb_build_array(b.child_itemcode_1,b.child_itemcode_2,b.child_itemcode_3)) order by b.id)
      into recipes from public.item_build_up b where b.parent_itemcode=code;
    end if;
    return jsonb_build_object('catalog',item,'recipes',coalesce(recipes,'[]'));
  end if;

  title := nullif(btrim(p_payload->>'product_name'),'');
  if coalesce(jsonb_typeof(p_payload->'product_name'),'null') not in ('null','string') or length(title)>500 then
    raise exception 'WAREHOUSE_CATALOG_INVALID';
  end if;

  if p_action='save_item' then
    customer_name := nullif(btrim(p_payload->>'customer'),'');
    if title is null or coalesce(jsonb_typeof(p_payload->'customer'),'null') not in ('null','string') then
      raise exception 'WAREHOUSE_CATALOG_INVALID';
    end if;
    perform pg_advisory_xact_lock(72638104112000::bigint);
    if customer_name is not null and not exists(
      select 1 from public.item_pallet_config c where btrim(c.customer)=customer_name
    ) then raise exception 'WAREHOUSE_CATALOG_UNKNOWN_CUSTOMER'; end if;
    insert into public.item_pallet_config as c(itemcode,product_name,customer)
    values(code,title,customer_name)
    on conflict(itemcode) do update set product_name=excluded.product_name,customer=excluded.customer
    where (c.product_name,c.customer) is distinct from (excluded.product_name,excluded.customer);
    return jsonb_build_object('itemcode',code);
  end if;

  if jsonb_typeof(p_payload->'children') is distinct from 'array' then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;
  if jsonb_array_length(p_payload->'children')<>3 then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_payload->'children') x
    where x<>'null'::jsonb and (jsonb_typeof(x)<>'string' or btrim(x#>>'{}') !~ '^[^[:space:]*]{1,200}$')
  ) then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;
  select array_agg(btrim(x) order by n) into children from jsonb_array_elements_text(p_payload->'children') with ordinality t(x,n);
  if coalesce(children[1],children[2],children[3]) is null then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;
  replace_id := p_payload->>'replace_id';

  -- Serialize catalog changes and prevent an Excel import from inserting an
  -- alternative during the check-and-replace transaction.
  perform pg_advisory_xact_lock(72638104112000::bigint);
  lock table public.item_build_up in share row exclusive mode;
  if replace_id is null then
    if exists(select 1 from public.item_build_up b where b.parent_itemcode=code) then
      raise exception 'WAREHOUSE_CATALOG_CONFIRM_REPLACEMENT';
    end if;
  else
    select * into existing from public.item_build_up b where b.parent_itemcode=code and b.id::text=replace_id;
    if not found or jsonb_build_array(existing.child_itemcode_1,existing.child_itemcode_2,existing.child_itemcode_3)
      is distinct from p_payload->'expected_children' then raise exception 'WAREHOUSE_CATALOG_STALE_RECIPE'; end if;
    if exists(
      select 1 from public.item_build_up b where b.parent_itemcode=code and b.id<>existing.id
        and (b.child_itemcode_1,b.child_itemcode_2,b.child_itemcode_3) is not distinct from (children[1],children[2],children[3])
    ) then raise exception 'WAREHOUSE_CATALOG_DUPLICATE_RECIPE'; end if;
  end if;

  if not exists(select 1 from public.item_pallet_config c where c.itemcode=code and nullif(btrim(c.product_name),'') is not null) then
    if title is null then raise exception 'WAREHOUSE_CATALOG_NAME_REQUIRED'; end if;
    insert into public.item_pallet_config as c(itemcode,product_name) values(code,title)
    on conflict(itemcode) do update set product_name=excluded.product_name where nullif(btrim(c.product_name),'') is null;
  end if;

  if replace_id is null then
    insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3,created_by)
    values(code,children[1],children[2],children[3],actor) returning id into saved_id;
  else
    update public.item_build_up
    set child_itemcode_1=children[1],child_itemcode_2=children[2],child_itemcode_3=children[3]
    where id=existing.id;
    saved_id := existing.id;
  end if;
  return jsonb_build_object('itemcode',code,'recipe_id',saved_id::text,'replaced',replace_id is not null);
end $$;

revoke all on function public.warehouse_catalog_admin(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.warehouse_catalog_admin(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
