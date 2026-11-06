begin;

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
    where d.id=any(p_request_ids) and not d.cancelled and d.shipped_qty<d.ordered_qty
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

-- Require dates for newly posted manual rows. Existing rows and retries remain valid.
create function public.require_manual_inventory_production_date()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.manual_batch_id is not null and new.production_date is null then
    raise exception 'INV_PRODUCTION_DATE_REQUIRED';
  end if;
  return new;
end $$;
create trigger inv_manual_production_date_required before insert on public.inv_incoming
  for each row execute function public.require_manual_inventory_production_date();
revoke all on function public.require_manual_inventory_production_date() from public,anon,authenticated,service_role;

create index inv_delivery_issues_shipped_date_idx
  on public.inv_delivery_issues(shipped_date desc,request_id,created_at desc);

create function public.list_outgoing_receipts(p_from date default null,p_to date default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if p_offset is null or p_offset<0 or (p_from is null)<>(p_to is null) or p_from>p_to then
    raise exception 'DELIVERY_INVALID_DATE';
  end if;
  with grouped as materialized (
    select i.shipped_date,d.itemcode,sum(i.quantity) as quantity,
      max(nullif(btrim(d.product_name),'')) as product_name,
      string_agg(distinct coalesce(nullif(btrim(d.system_customer_name),''),nullif(btrim(d.customer),'')),
        ' / ' order by coalesce(nullif(btrim(d.system_customer_name),''),nullif(btrim(d.customer),''))) as customer,
      string_agg(distinct i.entered_by_name,' / ' order by i.entered_by_name) as creator_name
    from public.inv_delivery_issues i join public.inv_delivery_requests d on d.id=i.request_id
    where (p_from is null or i.shipped_date>=p_from) and (p_to is null or i.shipped_date<=p_to)
    group by i.shipped_date,d.itemcode
  ), page as (
    select * from grouped order by shipped_date desc,itemcode
    limit case when p_from is null then 10 else 50 end
    offset case when p_from is null then 0 else p_offset end
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.shipped_date desc,p.itemcode) from page p),'[]'),
    'total',(select case when p_from is null then least(count(*),10) else count(*) end from grouped)
  ) into result;
  return result;
end $$;

create function public.outgoing_receipt_details(p_shipped_date date,p_itemcode text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if p_shipped_date is null or length(btrim(coalesce(p_itemcode,''))) not between 1 and 200
    or p_offset is null or p_offset<0 then raise exception 'DELIVERY_INVALID_RECEIPT'; end if;
  with entries as materialized (
    select i.id,i.created_at,i.quantity,i.entered_by_name as creator_name,
      d.id as request_id,d.delivery_date,d.purorder,d.sales_id,d.delivery_source,d.ordered_qty
    from public.inv_delivery_issues i join public.inv_delivery_requests d on d.id=i.request_id
    where i.shipped_date=p_shipped_date and d.itemcode=p_itemcode
  ), page as (
    select e.*,coalesce(l.lots,'[]') as lots
    from (select * from entries order by created_at desc,id limit 50 offset p_offset) e
    left join lateral (
      select jsonb_agg(jsonb_build_object('incoming_id',l.incoming_id::text,'production_date',n.production_date,'quantity',l.quantity)
        order by n.production_date nulls first,n.received_date,n.id) as lots
      from public.inv_delivery_issue_lines l join public.inv_incoming n on n.id=l.incoming_id where l.issue_id=e.id
    ) l on true
  )
  select jsonb_build_object('total',(select count(*) from entries),
    'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id) from page p),'[]')) into result;
  return result;
end $$;

revoke all on function public.list_outgoing_receipts(date,date,integer),public.outgoing_receipt_details(date,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_outgoing_receipts(date,date,integer),public.outgoing_receipt_details(date,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;
