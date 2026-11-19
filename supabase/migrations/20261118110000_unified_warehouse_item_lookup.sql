begin;

select pg_advisory_xact_lock(72638104112000::bigint);

alter table public.inv_incoming
  drop constraint inv_incoming_customer_check,
  add constraint inv_incoming_customer_check check (
    opening_import_id is not null or manual_batch_id is not null or nullif(btrim(customer),'') is not null
  );

-- Read each field independently. Stock layers and ERP uploads do not declare
-- new items; a prior catalog or pallet-data record is required.
-- The declared return order is explicit so callers share one stable contract.
create function public.warehouse_item_identity(p_itemcode text)
returns table(itemcode text,product_name text,customer text,declared boolean,lookup_error text,name_source text)
language sql stable set search_path=public as $$
  with identity as (
    select x.code as itemcode,
      coalesce(nullif(btrim(c.product_name),''),nullif(btrim(c."ERP_name"),''),pn.product_name) as product_name,
      coalesce(nullif(btrim(c.customer),''),pc.customer) as customer,
      c.itemcode is not null or exists(select 1 from public.pallet_data p where p.itemcode=x.code) as declared,
      case when nullif(btrim(c.product_name),'') is not null then 'product_name'
        when nullif(btrim(c."ERP_name"),'') is not null then 'ERP_name'
        when pn.product_name is not null then 'pallet_data' end as name_source
    from (values(btrim(p_itemcode))) x(code)
    left join public.item_pallet_config c on c.itemcode=x.code
    left join lateral (
      select btrim(p.product_name) as product_name from public.pallet_data p
      where p.itemcode=x.code and nullif(btrim(p.product_name),'') is not null
      order by (p.effect_to is null) desc,p.updated_at desc,p.id desc limit 1
    ) pn on true
    left join lateral (
      select btrim(p.customer) as customer from public.pallet_data p
      where p.itemcode=x.code and nullif(btrim(p.customer),'') is not null
      order by (p.effect_to is null) desc,p.updated_at desc,p.id desc limit 1
    ) pc on true
  )
  select i.itemcode,i.product_name,i.customer,i.declared,
    case when not i.declared then 'Itemcode '||coalesce(i.itemcode,'')||' chưa được khai báo. Vui lòng cập nhật danh mục trước khi tạo lịch.'
      when i.product_name is null then 'Itemcode '||i.itemcode||' chưa có tên sản phẩm hoặc tên ERP. Vui lòng cập nhật thông tin sản phẩm.' end,
    i.name_source from identity i;
$$;
revoke all on function public.warehouse_item_identity(text) from public,anon,authenticated,service_role;
grant execute on function public.warehouse_item_identity(text) to service_role;

create or replace function public.resolve_warehouse_item(p_itemcode text)
returns table(itemcode text,product_name text,customer text)
language plpgsql set search_path=public as $$
declare identity record;
begin
  if length(btrim(coalesce(p_itemcode,''))) not between 1 and 200 or position('*' in p_itemcode)>0 then
    raise exception 'INVALID_ITEMCODE';
  end if;
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into identity from public.warehouse_item_identity(p_itemcode);
  if identity.lookup_error is not null then return; end if;
  -- Only pallet history may fill missing production names. Using ERP_name as
  -- a display fallback must not copy it into a deliberately empty product_name.
  insert into public.item_pallet_config as c(itemcode,product_name,customer)
    select identity.itemcode,case when identity.name_source='pallet_data' then identity.product_name else old.product_name end,
      identity.customer
    from (values(1)) x(n) left join public.item_pallet_config old on old.itemcode=identity.itemcode
  on conflict on constraint item_pallet_config_pkey do update
    set product_name=coalesce(nullif(btrim(c.product_name),''),excluded.product_name),
      customer=coalesce(nullif(btrim(c.customer),''),excluded.customer)
    where (c.product_name,c.customer) is distinct from
      (coalesce(nullif(btrim(c.product_name),''),excluded.product_name),coalesce(nullif(btrim(c.customer),''),excluded.customer));
  return query select identity.itemcode,identity.product_name,coalesce(identity.customer,'');
end $$;
revoke all on function public.resolve_warehouse_item(text) from public,anon,authenticated;
grant execute on function public.resolve_warehouse_item(text) to service_role;

create or replace function public.lookup_manual_delivery_item(p_itemcode text)
returns table(product_name text,customer text)
language plpgsql stable security definer set search_path=public as $$
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  if length(coalesce(p_itemcode,'')) not between 1 and 200 or btrim(p_itemcode) is distinct from p_itemcode
    or position('*' in p_itemcode)>0 then raise exception 'DELIVERY_INVALID_ITEM'; end if;
  return query select i.product_name,i.customer from public.warehouse_item_identity(p_itemcode) i where i.lookup_error is null;
end $$;

create or replace function public.resolve_delivery_system_customer(p_itemcode text)
returns text language sql stable set search_path=public as $$
  select customer from public.warehouse_item_identity(p_itemcode);
$$;
create or replace function public.delivery_component_identity(p_itemcode text)
returns table(product_name text,customer text) language sql stable set search_path=public as $$
  select product_name,customer from public.warehouse_item_identity(p_itemcode);
$$;
create or replace function public.set_delivery_system_customer()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  new.system_customer_name:=public.resolve_delivery_system_customer(new.itemcode);
  return new;
end $$;
create or replace function public.refresh_delivery_system_customers(p_items text[])
returns void language sql security definer set search_path=public as $$
  with names as materialized (
    select x.itemcode,public.resolve_delivery_system_customer(x.itemcode) as customer
    from (select distinct d.itemcode from public.inv_delivery_requests d where d.itemcode=any(p_items)) x
  )
  update public.inv_delivery_requests d set system_customer_name=n.customer from names n
    where d.itemcode=n.itemcode and d.system_customer_name is distinct from n.customer;
$$;

create or replace function public.lookup_delivery_build_up(p_itemcode text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare identity record;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select * into identity from public.warehouse_item_identity(p_itemcode);
  return to_jsonb(identity)||jsonb_build_object('catalog_lookup_version',1,'build_up_options',public.delivery_build_up_options(p_itemcode));
end $$;

-- Selected recipes are validated both at preview time and again on posting.
create function public.delivery_catalog_validation(p_rows jsonb)
returns jsonb language plpgsql stable set search_path=public as $$
declare x jsonb; identity record; code text; recipe jsonb; codes text[]:='{}'; errors jsonb:='[]';
  target uuid; parts jsonb;
begin
  for x in select value from jsonb_array_elements(p_rows) loop
    code:=x->>'itemcode';
    codes:=array_append(codes,code);
    select * into identity from public.warehouse_item_identity(code);
    if identity.lookup_error is not null then
      errors:=errors||jsonb_build_array(jsonb_build_object('row',x->'excel_row','itemcode',code,'reason',identity.lookup_error));
      continue;
    end if;
    target:=coalesce(nullif(x->>'target_id','')::uuid,nullif(x->'existing'->>'id','')::uuid);
    parts:='[]';
    if target is not null then
      select coalesce(jsonb_agg(jsonb_build_object('itemcode',d.itemcode)),'[]') into parts
        from public.inv_delivery_requests d where d.parent_request_id=target;
    else
      recipe:=public.delivery_selected_build_up(code,x->>'build_up_token');
      if recipe is not null then parts:=recipe->'components'; end if;
    end if;
    for code in select c->>'itemcode' from jsonb_array_elements(parts) c loop
      codes:=array_append(codes,code);
      select * into identity from public.warehouse_item_identity(code);
      if identity.lookup_error is not null then
        errors:=errors||jsonb_build_array(jsonb_build_object('row',x->'excel_row','itemcode',code,'parent_itemcode',x->>'itemcode','reason',identity.lookup_error));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('errors',errors,'codes',to_jsonb(codes));
end $$;
revoke all on function public.delivery_catalog_validation(jsonb) from public,anon,authenticated,service_role;

create or replace function public.delivery_build_up_options(p_itemcode text)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token',r.id::text||':'||md5(to_jsonb(c.codes)::text),'codes',c.codes,
    'components',(select coalesce(jsonb_agg(jsonb_build_object('itemcode',x.itemcode,'factor',x.factor,
       'product_name',n.product_name,'customer',n.customer,'lookup_error',n.lookup_error,'declared',n.declared,
       'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by x.itemcode),'[]')
      from (select itemcode,count(*) as factor from unnest(c.codes) u(itemcode) where itemcode is not null group by itemcode) x
      left join public.inv_stock_summary s using(itemcode)
      cross join lateral public.warehouse_item_identity(x.itemcode) n)) order by r.id),'[]')
  from public.item_build_up r
  cross join lateral (select array[r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3] as codes) c
  where r.parent_itemcode=p_itemcode;
$$;


create or replace function public.delivery_saved_components(p_parent uuid)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemcode',d.itemcode,'factor',d.ordered_qty/p.ordered_qty,
    'product_name',coalesce(n.product_name,d.product_name),'customer',n.customer,'lookup_error',n.lookup_error,'declared',n.declared,
    'ordered_qty',d.ordered_qty,'shipped_qty',d.shipped_qty,'cancelled',d.cancelled,
    'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by d.itemcode),'[]')
  from public.inv_delivery_requests d join public.inv_delivery_requests p on p.id=d.parent_request_id
  left join public.inv_stock_summary s on s.itemcode=d.itemcode
  cross join lateral public.warehouse_item_identity(d.itemcode) n
  where d.parent_request_id=p_parent;
$$;


create or replace function public.delivery_insert_children(p_parent public.inv_delivery_requests,p_recipe jsonb)
returns void language plpgsql set search_path=public as $$
declare component jsonb; code text; quantity bigint; item_name text; customer_name text; lookup_error text;
begin
  for component in select value from jsonb_array_elements(p_recipe->'components') loop
    code := component->>'itemcode';
    quantity := p_parent.ordered_qty::bigint*(component->>'factor')::bigint;
    if quantity>2147483647 then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
    select n.product_name,n.customer,n.lookup_error into item_name,customer_name,lookup_error
      from public.warehouse_item_identity(code) n;
    if lookup_error is not null then raise exception 'DELIVERY_CATALOG_REJECTED:%',
      jsonb_build_object('errors',jsonb_build_array(jsonb_build_object('itemcode',code,'reason',lookup_error))); end if;
    insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,product_name,customer,unit,unit_label,
      ordered_qty,source_file,created_by,delivery_source,request_type,parent_request_id)
    values(p_parent.purorder,p_parent.sales_id,code,p_parent.delivery_date,item_name,
      coalesce(customer_name,''),'EA','PCS',quantity,p_parent.source_file,p_parent.created_by,p_parent.delivery_source,'child',p_parent.id);
  end loop;
end $$;


create or replace function public.post_manual_inventory(p_request_id uuid, p_rows jsonb)
returns table (batch_id uuid, row_count integer, total_quantity bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.inv_incoming_batches%rowtype;
  v_row jsonb;
  v_item record;
  v_catalog jsonb := '{}'::jsonb;
  v_code text;
  v_count integer;
  v_total bigint := 0;
  v_quantity numeric;
  v_received date;
  v_production date;
  v_line_no integer := 0;
begin
  if v_actor is null or not public.has_permission('receipt.view')
     or not exists (select 1 from public.profiles p where p.id = v_actor and p.is_active) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_request_id is null then raise exception 'INV_INVALID_REQUEST'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'INV_INVALID_ROWS'; end if;
  v_count := jsonb_array_length(p_rows);
  if v_count not between 1 and 500 then raise exception 'INV_INVALID_ROWS'; end if;

  -- A retry with the same actor, UUID and payload returns the original result.
  -- Concurrent retries serialize here; no additional stock rows can be posted.
  perform pg_advisory_xact_lock(hashtextextended('INV_MANUAL:' || p_request_id::text, 0));
  select b.* into v_existing from public.inv_incoming_batches b where b.id = p_request_id;
  if found then
    if v_existing.entered_by is distinct from v_actor or v_existing.payload is distinct from p_rows then
      raise exception 'INV_REQUEST_CONFLICT';
    end if;
    return query select v_existing.id, v_existing.row_count, v_existing.total_quantity;
    return;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'INV_INVALID_ROW'; end if;
    v_code := btrim(coalesce(v_row->>'itemcode', ''));
    if jsonb_typeof(v_row->'itemcode') is distinct from 'string' or length(v_code) not between 1 and 200 or position('*' in v_code) > 0 then
      raise exception 'INV_INVALID_ITEMCODE';
    end if;
    if jsonb_typeof(v_row->'quantity') is distinct from 'number' then raise exception 'INV_INVALID_QUANTITY'; end if;
    v_quantity := (v_row->>'quantity')::numeric;
    if v_quantity <> trunc(v_quantity) or v_quantity not between 1 and 2147483647 then raise exception 'INV_INVALID_QUANTITY'; end if;
    v_total := v_total + v_quantity::bigint;
    if coalesce(jsonb_typeof(v_row->'note'), 'null') not in ('null', 'string')
       or length(btrim(coalesce(v_row->>'note', ''))) > 2000 then
      raise exception 'INV_INVALID_NOTE';
    end if;
    if coalesce(jsonb_typeof(v_row->'wo'), 'null') not in ('null', 'string') or length(coalesce(v_row->>'wo', '')) > 200 then raise exception 'INV_INVALID_WO'; end if;
    begin
      if jsonb_typeof(v_row->'received_date') is distinct from 'string' or coalesce(v_row->>'received_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'INV_INVALID_DATE'; end if;
      v_received := (v_row->>'received_date')::date;
      if to_char(v_received, 'YYYY-MM-DD') <> v_row->>'received_date' then raise exception 'INV_INVALID_DATE'; end if;
      if coalesce(jsonb_typeof(v_row->'production_date'), 'null') not in ('null', 'string') then raise exception 'INV_INVALID_DATE'; end if;
      if nullif(v_row->>'production_date', '') is not null then
        if v_row->>'production_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'INV_INVALID_DATE'; end if;
        v_production := (v_row->>'production_date')::date;
        if to_char(v_production, 'YYYY-MM-DD') <> v_row->>'production_date' then raise exception 'INV_INVALID_DATE'; end if;
      end if;
    exception when others then
      raise exception 'INV_INVALID_DATE';
    end;
  end loop;

  -- Resolve authoritative metadata once per item, in a stable lock order.
  for v_code in select distinct btrim(value->>'itemcode') from jsonb_array_elements(p_rows) order by 1 loop
    select r.* into v_item from public.resolve_warehouse_item(v_code) r;
    if not found or nullif(btrim(v_item.product_name), '') is null then
      raise exception 'INV_ITEM_NOT_FOUND:%', v_code;
    end if;
    v_catalog := v_catalog || jsonb_build_object(v_code, jsonb_build_object('product_name', v_item.product_name, 'customer', coalesce(v_item.customer,'')));
  end loop;

  insert into public.inv_incoming_batches(id, entered_by, payload, row_count, total_quantity)
  values (p_request_id, v_actor, p_rows, v_count, v_total);

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_line_no := v_line_no + 1;
    v_code := btrim(v_row->>'itemcode');
    insert into public.inv_incoming (
      received_date, production_date, itemcode, product_name, customer, wo,
      received_qty, issued_qty, entered_by, note, manual_batch_id, manual_line_no
    ) values (
      (v_row->>'received_date')::date, nullif(v_row->>'production_date', '')::date,
      v_code, v_catalog->v_code->>'product_name', v_catalog->v_code->>'customer', nullif(btrim(v_row->>'wo'), ''),
      (v_row->>'quantity')::numeric::integer, 0, v_actor, btrim(coalesce(v_row->>'note', '')), p_request_id, v_line_no
    );
  end loop;
  return query select p_request_id, v_count, v_total;
end;
$$;


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
        'children',jsonb_build_array(b.child_itemcode_1,b.child_itemcode_2,b.child_itemcode_3)) order by b.id)
      into recipes from public.item_build_up b where b.parent_itemcode=code;
    end if;
    return jsonb_build_object('catalog',item,'recipes',coalesce(recipes,'[]'),'catalog_lookup_version',1,
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

  foreach check_code in array array_prepend(code,children) loop
    if check_code is null then continue; end if;
    select n.lookup_error into display_name from public.warehouse_item_identity(check_code) n;
    if display_name is not null then raise exception 'WAREHOUSE_CATALOG_LOOKUP_REJECTED:%',display_name; end if;
    perform public.resolve_warehouse_item(check_code);
  end loop;

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


create or replace function public.delivery_source_state(p_id uuid)
returns jsonb language plpgsql stable set search_path=public as $$
declare d public.inv_delivery_requests%rowtype; parts jsonb; shipped bigint; stock bigint;
  bad boolean; missing bigint; signature jsonb; result jsonb;
begin
  select * into strict d from public.inv_delivery_requests where id=p_id;
  if d.request_type='child' then raise exception 'DELIVERY_SELECT_PARENT'; end if;
  if d.request_type='parent' then
    select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object(
      'factor',c.ordered_qty/d.ordered_qty,
      'customer',c.system_customer_name,
      'remaining_qty',case when c.cancelled then 0 else greatest(0,c.ordered_qty-c.shipped_qty) end,
      'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0),
      'item_shortage_qty',coalesce(s.shortage_qty,0)
    ) order by c.itemcode),'[]') into parts
    from public.inv_delivery_requests c left join public.inv_stock_summary s using(itemcode)
    where c.parent_request_id=d.id;
    select min((v->>'shipped_qty')::bigint/greatest(1,(v->>'factor')::bigint)),
      min((v->>'item_stock_qty')::bigint/greatest(1,(v->>'factor')::bigint)),
      max(ceil((v->>'item_shortage_qty')::numeric/greatest(1,(v->>'factor')::integer))),
      count(*)=0 or coalesce(bool_or(
        (v->>'factor')::integer<1 or (v->>'ordered_qty')::bigint%d.ordered_qty<>0
        or (v->>'shipped_qty')::bigint%greatest(1,(v->>'factor')::bigint)<>0
        or (not d.cancelled and (v->>'cancelled')::boolean)
      ),false) or min((v->>'shipped_qty')::bigint/greatest(1,(v->>'factor')::bigint))
        is distinct from max((v->>'shipped_qty')::bigint/greatest(1,(v->>'factor')::bigint)),
      jsonb_agg(jsonb_build_array(v->>'itemcode',(v->>'factor')::integer) order by v->>'itemcode')
    into shipped,stock,missing,bad,signature from jsonb_array_elements(parts) v;
  else
    shipped:=d.shipped_qty; bad:=false;
    select coalesce(s.balance_qty,0),coalesce(s.shortage_qty,0) into stock,missing
      from public.inv_stock_summary s where s.itemcode=d.itemcode;
    parts:=jsonb_build_array(to_jsonb(d)||jsonb_build_object('factor',1,'customer',d.system_customer_name,
      'remaining_qty',case when d.cancelled then 0 else greatest(0,d.ordered_qty-d.shipped_qty) end,
      'item_stock_qty',coalesce(stock,0)));
  end if;
  result:=to_jsonb(d)||jsonb_build_object(
    'group_key',case when d.request_type='parent' then 'parent:'||md5(jsonb_build_array(d.itemcode,signature)::text)
      else 'origin:'||md5(d.itemcode) end,
    'components',parts,'sync_error',bad,'shipped_qty',coalesce(shipped,0),
    'remaining_qty',case when d.cancelled then 0 else greatest(0,d.ordered_qty-coalesce(shipped,0)) end,
    'item_stock_qty',coalesce(stock,0),'item_shortage_qty',coalesce(missing,0),
    'status',case when d.cancelled then 'cancelled' when bad then 'partial'
      when coalesce(shipped,0)>=d.ordered_qty then 'done' when coalesce(shipped,0)>0 then 'partial' else 'pending' end);
  return result||jsonb_build_object('system_product_name',
    coalesce((select n.product_name from public.warehouse_item_identity(d.itemcode) n),d.product_name));
end $$;


create or replace function public.review_delivery_fifo(p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  if coalesce(cardinality(p_request_ids),0) not between 1 and 50000 then raise exception 'DELIVERY_INVALID_REVIEW'; end if;
  if exists(select 1 from public.inv_delivery_requests where id=any(p_request_ids) and request_type='child') then raise exception 'DELIVERY_SELECT_PARENT'; end if;
  with pending as materialized (
    select id,state as row from public.delivery_source_rows(p_request_ids)
    where not (state->>'cancelled')::boolean and ((state->>'remaining_qty')::bigint>0 or (state->>'sync_error')::boolean)
  ), groups as materialized (
    select row->>'group_key' as group_key,max(row->>'itemcode') as itemcode,max(coalesce(row->>'system_product_name',row->>'product_name')) as product_name,
      string_agg(distinct coalesce(nullif(row->>'system_customer_name',''),nullif(row->>'customer','')),
        ' / ' order by coalesce(nullif(row->>'system_customer_name',''),nullif(row->>'customer',''))) as customer,
      max(row->>'request_type') as request_type,min(row->>'delivery_date') as first_date,
      jsonb_agg(distinct row->>'delivery_date' order by row->>'delivery_date') as delivery_dates,
      sum((row->>'remaining_qty')::bigint) as quantity,count(*) as request_count,
      bool_or((row->>'sync_error')::boolean) as sync_error
    from pending group by row->>'group_key'
  ), components as materialized (
    select p.row->>'group_key' as group_key,c->>'itemcode' as itemcode,
      max(c->>'product_name') as product_name,
      string_agg(distinct nullif(c->>'customer',''),' / ' order by nullif(c->>'customer','')) as customer,
      max((c->>'factor')::integer) as factor,sum((c->>'remaining_qty')::bigint) as quantity
    from pending p cross join lateral jsonb_array_elements(p.row->'components') c
    group by p.row->>'group_key',c->>'itemcode'
  ), demand as materialized (
    select c.*,sum(c.quantity) over(partition by c.itemcode order by g.first_date,c.group_key) as finish
    from components c join groups g using(group_key)
  ), stock as materialized (
    select i.*,sum(i.balance_qty) over(partition by i.itemcode order by i.production_date nulls first,i.received_date,i.id) as finish
    from public.inv_incoming i where i.balance_qty>0 and exists(select 1 from components c where c.itemcode=i.itemcode)
  ), picked as (
    select d.group_key,d.itemcode,s.production_date,
      sum(least(d.finish,s.finish)-greatest(d.finish-d.quantity,s.finish-s.balance_qty)) as quantity
    from demand d join stock s on s.itemcode=d.itemcode and s.finish-s.balance_qty<d.finish and d.finish-d.quantity<s.finish
    group by d.group_key,d.itemcode,s.production_date
  ), fifo as (
    select group_key,itemcode,sum(quantity) as quantity,
      jsonb_agg(jsonb_build_object('production_date',production_date,'quantity',quantity) order by production_date nulls first) as days
    from picked group by group_key,itemcode
  ), details as (
    select c.group_key,jsonb_agg(jsonb_build_object('itemcode',c.itemcode,'product_name',c.product_name,'customer',c.customer,
      'factor',c.factor,'quantity',c.quantity,'shortage_qty',greatest(0,c.quantity-coalesce(f.quantity,0)),
      'item_stock_qty',coalesce(s.balance_qty,0),'days',coalesce(f.days,'[]')) order by c.itemcode) as components,
      max(ceil(greatest(0,c.quantity-coalesce(f.quantity,0))/greatest(c.factor,1)::numeric)) as shortage_qty
    from components c left join fifo f using(group_key,itemcode) left join public.inv_stock_summary s using(itemcode)
    group by c.group_key
  )
  select jsonb_build_object('group_model_version',1,'request_count',coalesce(sum(g.request_count),0),
    'rows',coalesce(jsonb_agg(jsonb_build_object('group_key',g.group_key,'request_type',g.request_type,
      'itemcode',g.itemcode,'product_name',g.product_name,'customer',g.customer,'quantity',g.quantity,
      'delivery_dates',g.delivery_dates,'sync_error',g.sync_error,'components',d.components,
      'shortage_qty',d.shortage_qty,'days',case when g.request_type='origin' then d.components->0->'days' else '[]'::jsonb end
    ) order by g.first_date,g.group_key),'[]'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',id,'version',row->'version',
      'itemcode',row->>'itemcode','group_key',row->>'group_key',
      'components',(select jsonb_agg(jsonb_build_object('id',c->>'id','version',c->'version') order by c->>'id')
        from jsonb_array_elements(row->'components') c)) order by row->>'delivery_date',row->>'created_at',id) from pending),'[]'))
  into result from groups g join details d using(group_key);
  return result;
end $$;


create or replace function public.manage_delivery(p_action text,p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); cmd public.inv_delivery_commands%rowtype; kind text; result jsonb; output jsonb:='[]'; x jsonb; identity record; validation jsonb; code text;
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
  if p_action in ('ship','cancel','edit') then
    select request_type into kind from public.inv_delivery_requests where id=(p_payload->>'id')::uuid;
    if kind='child' or (kind='parent' and p_action='ship') then raise exception 'DELIVERY_SELECT_PARENT'; end if;
  end if;
  if p_action in ('preview','import') then
    result:=public.manage_delivery_components_v1('preview',null,p_payload);
    if p_action='preview' then
      for x in select value from jsonb_array_elements(result->'rows') loop
        select * into identity from public.warehouse_item_identity(x->>'itemcode');
        output:=output||jsonb_build_array(x||jsonb_build_object('system_product_name',identity.product_name,
          'system_customer_name',identity.customer,'catalog_error',identity.lookup_error));
      end loop;
      return result||jsonb_build_object('rows',output,'catalog_lookup_version',1);
    end if;
    validation:=public.delivery_catalog_validation(result->'rows');
    if jsonb_array_length(validation->'errors')>0 then raise exception 'DELIVERY_CATALOG_REJECTED:%',validation; end if;
    for code in select distinct value from jsonb_array_elements_text(validation->'codes') order by value loop
      perform public.resolve_warehouse_item(code);
    end loop;
  end if;
  return public.manage_delivery_components_v1(p_action,p_command_id,p_payload);
end $$;


alter function public.post_manual_delivery(uuid,jsonb) rename to post_manual_delivery_catalog_v1;
revoke all on function public.post_manual_delivery_catalog_v1(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.post_manual_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); cmd public.inv_delivery_commands%rowtype; validation jsonb; code text;
begin
  if actor is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into cmd from public.inv_delivery_commands where id=p_command_id;
  if found then
    if cmd.actor is distinct from actor or cmd.action<>'manual' or cmd.payload is distinct from p_payload then raise exception 'DELIVERY_COMMAND_CONFLICT'; end if;
    return cmd.result;
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'DELIVERY_INVALID_ROW'; end if;
  validation:=public.delivery_catalog_validation(jsonb_build_array(p_payload));
  if jsonb_array_length(validation->'errors')>0 then raise exception 'DELIVERY_CATALOG_REJECTED:%',validation; end if;
  for code in select distinct value from jsonb_array_elements_text(validation->'codes') order by value loop
    perform public.resolve_warehouse_item(code);
  end loop;
  return public.post_manual_delivery_catalog_v1(p_command_id,p_payload);
end $$;
revoke all on function public.post_manual_delivery(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.post_manual_delivery(uuid,jsonb) to authenticated;


select public.refresh_delivery_system_customers(array(select distinct itemcode from public.inv_delivery_requests));

notify pgrst,'reload schema';
commit;
