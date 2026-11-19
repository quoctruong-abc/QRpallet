begin;

create or replace function public.post_bulk_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  cmd public.inv_delivery_commands%rowtype;
  request_rows jsonb;
  lot_rows jsonb;
  shipped_on date;
  allocations jsonb;
  result jsonb;
  operator_name text;
  short_item text;
begin
  select coalesce(nullif(btrim(p.full_name),''),p.username) into operator_name
    from public.profiles p where p.id=actor and p.is_active;
  if not found or not public.has_permission('receipt.view') then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'DELIVERY_INVALID_BULK'; end if;

  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into cmd from public.inv_delivery_commands c where c.id=p_command_id;
  if found then
    if cmd.actor is distinct from actor or cmd.action<>'bulk_ship' or cmd.payload is distinct from p_payload then
      raise exception 'DELIVERY_COMMAND_CONFLICT';
    end if;
    return cmd.result;
  end if;

  request_rows := p_payload->'requests';
  lot_rows := p_payload->'lots';
  if coalesce(p_payload->>'shipped_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(request_rows) is distinct from 'array' or jsonb_typeof(lot_rows) is distinct from 'array'
    then raise exception 'DELIVERY_INVALID_BULK'; end if;
  if jsonb_array_length(request_rows) not between 1 and 50000 or jsonb_array_length(lot_rows) not between 1 and 50000
    then raise exception 'DELIVERY_INVALID_BULK'; end if;
  if exists(select from jsonb_array_elements(request_rows) r where coalesce(r->>'id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or jsonb_typeof(r->'version') is distinct from 'number' or coalesce(r->>'version','') !~ '^[1-9][0-9]{0,9}$')
    or exists(select from jsonb_array_elements(lot_rows) l where jsonb_typeof(l->'incoming_id') is distinct from 'string'
      or coalesce(l->>'incoming_id','') !~ '^[1-9][0-9]{0,18}$'
      or jsonb_typeof(l->'quantity') is distinct from 'number' or coalesce(l->>'quantity','') !~ '^[1-9][0-9]{0,9}$')
    then raise exception 'DELIVERY_INVALID_BULK'; end if;
  shipped_on := (p_payload->>'shipped_date')::date;

  if (select count(distinct id) from jsonb_to_recordset(request_rows) as r(id uuid)) <> jsonb_array_length(request_rows)
    or (select count(distinct incoming_id) from jsonb_to_recordset(lot_rows) as l(incoming_id bigint)) <> jsonb_array_length(lot_rows)
    then raise exception 'DELIVERY_INVALID_BULK'; end if;
  if exists(
    select from jsonb_to_recordset(request_rows) as r(id uuid,version integer)
    left join public.inv_delivery_requests d using(id)
    where d.id is null or d.version<>r.version or d.cancelled or d.shipped_qty>=d.ordered_qty
  ) then raise exception 'DELIVERY_STALE'; end if;
  if exists(
    select from jsonb_to_recordset(lot_rows) as l(incoming_id bigint,quantity integer)
    left join public.inv_incoming i on i.id=l.incoming_id
    where i.id is null or i.balance_qty<l.quantity
  ) then raise exception 'DELIVERY_INSUFFICIENT_STOCK'; end if;
  if exists(
    select from jsonb_to_recordset(lot_rows) as l(incoming_id bigint)
    join public.inv_incoming i on i.id=l.incoming_id
    where not exists (
      select from jsonb_to_recordset(request_rows) as r(id uuid)
      join public.inv_delivery_requests d using(id) where d.itemcode=i.itemcode
    )
  ) then raise exception 'DELIVERY_BULK_LOT_MISMATCH'; end if;

  -- Use the same inventory lock as normal shipping. A partial lot choice is
  -- allowed only if physical stock can still cover the selected item's demand.
  with demand as (
    select d.itemcode,sum(d.ordered_qty-d.shipped_qty) as quantity
    from jsonb_to_recordset(request_rows) as r(id uuid)
    join public.inv_delivery_requests d using(id) group by d.itemcode
  )
  select d.itemcode into short_item
  from demand d left join lateral (
    select sum(i.balance_qty) as quantity from public.inv_incoming i
    where i.itemcode=d.itemcode and i.balance_qty>0
  ) stock on true
  where coalesce(stock.quantity,0)<d.quantity
  order by d.itemcode limit 1;
  if found then raise exception 'DELIVERY_BULK_SHORT_STOCK:%',short_item; end if;

  -- Meet selected requests in delivery order. Any excess belongs to the last
  -- selected request of that item, so it is recorded without changing its plan.
  with supply as materialized (
    select i.id as incoming_id,i.itemcode,l.quantity,
      sum(l.quantity) over(partition by i.itemcode order by i.production_date nulls first,i.received_date,i.id) as finish
    from jsonb_to_recordset(lot_rows) as l(incoming_id bigint,quantity integer) join public.inv_incoming i on i.id=l.incoming_id
  ), supply_totals as (
    select itemcode,max(finish) as quantity from supply group by itemcode
  ), demand_ordered as (
    select d.id as request_id,d.itemcode,d.ordered_qty-d.shipped_qty as quantity,
      sum(d.ordered_qty-d.shipped_qty) over(partition by d.itemcode order by d.delivery_date,d.created_at,d.id) as finish,
      row_number() over(partition by d.itemcode order by d.delivery_date desc,d.created_at desc,d.id desc)=1 as last_request
    from jsonb_to_recordset(request_rows) as r(id uuid) join public.inv_delivery_requests d using(id)
  ), demand as materialized (
    select d.request_id,d.itemcode,gen_random_uuid() as issue_id,d.finish-d.quantity as start_at,
      case when d.last_request then greatest(d.finish,s.quantity) else d.finish end as finish
    from demand_ordered d join supply_totals s using(itemcode)
  )
  select jsonb_agg(jsonb_build_object('request_id',d.request_id,'issue_id',d.issue_id,'incoming_id',s.incoming_id,
    'quantity',least(d.finish,s.finish)-greatest(d.start_at,s.finish-s.quantity)))
  into allocations
  from demand d join supply s on s.itemcode=d.itemcode and s.finish-s.quantity<d.finish and d.start_at<s.finish;

  if exists (
    select from jsonb_to_recordset(allocations) as a(request_id uuid,quantity integer)
    join public.inv_delivery_requests d on d.id=a.request_id
    group by d.id,d.shipped_qty having sum(a.quantity)>2147483647-d.shipped_qty
  ) then raise exception 'DELIVERY_BULK_QTY_LIMIT'; end if;

  insert into public.inv_delivery_issues(id,request_id,quantity,shipped_date,entered_by,entered_by_name)
    select a.issue_id,a.request_id,sum(a.quantity),shipped_on,actor,operator_name
    from jsonb_to_recordset(allocations) as a(issue_id uuid,request_id uuid,quantity integer)
    group by a.issue_id,a.request_id;
  insert into public.inv_delivery_issue_lines(issue_id,incoming_id,quantity)
    select a.issue_id,a.incoming_id,a.quantity
    from jsonb_to_recordset(allocations) as a(issue_id uuid,incoming_id bigint,quantity integer);
  update public.inv_incoming i set issued_qty=i.issued_qty+x.quantity
    from (select a.incoming_id,sum(a.quantity) as quantity
      from jsonb_to_recordset(allocations) as a(incoming_id bigint,quantity integer) group by a.incoming_id) x
    where i.id=x.incoming_id;
  update public.inv_delivery_requests d set shipped_qty=d.shipped_qty+x.quantity,version=d.version+1,updated_at=now()
    from (select a.request_id,sum(a.quantity) as quantity
      from jsonb_to_recordset(allocations) as a(request_id uuid,quantity integer) group by a.request_id) x
    where d.id=x.request_id;

  select jsonb_build_object('shipped',sum(a.quantity),'request_count',count(distinct a.request_id)) into result
    from jsonb_to_recordset(allocations) as a(request_id uuid,quantity integer);
  insert into public.inv_delivery_commands(id,actor,action,payload,result)
    values(p_command_id,actor,'bulk_ship',p_payload,result);
  return result;
end $$;

notify pgrst,'reload schema';
commit;
