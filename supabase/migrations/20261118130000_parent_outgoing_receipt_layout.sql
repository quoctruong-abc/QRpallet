begin;

-- Read-only presentation of recorded issues: the parent carries the request,
-- while its children retain their actual shipped quantities. No FIFO or unit
-- conversion is performed here, and no current build-up default is consulted.
create or replace function public.list_outgoing_receipts(p_from date default null,p_to date default null,p_offset integer default 0)
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
  with entries as materialized (
    select i.shipped_date,i.quantity,i.entered_by_name,d.*
    from public.inv_delivery_issues i join public.inv_delivery_requests d on d.id=i.request_id
    where (p_from is null or i.shipped_date>=p_from) and (p_to is null or i.shipped_date<=p_to)
  ), ordinary as (
    select e.shipped_date,e.itemcode,'origin:'||e.itemcode as group_key,
      jsonb_build_object('request_type','origin','shipped_date',e.shipped_date,'itemcode',e.itemcode,
        'product_name',max(nullif(btrim(e.product_name),'')),
        'customer',string_agg(distinct coalesce(nullif(btrim(e.system_customer_name),''),nullif(btrim(e.customer),'')),
          ' / ' order by coalesce(nullif(btrim(e.system_customer_name),''),nullif(btrim(e.customer),''))),
        'quantity',sum(e.quantity),'creator_name',string_agg(distinct e.entered_by_name,' / ' order by e.entered_by_name)) as row
    from entries e where e.request_type='origin' group by e.shipped_date,e.itemcode
  ), children as materialized (
    select e.shipped_date,e.parent_request_id,e.itemcode,
      jsonb_build_object('itemcode',e.itemcode,'product_name',max(nullif(btrim(e.product_name),'')),
        'customer',string_agg(distinct nullif(btrim(e.system_customer_name),''),' / ' order by nullif(btrim(e.system_customer_name),'')),
        'quantity',sum(e.quantity),'creator_name',string_agg(distinct e.entered_by_name,' / ' order by e.entered_by_name)) as row
    from entries e where e.request_type='child' group by e.shipped_date,e.parent_request_id,e.itemcode
  ), parents as (
    select c.shipped_date,p.itemcode,'parent:'||p.id::text as group_key,
      jsonb_build_object('request_type','parent','request_id',p.id,'shipped_date',c.shipped_date,
        'itemcode',p.itemcode,'product_name',p.product_name,
        'customer',coalesce(nullif(btrim(p.system_customer_name),''),nullif(btrim(p.customer),'')),
        'purorder',p.purorder,'sales_id',p.sales_id,'delivery_date',p.delivery_date,
        'delivery_source',p.delivery_source,'ordered_qty',p.ordered_qty,
        'components',jsonb_agg(c.row order by c.itemcode)) as row
    from children c join public.inv_delivery_requests p on p.id=c.parent_request_id
    group by c.shipped_date,p.id
  ), grouped as materialized (
    select * from ordinary union all select * from parents
  ), page as (
    select * from grouped order by shipped_date desc,itemcode,group_key
    limit case when p_from is null then 10 else 50 end
    offset case when p_from is null then 0 else p_offset end
  )
  select jsonb_build_object('receipt_layout_version',1,
    'rows',coalesce((select jsonb_agg(row||jsonb_build_object('group_key',group_key)
      order by shipped_date desc,itemcode,group_key) from page),'[]'),
    'total',(select case when p_from is null then least(count(*),10) else count(*) end from grouped)
  ) into result;
  return result;
end $$;

create function public.outgoing_parent_receipt_details(p_shipped_date date,p_parent_id uuid,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if p_shipped_date is null or p_parent_id is null or p_offset is null or p_offset<0 then
    raise exception 'DELIVERY_INVALID_RECEIPT';
  end if;
  with entries as materialized (
    select i.id,i.created_at,i.quantity,i.entered_by_name as creator_name,
      d.id as request_id,d.itemcode,d.product_name,nullif(btrim(d.system_customer_name),'') as customer,d.ordered_qty
    from public.inv_delivery_issues i join public.inv_delivery_requests d on d.id=i.request_id
    where i.shipped_date=p_shipped_date and d.parent_request_id=p_parent_id and d.request_type='child'
  ), page as (
    select e.*,coalesce(l.lots,'[]') as lots
    from (select * from entries order by itemcode,created_at desc,id limit 50 offset p_offset) e
    left join lateral (
      select jsonb_agg(jsonb_build_object('incoming_id',l.incoming_id::text,'production_date',n.production_date,'quantity',l.quantity)
        order by n.production_date nulls first,n.received_date,n.id) as lots
      from public.inv_delivery_issue_lines l join public.inv_incoming n on n.id=l.incoming_id where l.issue_id=e.id
    ) l on true
  )
  select jsonb_build_object('total',(select count(*) from entries),
    'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.itemcode,p.created_at desc,p.id) from page p),'[]')) into result;
  return result;
end $$;
revoke all on function public.outgoing_parent_receipt_details(date,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.outgoing_parent_receipt_details(date,uuid,integer) to authenticated;

create or replace function public.outgoing_receipt_details(p_shipped_date date,p_itemcode text,p_offset integer default 0)
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
    where i.shipped_date=p_shipped_date and d.itemcode=p_itemcode and d.request_type='origin'
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
