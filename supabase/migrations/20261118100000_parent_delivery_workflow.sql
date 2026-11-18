begin;

select pg_advisory_xact_lock(72638104112000::bigint);

-- Keep the immutable child plan as the recipe snapshot. Parent progress is
-- derived from real child issues, including records created before this change.
create function public.delivery_source_state(p_id uuid)
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
  return result;
end $$;

create function public.delivery_source_rows(p_ids uuid[])
returns table(id uuid,state jsonb) language sql stable set search_path=public as $$
  select d.id,public.delivery_source_state(d.id)
  from public.inv_delivery_requests d where d.id=any(p_ids) and d.request_type<>'child';
$$;
revoke all on function public.delivery_source_state(uuid),public.delivery_source_rows(uuid[]) from public,anon,authenticated,service_role;

create or replace function public.list_delivery(p_offset integer default 0,p_search text default '',p_closed boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  with source as materialized (
    select d.id,public.delivery_source_state(d.id) as row from public.inv_delivery_requests d
    where d.request_type<>'child' and (p_closed or not d.cancelled)
  ), filtered as (
    select * from source where
      (p_closed or (row->>'remaining_qty')::bigint>0 or (row->>'sync_error')::boolean)
      and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',
        row->>'purorder',row->>'sales_id',row->>'itemcode',row->>'product_name',
        row->>'customer',row->>'system_customer_name',row->'components'))) > 0)
  )
  select jsonb_build_object('model_version',2,'group_model_version',1,'total',(select count(*) from filtered),
    'rows',coalesce((select jsonb_agg(row order by row->>'delivery_date',row->>'created_at',id)
      from (select * from filtered order by row->>'delivery_date',row->>'created_at',id
        limit 100 offset greatest(0,p_offset)) q),'[]')) into result;
  return result;
end $$;

-- Group by parent code AND saved recipe so different alternatives never share
-- an allocation. One FIFO pool per stock item is shared across all groups.
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
    select row->>'group_key' as group_key,max(row->>'itemcode') as itemcode,max(row->>'product_name') as product_name,
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

create or replace function public.preview_bulk_delivery(p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare review jsonb; lots jsonb;
begin
  review:=public.review_delivery_fifo(p_request_ids);
  select coalesce(jsonb_object_agg(itemcode,rows),'{}') into lots from (
    select i.itemcode,jsonb_agg(jsonb_build_object('incoming_id',i.id::text,'production_date',i.production_date,
      'received_date',i.received_date,'balance_qty',i.balance_qty)
      order by i.production_date nulls first,i.received_date,i.id) as rows
    from public.inv_incoming i
    where i.balance_qty>0 and exists(select 1 from jsonb_array_elements(review->'rows') g,
      jsonb_array_elements(g->'components') c where c->>'itemcode'=i.itemcode)
    group by i.itemcode
  ) q;
  return review||jsonb_build_object('lots',lots);
end $$;

alter function public.post_bulk_delivery(uuid,jsonb) rename to post_bulk_delivery_components_v1;
revoke all on function public.post_bulk_delivery_components_v1(uuid,jsonb) from public,anon,authenticated,service_role;

create function public.post_bulk_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); operator_name text; cmd public.inv_delivery_commands%rowtype;
  request_rows jsonb; lot_rows jsonb; ids uuid[]; preview jsonb; group_units jsonb;
  allocations jsonb; result jsonb; shipped_on date; short_item text;
begin
  select coalesce(nullif(btrim(p.full_name),''),p.username) into operator_name
    from public.profiles p where p.id=actor and p.is_active;
  if not found or not public.has_permission('receipt.view') then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'DELIVERY_INVALID_BULK'; end if;
  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into cmd from public.inv_delivery_commands where id=p_command_id;
  if found then
    if cmd.actor is distinct from actor or cmd.action<>'bulk_ship' or cmd.payload is distinct from p_payload then
      raise exception 'DELIVERY_COMMAND_CONFLICT';
    end if;
    return cmd.result;
  end if;
  request_rows:=p_payload->'requests'; lot_rows:=p_payload->'lots';
  if jsonb_typeof(request_rows) is distinct from 'array' or jsonb_typeof(lot_rows) is distinct from 'array'
    or coalesce(p_payload->>'shipped_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'DELIVERY_INVALID_BULK'; end if;
  if jsonb_array_length(request_rows) not between 1 and 50000
    or jsonb_array_length(lot_rows) not between 1 and 50000 then raise exception 'DELIVERY_INVALID_BULK'; end if;
  if exists(select 1 from jsonb_array_elements(request_rows) r
    where coalesce(r->>'id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or jsonb_typeof(r->'version') is distinct from 'number'
      or coalesce(r->>'version','') !~ '^[1-9][0-9]{0,9}$') then raise exception 'DELIVERY_INVALID_BULK'; end if;
  select array_agg((r->>'id')::uuid) into ids from jsonb_array_elements(request_rows) r;
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) u(id)) then raise exception 'DELIVERY_INVALID_BULK'; end if;
  -- Old origin-only requests still work. Old clients may not issue child stock independently.
  if p_payload->>'group_model_version' is distinct from '1' then
    if exists(select 1 from public.inv_delivery_requests where id=any(ids) and request_type<>'origin') then
      raise exception 'DELIVERY_SELECT_PARENT';
    end if;
    return public.post_bulk_delivery_components_v1(p_command_id,p_payload);
  end if;
  if exists(select 1 from jsonb_array_elements(lot_rows) l where
    coalesce(l->>'group_key','') !~ '^(origin|parent):[a-f0-9]{32}$'
    or jsonb_typeof(l->'incoming_id') is distinct from 'string'
    or coalesce(l->>'incoming_id','') !~ '^[1-9][0-9]{0,18}$'
    or jsonb_typeof(l->'quantity') is distinct from 'number'
    or coalesce(l->>'quantity','') !~ '^[1-9][0-9]{0,9}$')
    or (select count(distinct (l->>'group_key',l->>'incoming_id')) from jsonb_array_elements(lot_rows) l)<>jsonb_array_length(lot_rows)
    then raise exception 'DELIVERY_INVALID_BULK'; end if;
  shipped_on:=(p_payload->>'shipped_date')::date;
  preview:=public.preview_bulk_delivery(ids);
  if jsonb_array_length(preview->'requests')<>cardinality(ids) or exists(
    select 1 from jsonb_array_elements(request_rows) r
    left join jsonb_array_elements(preview->'requests') e on e->>'id'=r->>'id'
    where e is null or e->'version' is distinct from r->'version'
      or e->'components' is distinct from r->'components'
  ) then raise exception 'DELIVERY_STALE'; end if;
  if exists(select 1 from jsonb_array_elements(preview->'rows') g where (g->>'sync_error')::boolean) then
    raise exception 'DELIVERY_COMPONENTS_OUT_OF_SYNC';
  end if;
  if exists(
    select 1 from jsonb_array_elements(lot_rows) l
    left join public.inv_incoming i on i.id=(l->>'incoming_id')::bigint
    where i.id is null or not exists(
      select 1 from jsonb_array_elements(preview->'rows') g,
      jsonb_array_elements(g->'components') c
      where g->>'group_key'=l->>'group_key' and c->>'itemcode'=i.itemcode
    )
  ) then raise exception 'DELIVERY_BULK_LOT_MISMATCH'; end if;
  -- Every selected group's complete outstanding demand must fit the common pool.
  with demand as (
    select c->>'itemcode' as itemcode,sum((c->>'quantity')::bigint) as quantity
    from jsonb_array_elements(preview->'rows') g,jsonb_array_elements(g->'components') c group by c->>'itemcode'
  )
  select d.itemcode into short_item from demand d
  left join public.inv_stock_summary s using(itemcode)
  where d.quantity>coalesce(s.balance_qty,0) order by d.itemcode limit 1;
  if found then raise exception 'DELIVERY_BULK_SHORT_STOCK:%',short_item; end if;
  if exists(
    select 1 from jsonb_array_elements(lot_rows) l join public.inv_incoming i on i.id=(l->>'incoming_id')::bigint
    group by i.id,i.balance_qty having sum((l->>'quantity')::bigint)>i.balance_qty
  ) then raise exception 'DELIVERY_INSUFFICIENT_STOCK'; end if;
  -- Equal parent-equivalent quantities are mandatory, including edited lots and excess.
  with chosen as (
    select l->>'group_key' as group_key,i.itemcode,sum((l->>'quantity')::bigint) as quantity
    from jsonb_array_elements(lot_rows) l join public.inv_incoming i on i.id=(l->>'incoming_id')::bigint
    group by l->>'group_key',i.itemcode
  ), units as (
    select g->>'group_key' as group_key,
      min(coalesce(p.quantity,0)/greatest((c->>'factor')::integer,1)::numeric) as low,
      max(coalesce(p.quantity,0)/greatest((c->>'factor')::integer,1)::numeric) as high
    from jsonb_array_elements(preview->'rows') g cross join lateral jsonb_array_elements(g->'components') c
    left join chosen p on p.group_key=g->>'group_key' and p.itemcode=c->>'itemcode'
    group by g->>'group_key'
  )
  select jsonb_agg(jsonb_build_object('group_key',group_key,'quantity',trunc(low)::bigint,'valid',low>0 and low=high and low=trunc(low)))
    into group_units from units;
  if exists(select 1 from jsonb_array_elements(group_units) u where not (u->>'valid')::boolean) then
    raise exception 'DELIVERY_COMPONENT_QTY_MISMATCH';
  end if;
  -- Allocate parent units to SOs first, then derive every child's quantity.
  -- The same source order is used for all components, even on identical dates.
  with sources as materialized (
    select id,state as row from public.delivery_source_rows(ids)
  ), source_order as (
    select s.*,sum((row->>'remaining_qty')::bigint) over(partition by row->>'group_key'
      order by row->>'delivery_date',row->>'created_at',id) as finish,
      row_number() over(partition by row->>'group_key' order by row->>'delivery_date' desc,row->>'created_at' desc,id desc)=1 as last_request
    from sources s
  ), parent_units as materialized (
    select s.*,least((u->>'quantity')::bigint,case when last_request then greatest(finish,(u->>'quantity')::bigint) else finish end)
      -least((u->>'quantity')::bigint,finish-(row->>'remaining_qty')::bigint) as quantity
    from source_order s join jsonb_array_elements(group_units) u on u->>'group_key'=s.row->>'group_key'
  ), child_amounts as materialized (
    select p.id as source_id,p.row->>'group_key' as group_key,p.row->>'delivery_date' as delivery_date,
      p.row->>'created_at' as created_at,(c->>'id')::uuid as request_id,c->>'itemcode' as itemcode,
      p.quantity*(c->>'factor')::bigint as quantity
    from parent_units p cross join lateral jsonb_array_elements(p.row->'components') c where p.quantity>0
  ), child_order as (
    select c.*,sum(quantity) over(partition by group_key,itemcode order by delivery_date,created_at,source_id) as finish
    from child_amounts c
  ), demand as materialized (
    select c.*,gen_random_uuid() as issue_id from child_order c
  ), supply as materialized (
    select l->>'group_key' as group_key,i.itemcode,i.id as incoming_id,(l->>'quantity')::bigint as quantity,
      sum((l->>'quantity')::bigint) over(partition by l->>'group_key',i.itemcode
        order by i.production_date nulls first,i.received_date,i.id) as finish
    from jsonb_array_elements(lot_rows) l join public.inv_incoming i on i.id=(l->>'incoming_id')::bigint
  )
  select jsonb_agg(jsonb_build_object('source_id',d.source_id,'request_id',d.request_id,'issue_id',d.issue_id,
    'incoming_id',s.incoming_id,'quantity',least(d.finish,s.finish)-greatest(d.finish-d.quantity,s.finish-s.quantity)))
  into allocations from demand d join supply s using(group_key,itemcode)
    where s.finish-s.quantity<d.finish and d.finish-d.quantity<s.finish;
  if allocations is null then raise exception 'DELIVERY_COMPONENT_QTY_MISMATCH'; end if;
  if exists(
    select 1 from jsonb_array_elements(lot_rows) l
    left join (
      select d.state->>'group_key' as group_key,a.incoming_id,sum(a.quantity) as quantity
      from jsonb_to_recordset(allocations) a(source_id uuid,incoming_id bigint,quantity bigint)
      join public.delivery_source_rows(ids) d on d.id=a.source_id
      group by d.state->>'group_key',a.incoming_id
    ) used on used.group_key=l->>'group_key' and used.incoming_id=(l->>'incoming_id')::bigint
    where coalesce(used.quantity,0)<>(l->>'quantity')::bigint
  ) then raise exception 'DELIVERY_COMPONENT_QTY_MISMATCH'; end if;
  if exists(
    select 1 from jsonb_to_recordset(allocations) a(request_id uuid,quantity bigint)
    join public.inv_delivery_requests d on d.id=a.request_id
    group by d.id,d.shipped_qty having sum(a.quantity)>2147483647-d.shipped_qty
  ) then raise exception 'DELIVERY_BULK_QTY_LIMIT'; end if;
  insert into public.inv_delivery_issues(id,request_id,quantity,shipped_date,entered_by,entered_by_name)
    select a.issue_id,a.request_id,sum(a.quantity),shipped_on,actor,operator_name
    from jsonb_to_recordset(allocations) a(issue_id uuid,request_id uuid,quantity integer) group by a.issue_id,a.request_id;
  insert into public.inv_delivery_issue_lines(issue_id,incoming_id,quantity)
    select a.issue_id,a.incoming_id,a.quantity from jsonb_to_recordset(allocations) a(issue_id uuid,incoming_id bigint,quantity integer);
  update public.inv_incoming i set issued_qty=i.issued_qty+x.quantity from (
    select a.incoming_id,sum(a.quantity) as quantity from jsonb_to_recordset(allocations) a(incoming_id bigint,quantity integer)
    group by a.incoming_id) x where i.id=x.incoming_id;
  update public.inv_delivery_requests d set shipped_qty=d.shipped_qty+x.quantity,version=d.version+1,updated_at=now()
    from (select a.request_id,sum(a.quantity) as quantity from jsonb_to_recordset(allocations) a(request_id uuid,quantity integer)
      group by a.request_id) x where d.id=x.request_id;
  update public.inv_delivery_requests d set version=d.version+1,updated_at=now()
    where d.request_type='parent' and d.id in (
      select (a->>'source_id')::uuid from jsonb_array_elements(allocations) a);
  if exists(select 1 from public.delivery_source_rows(ids) s where (s.state->>'sync_error')::boolean) then
    raise exception 'DELIVERY_COMPONENTS_OUT_OF_SYNC';
  end if;
  select jsonb_build_object('shipped',(select sum((u->>'quantity')::bigint) from jsonb_array_elements(group_units) u),
    'component_shipped',sum((a->>'quantity')::bigint),'request_count',count(distinct a->>'source_id'),'group_model_version',1)
    into result from jsonb_array_elements(allocations) a;
  insert into public.inv_delivery_commands(id,actor,action,payload,result) values(p_command_id,actor,'bulk_ship',p_payload,result);
  return result;
end $$;
revoke all on function public.post_bulk_delivery(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.post_bulk_delivery(uuid,jsonb) to authenticated;

-- Close the independent-child entry points too; browser checks are not sufficient.
alter function public.manage_delivery(text,uuid,jsonb) rename to manage_delivery_components_v1;
revoke all on function public.manage_delivery_components_v1(text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.manage_delivery(p_action text,p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); cmd public.inv_delivery_commands%rowtype; kind text;
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
  return public.manage_delivery_components_v1(p_action,p_command_id,p_payload);
end $$;
revoke all on function public.manage_delivery(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.manage_delivery(text,uuid,jsonb) to authenticated;

create function public.delivery_request_details(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare state jsonb; history jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  state:=public.delivery_source_state(p_id);
  select coalesce(jsonb_agg(row order by row->>'created_at' desc,row->>'id'),'[]') into history from (
    select to_jsonb(i)||jsonb_build_object('itemcode',d.itemcode,'product_name',d.product_name,
      'inv_delivery_issue_lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('inv_incoming',
        jsonb_build_object('received_date',a.received_date,'production_date',a.production_date)) order by l.incoming_id)
        from public.inv_delivery_issue_lines l join public.inv_incoming a on a.id=l.incoming_id where l.issue_id=i.id),'[]')) as row
    from public.inv_delivery_issues i join public.inv_delivery_requests d on d.id=i.request_id
    where d.id=p_id or d.parent_request_id=p_id order by i.created_at desc,i.id limit 500
  ) q;
  return jsonb_build_object('group_model_version',1,'history',history,'item_stock_qty',state->'item_stock_qty',
    'request',state,'components',state->'components');
end $$;
revoke all on function public.delivery_request_details(uuid) from public,anon,authenticated,service_role;
grant execute on function public.delivery_request_details(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
