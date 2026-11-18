begin;

select pg_advisory_xact_lock(72638104112000::bigint);

-- Each component owns its catalog identity; a parent's customer is never inherited.
create function public.delivery_component_identity(p_itemcode text)
returns table(product_name text,customer text)
language sql stable set search_path=public as $$
  select coalesce(nullif(btrim(c.product_name),''),nullif(btrim(c."ERP_name"),''),l.product_name,p_itemcode),
    coalesce(nullif(btrim(c.customer),''),l.customer)
  from (values(p_itemcode)) x(itemcode)
  left join public.item_pallet_config c using(itemcode)
  left join lateral public.lookup_manual_delivery_item(x.itemcode) l on true;
$$;
revoke all on function public.delivery_component_identity(text) from public,anon,authenticated,service_role;

create or replace function public.delivery_build_up_options(p_itemcode text)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token',r.id::text||':'||md5(to_jsonb(c.codes)::text),'codes',c.codes,
    'components',(select coalesce(jsonb_agg(jsonb_build_object('itemcode',x.itemcode,'factor',x.factor,
       'product_name',n.product_name,'customer',n.customer,
       'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by x.itemcode),'[]')
      from (select itemcode,count(*) as factor from unnest(c.codes) u(itemcode) where itemcode is not null group by itemcode) x
      left join public.inv_stock_summary s using(itemcode)
      cross join lateral public.delivery_component_identity(x.itemcode) n)) order by r.id),'[]')
  from public.item_build_up r
  cross join lateral (select array[r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3] as codes) c
  where r.parent_itemcode=p_itemcode;
$$;

create or replace function public.delivery_saved_components(p_parent uuid)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemcode',d.itemcode,'factor',d.ordered_qty/p.ordered_qty,
    'product_name',d.product_name,'customer',d.system_customer_name,
    'ordered_qty',d.ordered_qty,'shipped_qty',d.shipped_qty,'cancelled',d.cancelled,
    'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by d.itemcode),'[]')
  from public.inv_delivery_requests d join public.inv_delivery_requests p on p.id=d.parent_request_id
  left join public.inv_stock_summary s on s.itemcode=d.itemcode
  where d.parent_request_id=p_parent;
$$;

create or replace function public.delivery_insert_children(p_parent public.inv_delivery_requests,p_recipe jsonb)
returns void language plpgsql set search_path=public as $$
declare component jsonb; code text; quantity bigint; item_name text; customer_name text;
begin
  for component in select value from jsonb_array_elements(p_recipe->'components') loop
    code := component->>'itemcode';
    quantity := p_parent.ordered_qty::bigint*(component->>'factor')::bigint;
    if quantity>2147483647 then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
    select n.product_name,n.customer into item_name,customer_name
      from public.delivery_component_identity(code) n;
    insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,product_name,customer,unit,unit_label,
      ordered_qty,source_file,created_by,delivery_source,request_type,parent_request_id)
    values(p_parent.purorder,p_parent.sales_id,code,p_parent.delivery_date,item_name,
      coalesce(customer_name,''),'EA','PCS',quantity,p_parent.source_file,p_parent.created_by,p_parent.delivery_source,'child',p_parent.id);
  end loop;
end $$;

create or replace function public.set_delivery_system_customer()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.request_type='child' then
    select n.customer into new.system_customer_name from public.delivery_component_identity(new.itemcode) n;
  else
    new.system_customer_name := coalesce(public.resolve_delivery_system_customer(new.itemcode),
      case when new.delivery_source='manual' then nullif(new.customer,'') end);
  end if;
  return new;
end $$;

create or replace function public.refresh_delivery_system_customers(p_items text[])
returns void language sql security definer set search_path=public as $$
  with names as materialized (
    select d.itemcode,public.resolve_delivery_system_customer(d.itemcode) as customer,n.customer as component_customer
    from (select distinct r.itemcode from public.inv_delivery_requests r where r.itemcode=any(p_items)) d
    cross join lateral public.delivery_component_identity(d.itemcode) n
  ), resolved as (
    select r.id,case when r.request_type='child' then n.component_customer
      else coalesce(n.customer,case when r.delivery_source='manual' then nullif(r.customer,'') end) end as customer
    from public.inv_delivery_requests r join names n using(itemcode)
  )
  update public.inv_delivery_requests r set system_customer_name=x.customer
    from resolved x where r.id=x.id and r.system_customer_name is distinct from x.customer;
$$;

-- Correct identities on already-created child rows without changing plans or shipping versions.
with names as materialized (
  select x.itemcode,n.product_name,n.customer
  from (select distinct itemcode from public.inv_delivery_requests where request_type='child') x
  cross join lateral public.delivery_component_identity(x.itemcode) n
)
update public.inv_delivery_requests d
set product_name=n.product_name,customer=coalesce(n.customer,''),system_customer_name=n.customer
from names n where d.request_type='child' and d.itemcode=n.itemcode
  and (d.product_name,d.customer,d.system_customer_name) is distinct from (n.product_name,coalesce(n.customer,''),n.customer);

create or replace function public.list_delivery(p_offset integer default 0,p_search text default '',p_closed boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select jsonb_build_object('total',count(*),'model_version',2) into result from public.inv_delivery_requests d
    left join public.inv_delivery_requests p on p.id=d.parent_request_id
    where d.request_type<>'parent' and (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
      and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer,p.itemcode)))>0);
  return result || jsonb_build_object('rows',coalesce((
    select jsonb_agg(q.row order by q.delivery_date,q.created_at,q.id) from (
      select d.id,d.delivery_date,d.created_at,to_jsonb(d)||jsonb_build_object(
        'parent_itemcode',p.itemcode,
        'system_customer_name',d.system_customer_name,
        'remaining_qty',case when d.cancelled then 0 else greatest(0,d.ordered_qty-d.shipped_qty) end,
        'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0),
        'item_available_qty',coalesce(s.available_qty,0),'item_shortage_qty',coalesce(s.shortage_qty,0),
        'status',case when d.cancelled then 'cancelled' when d.shipped_qty>=d.ordered_qty then 'done' when d.shipped_qty>0 then 'partial' else 'pending' end
      ) as row from public.inv_delivery_requests d
      left join public.inv_delivery_requests p on p.id=d.parent_request_id
      left join public.inv_stock_summary s on s.itemcode=d.itemcode
      where d.request_type<>'parent' and (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
        and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer,p.itemcode)))>0)
      order by d.delivery_date,d.created_at,d.id limit 100 offset greatest(0,p_offset)
    ) q
  ),'[]'));
end $$;

create or replace function public.review_delivery_fifo(p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if coalesce(cardinality(p_request_ids),0) not between 1 and 50000 then
    raise exception 'DELIVERY_INVALID_REVIEW';
  end if;

  with pending as (
    select d.itemcode,d.delivery_date,d.ordered_qty-d.shipped_qty as remaining_qty,
      nullif(btrim(d.product_name),'') as product_name,
      nullif(btrim(d.system_customer_name),'') as system_customer,
      nullif(btrim(d.customer),'') as erp_customer
    from public.inv_delivery_requests d
    where d.id=any(p_request_ids) and d.request_type<>'parent' and not d.cancelled and d.shipped_qty<d.ordered_qty
  ), demand as materialized (
    select itemcode,sum(remaining_qty) as quantity,count(*) as request_count,
      max(product_name) as product_name,
      jsonb_agg(distinct delivery_date order by delivery_date) as delivery_dates,
      coalesce(string_agg(distinct system_customer,' / ' order by system_customer),
        string_agg(distinct erp_customer,' / ' order by erp_customer)) as customer
    from pending group by itemcode
  ), stock_days as (
    -- FIFO sorts by production date (unknown first), then by receipt and lot.
    -- Within the same production date, only the aggregate quantity is shown.
    select i.itemcode,i.production_date,sum(i.balance_qty) as balance
    from demand d join public.inv_incoming i using(itemcode)
    where i.balance_qty>0 group by i.itemcode,i.production_date
  ), ordered as (
    select *,coalesce(sum(balance) over(partition by itemcode order by production_date nulls first
      rows between unbounded preceding and 1 preceding),0) as previous
    from stock_days
  ), assigned as (
    select s.itemcode,s.production_date,least(s.balance,d.quantity-s.previous) as quantity
    from ordered s join demand d using(itemcode) where s.previous<d.quantity
  ), fifo as (
    select itemcode,sum(quantity) as quantity,
      jsonb_agg(jsonb_build_object('production_date',production_date,'quantity',quantity)
        order by production_date nulls first) as days
    from assigned group by itemcode
  )
  select jsonb_build_object(
    'request_count',coalesce(sum(d.request_count),0),
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'itemcode',d.itemcode,
      'product_name',coalesce(nullif(btrim(s.product_name),''),d.product_name,''),
      'customer',d.customer,
      'delivery_dates',d.delivery_dates,
      'quantity',d.quantity,
      'shortage_qty',d.quantity-coalesce(f.quantity,0),
      'days',coalesce(f.days,'[]')
    ) order by d.itemcode),'[]')
  ) into result
  from demand d left join fifo f using(itemcode) left join public.inv_stock_summary s using(itemcode);
  return result;
end $$;

notify pgrst,'reload schema';
commit;
