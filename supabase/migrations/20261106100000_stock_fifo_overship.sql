begin;

select pg_advisory_xact_lock(72638104112000::bigint);

-- Preserve the ordered quantity and record all units actually shipped.
alter table public.inv_delivery_requests drop constraint inv_delivery_shipped_check,
  add constraint inv_delivery_shipped_check check (shipped_qty >= 0);

create index inv_incoming_available_production_idx
  on public.inv_incoming(itemcode,production_date nulls first,received_date,id)
  where balance_qty>0;

create or replace function public.refresh_stock_summary(p_items text[])
returns void language sql security definer set search_path=public as $$
  with items as (
    select distinct itemcode from unnest(p_items) u(itemcode) where itemcode is not null
  ), stock as (
    select i.itemcode,sum(i.received_qty) as received,sum(i.issued_qty) as issued
    from public.inv_incoming i join items x using(itemcode) group by i.itemcode
  ), demand as (
    select d.itemcode,sum(greatest(d.ordered_qty-d.shipped_qty,0)) as quantity
    from public.inv_delivery_requests d join items x using(itemcode) where not d.cancelled group by d.itemcode
  )
  insert into public.inv_stock_summary as s(itemcode,product_name,customer,received_qty,issued_qty,on_order_qty,updated_at)
  select x.itemcode,
    coalesce(nullif(btrim(c.product_name),''),nullif(btrim(i.product_name),''),nullif(btrim(d.product_name),''),''),
    coalesce(nullif(btrim(c.customer),''),nullif(btrim(i.customer),''),nullif(btrim(d.customer),''),''),
    coalesce(st.received,0),coalesce(st.issued,0),coalesce(dm.quantity,0),now()
  from items x
  left join stock st using(itemcode) left join demand dm using(itemcode)
  left join public.item_pallet_config c using(itemcode)
  left join lateral (select q.product_name,q.customer from public.inv_incoming q where q.itemcode=x.itemcode order by q.id desc limit 1) i on true
  left join lateral (select q.product_name,q.customer from public.inv_delivery_requests q where q.itemcode=x.itemcode order by q.created_at desc,q.id limit 1) d on true
  order by x.itemcode
  on conflict(itemcode) do update set product_name=excluded.product_name,customer=excluded.customer,
    received_qty=excluded.received_qty,issued_qty=excluded.issued_qty,on_order_qty=excluded.on_order_qty,updated_at=excluded.updated_at;
$$;

create or replace function public.manage_delivery(p_action text, p_command_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  cmd public.inv_delivery_commands%rowtype;
  req public.inv_delivery_requests%rowtype;
  natural_row public.inv_delivery_requests%rowtype;
  x jsonb;
  rec record;
  existing jsonb;
  candidates jsonb;
  output jsonb := '[]';
  result jsonb;
  rows jsonb;
  deltas jsonb := '{}';
  targets jsonb := '{}';
  qty integer;
  delta bigint;
  physical bigint;
  take integer;
  remaining integer;
  new_date date;
  target uuid;
  expected integer;
  changed integer := 0;
  skipped integer := 0;
begin
  if actor is null or not public.has_permission('receipt.view')
    or not exists (select 1 from public.profiles p where p.id = actor and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if p_action not in ('preview','import','edit','cancel','reserve','ship') or p_payload is null then raise exception 'DELIVERY_INVALID_ACTION'; end if;

  perform pg_advisory_xact_lock(72638104112000::bigint);
  if p_action <> 'preview' then
    if p_command_id is null then raise exception 'DELIVERY_INVALID_COMMAND'; end if;
    select * into cmd from public.inv_delivery_commands c where c.id = p_command_id;
    if found then
      if cmd.actor is distinct from actor or cmd.action <> p_action or cmd.payload is distinct from p_payload then raise exception 'DELIVERY_COMMAND_CONFLICT'; end if;
      return cmd.result;
    end if;
  end if;

  if p_action in ('preview','import') then
    rows := p_payload->'rows';
    if rows is null or jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) not between 1 and 500 then raise exception 'DELIVERY_INVALID_ROWS'; end if;
    if exists(select 1 from jsonb_array_elements(rows) v where jsonb_typeof(v) <> 'object') then raise exception 'DELIVERY_INVALID_ROW'; end if;
    -- Normalize identifiers before uniqueness checks, including direct RPC callers.
    select jsonb_agg(v || jsonb_build_object(
      'purorder',btrim(coalesce(v->>'purorder','')), 'sales_id',btrim(coalesce(v->>'sales_id','')),
      'itemcode',btrim(coalesce(v->>'itemcode','')),
      'unit',case when v->>'unit' = 'SET' then 'SET' else 'EA' end)) into rows from jsonb_array_elements(rows) v;
    if (select count(*) from jsonb_array_elements(rows)) <>
       (select count(distinct (v->>'purorder',v->>'sales_id',v->>'itemcode',v->>'delivery_date')) from jsonb_array_elements(rows) v)
      then raise exception 'DELIVERY_DUPLICATE_KEY'; end if;
    for x in select value from jsonb_array_elements(rows) order by value->>'delivery_date',value->>'purorder',value->>'sales_id',value->>'itemcode' loop
      if length(btrim(coalesce(x->>'purorder',''))) not between 1 and 200
        or length(btrim(coalesce(x->>'sales_id',''))) not between 1 and 200
        or length(btrim(coalesce(x->>'itemcode',''))) not between 1 and 200
        or position('*' in x->>'itemcode') > 0
        or coalesce(x->>'delivery_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or jsonb_typeof(x->'ordered_qty') is distinct from 'number'
        or (x->>'ordered_qty')::numeric not between 1 and 2147483647
        or (x->>'ordered_qty')::numeric <> trunc((x->>'ordered_qty')::numeric)
      then raise exception 'DELIVERY_INVALID_ROW'; end if;
      new_date := (x->>'delivery_date')::date;
      qty := (x->>'ordered_qty')::integer;
      select * into natural_row from public.inv_delivery_requests d
        where d.purorder = x->>'purorder' and d.sales_id = x->>'sales_id'
          and d.itemcode = x->>'itemcode' and d.delivery_date = new_date;
      if p_action = 'preview' then
        existing := case when natural_row.id is null then null else to_jsonb(natural_row) end;
        select coalesce(jsonb_agg(to_jsonb(d) order by d.delivery_date), '[]') into candidates
          from public.inv_delivery_requests d
          where d.purorder = x->>'purorder' and d.sales_id = x->>'sales_id' and d.itemcode = x->>'itemcode'
            and d.delivery_date <> new_date and not d.cancelled;
        delta := case when coalesce(natural_row.cancelled,false) then 0
          else greatest(0,qty-coalesce(natural_row.shipped_qty,0)) -
            case when natural_row.id is null then 0 else greatest(0,natural_row.ordered_qty-natural_row.shipped_qty) end end;
        deltas := deltas || jsonb_build_object(x->>'itemcode',coalesce((deltas->>(x->>'itemcode'))::bigint,0)+delta);
        output := output || jsonb_build_array(x || jsonb_build_object('existing',existing,'candidates',candidates));
        continue;
      end if;
      target := nullif(x->>'target_id','')::uuid;
      if natural_row.id is not null and target is not null and target <> natural_row.id then raise exception 'DELIVERY_DATE_CONFLICT'; end if;
      if target is null then target := natural_row.id; end if;
      if target is not null then
        if targets ? target::text then raise exception 'DELIVERY_DUPLICATE_TARGET'; end if;
        targets := targets || jsonb_build_object(target::text,true);
      end if;
      if target is null then
        if exists (select 1 from public.inv_delivery_requests d where d.purorder=x->>'purorder' and d.sales_id=x->>'sales_id' and d.itemcode=x->>'itemcode' and not d.cancelled)
          and x->>'mode' is distinct from 'new' then raise exception 'DELIVERY_CHOOSE_SCHEDULE'; end if;
        insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,product_name,customer,unit,unit_label,ordered_qty,source_file,created_by)
        values(x->>'purorder',x->>'sales_id',x->>'itemcode',new_date,coalesce(x->>'product_name',''),coalesce(x->>'customer',''),x->>'unit',coalesce(x->>'unit_label',x->>'unit'),qty,p_payload->>'file_name',actor)
        returning * into req;
      else
        select * into strict req from public.inv_delivery_requests d where d.id=target for update;
        if req.purorder <> x->>'purorder' or req.sales_id <> x->>'sales_id' or req.itemcode <> x->>'itemcode' then raise exception 'DELIVERY_TARGET_MISMATCH'; end if;
        if req.cancelled or (req.ordered_qty = qty and req.delivery_date = new_date) then skipped := skipped + 1; continue; end if;
        expected := nullif(x->>'expected_version','')::integer;
        if expected is distinct from req.version then raise exception 'DELIVERY_STALE'; end if;
        if req.cancelled then raise exception 'DELIVERY_CANCELLED'; end if;
        -- Allow an already overshipped request to retain its original plan when rescheduled.
        if qty < least(req.ordered_qty,req.shipped_qty) then raise exception 'DELIVERY_BELOW_SHIPPED'; end if;
        update public.inv_delivery_requests set ordered_qty=qty,delivery_date=new_date,source_file=p_payload->>'file_name',updated_at=now() where id=req.id;
      end if;
      update public.inv_delivery_requests set version=version+1 where id=req.id;
      changed := changed+1;
    end loop;
    if p_action = 'preview' then
      select coalesce(jsonb_agg(v || jsonb_build_object(
        'item_stock_qty',coalesce(s.balance_qty,0),
        'item_on_order_qty',coalesce(s.on_order_qty,0),
        'item_on_order_after',coalesce(s.on_order_qty,0)+coalesce((deltas->>(v->>'itemcode'))::bigint,0),
        'item_shortage_after',greatest(0,coalesce(s.on_order_qty,0)+coalesce((deltas->>(v->>'itemcode'))::bigint,0)-coalesce(s.balance_qty,0))
      ) order by (v->>'excel_row')::integer),'[]') into output
      from jsonb_array_elements(output) v left join public.inv_stock_summary s on s.itemcode=v->>'itemcode';
      return jsonb_build_object('rows',output,'model_version',2);
    end if;
    result := jsonb_build_object('changed',changed,'skipped',skipped);
  elsif p_action = 'reserve' then
    -- Compatibility for an old browser's pending command. No lot reservations.
    result := jsonb_build_object('updated',0);
  else
    target := (p_payload->>'id')::uuid;
    select * into strict req from public.inv_delivery_requests d where d.id=target for update;
    if (p_payload->>'version')::integer is distinct from req.version then raise exception 'DELIVERY_STALE'; end if;
    if req.cancelled then raise exception 'DELIVERY_CANCELLED'; end if;
    if p_action = 'cancel' then
      if req.shipped_qty >= req.ordered_qty then raise exception 'DELIVERY_DONE'; end if;
      update public.inv_delivery_requests set cancelled=true,version=version+1,updated_at=now() where id=req.id;
      result := jsonb_build_object('cancelled',true);
    elsif p_action = 'edit' then
      -- Reuse the same import validation and update path, preserving request ID and audit.
      result := public.manage_delivery('import',p_command_id,jsonb_build_object(
        'file_name',req.source_file,'rows',jsonb_build_array(
          jsonb_build_object('purorder',req.purorder,'sales_id',req.sales_id,'itemcode',req.itemcode,
            'delivery_date',p_payload->>'delivery_date','ordered_qty',p_payload->'ordered_qty',
            'unit',req.unit,'unit_label',req.unit_label,'target_id',req.id,'expected_version',req.version,
            'product_name',req.product_name,'customer',req.customer))));
      -- Inner command used the same UUID. Rewrite its audit action to the outer request.
      update public.inv_delivery_commands set action=p_action,payload=p_payload where id=p_command_id;
      return result;
    elsif p_action = 'ship' then
      if req.shipped_qty >= req.ordered_qty then raise exception 'DELIVERY_DONE'; end if;
      if jsonb_typeof(p_payload->'quantity') is distinct from 'number'
        or (p_payload->>'quantity')::numeric <> trunc((p_payload->>'quantity')::numeric)
        or (p_payload->>'quantity')::numeric not between 1 and (2147483647-req.shipped_qty) then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
      qty := (p_payload->>'quantity')::integer;
      if coalesce(p_payload->>'shipped_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'DELIVERY_INVALID_DATE'; end if;
      new_date := (p_payload->>'shipped_date')::date;
      select coalesce(sum(i.balance_qty),0) into physical from public.inv_incoming i where i.itemcode=req.itemcode;
      if qty > physical then raise exception 'DELIVERY_INSUFFICIENT_STOCK'; end if;
      insert into public.inv_delivery_issues(id,request_id,quantity,shipped_date,entered_by,entered_by_name)
        select p_command_id,req.id,qty,new_date,actor,coalesce(nullif(btrim(p.full_name),''),p.username) from public.profiles p where p.id=actor;
      remaining := qty;
      for rec in select i.* from public.inv_incoming i where i.itemcode=req.itemcode and i.balance_qty>0
        order by i.production_date nulls first,i.received_date,i.id for update loop
        take := least(remaining,rec.balance_qty);
        insert into public.inv_delivery_issue_lines(issue_id,incoming_id,quantity) values(p_command_id,rec.id,take);
        remaining := remaining-take;
        exit when remaining=0;
      end loop;
      if remaining <> 0 then raise exception 'DELIVERY_INSUFFICIENT_STOCK'; end if;
      update public.inv_incoming i set issued_qty=i.issued_qty+l.quantity
        from public.inv_delivery_issue_lines l where l.issue_id=p_command_id and i.id=l.incoming_id;
      update public.inv_delivery_requests set shipped_qty=shipped_qty+qty,version=version+1,updated_at=now() where id=req.id;
      result := jsonb_build_object('shipped',qty,'issue_id',p_command_id);
    end if;
  end if;
  result := result || jsonb_build_object('model_version',2);
  insert into public.inv_delivery_commands(id,actor,action,payload,result) values(p_command_id,actor,p_action,p_payload,result);
  return result;
end;
$$;

create or replace function public.list_delivery(p_offset integer default 0,p_search text default '',p_closed boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select jsonb_build_object('total',count(*),'model_version',2) into result from public.inv_delivery_requests d
    where (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
      and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer)))>0);
  return result || jsonb_build_object('rows',coalesce((
    select jsonb_agg(q.row order by q.delivery_date,q.created_at,q.id) from (
      select d.id,d.delivery_date,d.created_at,to_jsonb(d)||jsonb_build_object(
        'remaining_qty',case when d.cancelled then 0 else greatest(0,d.ordered_qty-d.shipped_qty) end,
        'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0),
        'item_available_qty',coalesce(s.available_qty,0),'item_shortage_qty',coalesce(s.shortage_qty,0),
        'status',case when d.cancelled then 'cancelled' when d.shipped_qty>=d.ordered_qty then 'done' when d.shipped_qty>0 then 'partial' else 'pending' end
      ) as row from public.inv_delivery_requests d left join public.inv_stock_summary s using(itemcode)
      where (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
        and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer)))>0)
      order by d.delivery_date,d.created_at,d.id limit 100 offset greatest(0,p_offset)
    ) q
  ),'[]'));
end $$;

create or replace function public.preview_delivery_fifo(p_id uuid,p_quantity integer default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare req public.inv_delivery_requests%rowtype; physical bigint; due integer; qty integer; lots jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select * into strict req from public.inv_delivery_requests where id=p_id;
  select coalesce(sum(balance_qty),0) into physical from public.inv_incoming where itemcode=req.itemcode;
  due := case when req.cancelled then 0 else greatest(0,req.ordered_qty-req.shipped_qty) end;
  qty := coalesce(p_quantity,least(due,physical)::integer);
  if qty<0 then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
  if due=0 then qty:=0; end if;
  with ordered as (
    select i.id as incoming_id,i.received_date,i.production_date,i.balance_qty,
      coalesce(sum(i.balance_qty) over(order by i.production_date nulls first,i.received_date,i.id rows between unbounded preceding and 1 preceding),0) as previous
    from public.inv_incoming i where i.itemcode=req.itemcode and i.balance_qty>0
  )
  select coalesce(jsonb_agg(jsonb_build_object('incoming_id',incoming_id,'received_date',received_date,
    'production_date',production_date,'quantity',least(balance_qty,greatest(qty-previous,0)))
    order by production_date nulls first,received_date,incoming_id) filter(where previous<qty),'[]') into lots from ordered;
  return jsonb_build_object('model_version',2,'request_version',req.version,'item_stock_qty',physical,
    'remaining_qty',due,
    'quantity',qty,'can_ship',due>0 and qty>0 and qty<=physical and qty<=2147483647-req.shipped_qty,'fifo',lots);
end $$;

create function public.list_stock_production_dates(p_itemcode text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  if p_itemcode is null or length(btrim(p_itemcode)) not between 1 and 200 then raise exception 'DELIVERY_INVALID_ITEM'; end if;
  select jsonb_build_object(
    'balance_qty',coalesce(sum(q.balance_qty),0),
    'rows',coalesce(jsonb_agg(to_jsonb(q) order by q.production_date nulls first),'[]')
  ) into result from (
    select i.production_date,count(*) as lot_count,sum(i.balance_qty) as balance_qty
    from public.inv_incoming i where i.itemcode=p_itemcode and i.balance_qty>0 group by i.production_date
  ) q;
  return result;
end $$;
revoke all on function public.list_stock_production_dates(text) from public,anon,authenticated,service_role;
grant execute on function public.list_stock_production_dates(text) to authenticated;

notify pgrst,'reload schema';
commit;
