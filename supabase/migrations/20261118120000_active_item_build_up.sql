begin;

select pg_advisory_xact_lock(72638104112000::bigint);
lock table public.item_build_up in share row exclusive mode;

alter table public.item_build_up add column active boolean not null default false;
-- A unique old recipe is unambiguous; old alternatives require a first choice.
with singletons as (
  select parent_itemcode from public.item_build_up group by parent_itemcode having count(*)=1
)
update public.item_build_up b set active=true from singletons s where b.parent_itemcode=s.parent_itemcode;
create unique index item_build_up_one_active_per_parent on public.item_build_up(parent_itemcode) where active;
comment on column public.item_build_up.active is 'Default recipe for new deliveries. At most one active recipe per parent; existing request snapshots do not change.';

create or replace function public.delivery_selected_build_up(p_itemcode text,p_token text)
returns jsonb language plpgsql stable set search_path=public as $$
declare options jsonb:=public.delivery_build_up_options(p_itemcode); chosen jsonb; current_active jsonb;
begin
  select value into current_active from jsonb_array_elements(options) where (value->>'active')::boolean;
  if p_token is not null then
    select value into chosen from jsonb_array_elements(options) where value->>'token'=p_token;
    if not found then raise exception 'DELIVERY_BUILD_UP_CHANGED:%',p_itemcode; end if;
    if current_active is not null and current_active->>'token'<>p_token then
      raise exception 'DELIVERY_BUILD_UP_ACTIVE_CHANGED:%',p_itemcode;
    end if;
    return chosen;
  end if;
  if current_active is not null then return current_active; end if;
  if jsonb_array_length(options)>0 then raise exception 'DELIVERY_BUILD_UP_CHOOSE:%',p_itemcode; end if;
  return null;
end $$;

-- Frontend flags describe a preview, not permission to overwrite a newer default.
create function public.delivery_prepare_activation(p_rows jsonb,p_manual boolean default false)
returns jsonb language plpgsql stable set search_path=public as $$
declare x jsonb; code text; chosen jsonb; current_active text; activation jsonb:='{}'; expected text;
begin
  for x in select value from jsonb_array_elements(p_rows) loop
    if not p_manual and (nullif(x->>'target_id','') is not null or exists(
      select 1 from public.inv_delivery_requests d where d.parent_request_id is null
        and d.purorder=btrim(x->>'purorder') and d.sales_id=btrim(x->>'sales_id')
        and d.itemcode=btrim(x->>'itemcode') and d.delivery_date=(x->>'delivery_date')::date
    )) then continue; end if;
    code:=btrim(x->>'itemcode');
    chosen:=public.delivery_selected_build_up(code,x->>'build_up_token');
    select o->>'token' into current_active from jsonb_array_elements(public.delivery_build_up_options(code)) o
      where (o->>'active')::boolean;
    if x ? 'expected_active_token' then
      expected:=x->>'expected_active_token';
      if expected is distinct from current_active and not (
        expected is null and current_active is not null and chosen->>'token'=current_active
      ) then raise exception 'DELIVERY_BUILD_UP_ACTIVE_CHANGED:%',code; end if;
    end if;
    if chosen is null or current_active is not null then continue; end if;
    if activation ? code and activation->>code<>chosen->>'token' then raise exception 'DELIVERY_BUILD_UP_CONFLICT:%',code; end if;
    activation:=activation||jsonb_build_object(code,chosen->>'token');
  end loop;
  return activation;
end $$;

create function public.delivery_activate_build_up(p_itemcode text,p_token text,p_force boolean default false)
returns void language plpgsql set search_path=public as $$
declare chosen jsonb; current_active text; recipe_id bigint;
begin
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select value into chosen from jsonb_array_elements(public.delivery_build_up_options(p_itemcode))
    where value->>'token'=p_token;
  if not found then raise exception 'DELIVERY_BUILD_UP_CHANGED:%',p_itemcode; end if;
  select o->>'token' into current_active from jsonb_array_elements(public.delivery_build_up_options(p_itemcode)) o
    where (o->>'active')::boolean;
  if current_active=p_token then return; end if;
  if current_active is not null and not p_force then raise exception 'DELIVERY_BUILD_UP_ACTIVE_CHANGED:%',p_itemcode; end if;
  recipe_id:=split_part(p_token,':',1)::bigint;
  update public.item_build_up set active=false where parent_itemcode=p_itemcode and active and id<>recipe_id;
  update public.item_build_up set active=true where parent_itemcode=p_itemcode and id=recipe_id and not active;
end $$;
revoke all on function public.delivery_prepare_activation(jsonb,boolean),public.delivery_activate_build_up(text,text,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.delivery_build_up_options(p_itemcode text)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('active',r.active,'token',r.id::text||':'||md5(to_jsonb(c.codes)::text),'codes',c.codes,
    'components',(select coalesce(jsonb_agg(jsonb_build_object('itemcode',x.itemcode,'factor',x.factor,
       'product_name',n.product_name,'customer',n.customer,'lookup_error',n.lookup_error,'declared',n.declared,
       'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by x.itemcode),'[]')
      from (select itemcode,count(*) as factor from unnest(c.codes) u(itemcode) where itemcode is not null group by itemcode) x
      left join public.inv_stock_summary s using(itemcode)
      cross join lateral public.warehouse_item_identity(x.itemcode) n)) order by r.active desc,r.id),'[]')
  from public.item_build_up r
  cross join lateral (select array[r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3] as codes) c
  where r.parent_itemcode=p_itemcode;
$$;

create or replace function public.lookup_delivery_build_up(p_itemcode text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare identity record;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select * into identity from public.warehouse_item_identity(p_itemcode);
  return to_jsonb(identity)||jsonb_build_object('catalog_lookup_version',1,'build_up_active_version',1,'build_up_options',public.delivery_build_up_options(p_itemcode));
end $$;

create or replace function public.warehouse_catalog_manage(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  code text;
  title text;
  customer_name text;
  erp_name text;
  weight numeric;
  check_code text;
  display_name text;
  item jsonb;
  recipes jsonb;
  children text[];
  replace_id text;
  existing public.item_build_up%rowtype;
  saved_id bigint;
  active_token text;
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
      'erp_name',nullif(btrim(c."ERP_name"),''),'netweight',c.netweight) into item from public.item_pallet_config c where c.itemcode=code;
    if p_payload->'recipes' = 'true'::jsonb then
      select jsonb_agg(jsonb_build_object('id',b.id::text,
        'active',b.active,'children',jsonb_build_array(b.child_itemcode_1,b.child_itemcode_2,b.child_itemcode_3)) order by b.active desc,b.id)
      into recipes from public.item_build_up b where b.parent_itemcode=code;
    end if;
    return jsonb_build_object('catalog',item,'recipes',coalesce(recipes,'[]'),'catalog_lookup_version',1,'build_up_active_version',1,
      'resolved',(select to_jsonb(n) from public.warehouse_item_identity(code) n));
  end if;

  if p_action='save_item' then
    title := nullif(btrim(p_payload->>'product_name'),'');
    customer_name := nullif(btrim(p_payload->>'customer'),'');
    erp_name := nullif(btrim(p_payload->>'erp_name'),'');
    if title is null or length(title)>500 or length(erp_name)>500
      or jsonb_typeof(p_payload->'product_name') is distinct from 'string'
      or coalesce(jsonb_typeof(p_payload->'customer'),'null') not in ('null','string')
      or coalesce(jsonb_typeof(p_payload->'erp_name'),'null') not in ('null','string')
      or coalesce(jsonb_typeof(p_payload->'netweight'),'null') not in ('null','number') then
      raise exception 'WAREHOUSE_CATALOG_INVALID';
    end if;
    weight := (p_payload->>'netweight')::numeric;
    if weight not between 0 and 1000000000000000 then raise exception 'WAREHOUSE_CATALOG_INVALID'; end if;
    perform pg_advisory_xact_lock(72638104112000::bigint);
    if customer_name is not null and not exists(
      select 1 from public.item_pallet_config c where btrim(c.customer)=customer_name
    ) then raise exception 'WAREHOUSE_CATALOG_UNKNOWN_CUSTOMER'; end if;
    insert into public.item_pallet_config as c(itemcode,product_name,customer,"ERP_name",netweight)
    values(code,title,customer_name,erp_name,weight)
    on conflict(itemcode) do update set product_name=excluded.product_name,customer=excluded.customer,
      "ERP_name"=case when p_payload ? 'erp_name' then excluded."ERP_name" else c."ERP_name" end,
      netweight=case when p_payload ? 'netweight' then excluded.netweight else c.netweight end
    where (c.product_name,c.customer,c."ERP_name",c.netweight) is distinct from (
      excluded.product_name,excluded.customer,
      case when p_payload ? 'erp_name' then excluded."ERP_name" else c."ERP_name" end,
      case when p_payload ? 'netweight' then excluded.netweight else c.netweight end
    );
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
    if exists(select 1 from public.item_build_up b where b.parent_itemcode=code) and p_payload->'create_new' is distinct from 'true'::jsonb then
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

  foreach check_code in array array_prepend(code,children) loop
    if check_code is null then continue; end if;
    select n.lookup_error into display_name from public.warehouse_item_identity(check_code) n;
    if display_name is not null then raise exception 'WAREHOUSE_CATALOG_LOOKUP_REJECTED:%',display_name; end if;
    perform public.resolve_warehouse_item(check_code);
  end loop;

  if replace_id is null and exists(select 1 from public.item_build_up b where b.parent_itemcode=code
    and (b.child_itemcode_1,b.child_itemcode_2,b.child_itemcode_3) is not distinct from (children[1],children[2],children[3])) then
    raise exception 'WAREHOUSE_CATALOG_DUPLICATE_RECIPE';
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
  select o->>'token' into active_token from jsonb_array_elements(public.delivery_build_up_options(code)) o
    where split_part(o->>'token',':',1)=saved_id::text;
  perform public.delivery_activate_build_up(code,active_token,true);
  return jsonb_build_object('itemcode',code,'recipe_id',saved_id::text,'replaced',replace_id is not null,'active',true);
end $$;


alter function public.manage_delivery(text,uuid,jsonb) rename to manage_delivery_before_active;
revoke all on function public.manage_delivery_before_active(text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.manage_delivery(p_action text,p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); cmd public.inv_delivery_commands%rowtype; preview jsonb; result jsonb; activation jsonb; x record;
begin
  if actor is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  perform pg_advisory_xact_lock(72638104112000::bigint);
  if p_action<>'preview' then
    select * into cmd from public.inv_delivery_commands where id=p_command_id;
    if found then
      if cmd.actor is distinct from actor or cmd.action<>p_action or cmd.payload is distinct from p_payload then raise exception 'DELIVERY_COMMAND_CONFLICT'; end if;
      return cmd.result;
    end if;
  end if;
  if p_action='preview' then
    return public.manage_delivery_before_active(p_action,p_command_id,p_payload)||jsonb_build_object('build_up_active_version',1);
  end if;
  if p_action='import' then
    lock table public.item_build_up in share mode;
    preview:=public.manage_delivery_before_active('preview',null,p_payload);
    activation:=public.delivery_prepare_activation(preview->'rows');
    result:=public.manage_delivery_before_active(p_action,p_command_id,p_payload);
    for x in select key,value from jsonb_each_text(activation) order by key loop
      perform public.delivery_activate_build_up(x.key,x.value);
    end loop;
    return result;
  end if;
  return public.manage_delivery_before_active(p_action,p_command_id,p_payload);
end $$;
revoke all on function public.manage_delivery(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.manage_delivery(text,uuid,jsonb) to authenticated;

alter function public.post_manual_delivery(uuid,jsonb) rename to post_manual_delivery_before_active;
revoke all on function public.post_manual_delivery_before_active(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.post_manual_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); cmd public.inv_delivery_commands%rowtype; activation jsonb; result jsonb; x record;
begin
  if actor is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into cmd from public.inv_delivery_commands where id=p_command_id;
  if found then
    if cmd.actor is distinct from actor or cmd.action<>'manual' or cmd.payload is distinct from p_payload then raise exception 'DELIVERY_COMMAND_CONFLICT'; end if;
    return cmd.result;
  end if;
  lock table public.item_build_up in share mode;
  activation:=public.delivery_prepare_activation(jsonb_build_array(p_payload),true);
  result:=public.post_manual_delivery_before_active(p_command_id,p_payload);
  for x in select key,value from jsonb_each_text(activation) order by key loop
    perform public.delivery_activate_build_up(x.key,x.value);
  end loop;
  return result;
end $$;
revoke all on function public.post_manual_delivery(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.post_manual_delivery(uuid,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
