begin;

select pg_advisory_xact_lock(72638104112000::bigint);

alter table public.inv_delivery_requests
  add column request_type text not null default 'origin' check (request_type in ('origin','parent','child')),
  add column parent_request_id uuid references public.inv_delivery_requests(id) on delete restrict,
  add constraint inv_delivery_request_hierarchy check (
    (request_type='child')=(parent_request_id is not null)
    and parent_request_id is distinct from id
    and (request_type<>'parent' or shipped_qty=0)
  );
-- Replace the original auto-named key. PostgreSQL truncates its identifier.
do $$
declare original_key name;
begin
  select c.conname into strict original_key from pg_constraint c
  where c.conrelid='public.inv_delivery_requests'::regclass and c.contype='u'
    and pg_get_constraintdef(c.oid)='UNIQUE (purorder, sales_id, itemcode, delivery_date)';
  execute format('alter table public.inv_delivery_requests drop constraint %I',original_key);
end $$;
create unique index inv_delivery_source_request_key on public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date)
  where parent_request_id is null;
create unique index inv_delivery_child_request_key on public.inv_delivery_requests(parent_request_id,itemcode)
  where parent_request_id is not null;
comment on column public.inv_delivery_requests.request_type is 'origin: normal request; parent: source row for a build-up, no stock demand; child: shippable component.';
comment on column public.inv_delivery_requests.parent_request_id is 'Source request for a child component; null for origin and parent rows.';

create function public.delivery_build_up_options(p_itemcode text)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token',r.id::text||':'||md5(to_jsonb(c.codes)::text),'codes',c.codes,
    'components',(select coalesce(jsonb_agg(jsonb_build_object('itemcode',x.itemcode,'factor',x.factor,
       'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by x.itemcode),'[]')
      from (select itemcode,count(*) as factor from unnest(c.codes) u(itemcode) where itemcode is not null group by itemcode) x
      left join public.inv_stock_summary s using(itemcode))) order by r.id),'[]')
  from public.item_build_up r
  cross join lateral (select array[r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3] as codes) c
  where r.parent_itemcode=p_itemcode;
$$;

create function public.delivery_selected_build_up(p_itemcode text,p_token text)
returns jsonb language plpgsql stable set search_path=public as $$
declare options jsonb := public.delivery_build_up_options(p_itemcode); selected jsonb;
begin
  if p_token is not null then
    select value into selected from jsonb_array_elements(options) where value->>'token'=p_token;
    if not found then raise exception 'DELIVERY_BUILD_UP_CHANGED:%',p_itemcode; end if;
  elsif jsonb_array_length(options)=1 then
    selected := options->0;
  elsif jsonb_array_length(options)>1 then
    raise exception 'DELIVERY_BUILD_UP_CHOOSE:%',p_itemcode;
  end if;
  return selected;
end $$;

create function public.delivery_saved_components(p_parent uuid)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemcode',d.itemcode,'factor',d.ordered_qty/p.ordered_qty,
    'ordered_qty',d.ordered_qty,'shipped_qty',d.shipped_qty,'cancelled',d.cancelled,
    'item_stock_qty',coalesce(s.balance_qty,0),'item_on_order_qty',coalesce(s.on_order_qty,0)) order by d.itemcode),'[]')
  from public.inv_delivery_requests d join public.inv_delivery_requests p on p.id=d.parent_request_id
  left join public.inv_stock_summary s on s.itemcode=d.itemcode
  where d.parent_request_id=p_parent;
$$;

create function public.delivery_insert_children(p_parent public.inv_delivery_requests,p_recipe jsonb)
returns void language plpgsql set search_path=public as $$
declare component jsonb; code text; quantity bigint; item_name text;
begin
  for component in select value from jsonb_array_elements(p_recipe->'components') loop
    code := component->>'itemcode';
    quantity := p_parent.ordered_qty::bigint*(component->>'factor')::bigint;
    if quantity>2147483647 then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
    select coalesce(nullif(btrim(c.product_name),''),nullif(btrim(c."ERP_name"),''))
      into item_name from public.item_pallet_config c where c.itemcode=code;
    insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,product_name,customer,unit,unit_label,
      ordered_qty,source_file,created_by,delivery_source,request_type,parent_request_id)
    values(p_parent.purorder,p_parent.sales_id,code,p_parent.delivery_date,coalesce(item_name,code),
      p_parent.customer,'EA','PCS',quantity,p_parent.source_file,p_parent.created_by,p_parent.delivery_source,'child',p_parent.id);
  end loop;
end $$;

revoke all on function public.delivery_build_up_options(text),public.delivery_selected_build_up(text,text),
  public.delivery_saved_components(uuid),public.delivery_insert_children(public.inv_delivery_requests,jsonb)
from public,anon,authenticated,service_role;

-- Expose alternatives to the manual form without exposing the build-up table.
create function public.lookup_delivery_build_up(p_itemcode text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare options jsonb; item_name text; customer_name text;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  options := public.delivery_build_up_options(p_itemcode);
  select l.product_name,l.customer into item_name,customer_name from public.lookup_manual_delivery_item(p_itemcode) l;
  if item_name is null and jsonb_array_length(options)>0 then
    select nullif(btrim(c."ERP_name"),''),nullif(btrim(c.customer),'') into item_name,customer_name from public.item_pallet_config c where c.itemcode=p_itemcode;
    item_name := coalesce(item_name,p_itemcode);
  end if;
  if item_name is null then return null; end if;
  return jsonb_build_object('product_name',item_name,'customer',customer_name,'build_up_options',options);
end $$;
revoke all on function public.lookup_delivery_build_up(text) from public,anon,authenticated,service_role;
grant execute on function public.lookup_delivery_build_up(text) to authenticated;

create or replace function public.refresh_stock_summary(p_items text[])
returns void language sql security definer set search_path=public as $$
  with items as (
    select distinct itemcode from unnest(p_items) u(itemcode) where itemcode is not null
  ), stock as (
    select i.itemcode,sum(i.received_qty) as received,sum(i.issued_qty) as issued
    from public.inv_incoming i join items x using(itemcode) group by i.itemcode
  ), demand as (
    select d.itemcode,sum(greatest(d.ordered_qty-d.shipped_qty,0)) as quantity
    from public.inv_delivery_requests d join items x using(itemcode) where d.request_type<>'parent' and not d.cancelled group by d.itemcode
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
  recipe jsonb;
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
    if p_action='import' then lock table public.item_build_up in share mode; end if;
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
          and d.itemcode = x->>'itemcode' and d.parent_request_id is null and d.delivery_date = new_date;
      if p_action = 'preview' then
        existing := case when natural_row.id is null then null else to_jsonb(natural_row)||jsonb_build_object('components',public.delivery_saved_components(natural_row.id)) end;
        select coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('components',public.delivery_saved_components(d.id)) order by d.delivery_date), '[]') into candidates
          from public.inv_delivery_requests d
          where d.purorder = x->>'purorder' and d.sales_id = x->>'sales_id' and d.itemcode = x->>'itemcode'
            and d.delivery_date <> new_date and d.parent_request_id is null and not d.cancelled;
        delta := case when coalesce(natural_row.cancelled,false) or natural_row.request_type='parent' or (natural_row.id is null and jsonb_array_length(public.delivery_build_up_options(x->>'itemcode'))>0) then 0
          else greatest(0,qty-coalesce(natural_row.shipped_qty,0)) -
            case when natural_row.id is null then 0 else greatest(0,natural_row.ordered_qty-natural_row.shipped_qty) end end;
        deltas := deltas || jsonb_build_object(x->>'itemcode',coalesce((deltas->>(x->>'itemcode'))::bigint,0)+delta);
        output := output || jsonb_build_array(x || jsonb_build_object('existing',existing,'candidates',candidates,'build_up_options',public.delivery_build_up_options(x->>'itemcode')));
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
        if exists (select 1 from public.inv_delivery_requests d where d.purorder=x->>'purorder' and d.sales_id=x->>'sales_id' and d.itemcode=x->>'itemcode' and d.parent_request_id is null and not d.cancelled)
          and x->>'mode' is distinct from 'new' then raise exception 'DELIVERY_CHOOSE_SCHEDULE'; end if;
        recipe := public.delivery_selected_build_up(x->>'itemcode',x->>'build_up_token');
        if x->'build_up_token' = 'null'::jsonb and recipe is not null then raise exception 'DELIVERY_BUILD_UP_CHANGED:%',x->>'itemcode'; end if;
        insert into public.inv_delivery_requests(purorder,sales_id,itemcode,delivery_date,product_name,customer,unit,unit_label,ordered_qty,source_file,created_by,request_type)
        values(x->>'purorder',x->>'sales_id',x->>'itemcode',new_date,coalesce(x->>'product_name',''),coalesce(x->>'customer',''),x->>'unit',coalesce(x->>'unit_label',x->>'unit'),qty,p_payload->>'file_name',actor,case when recipe is null then 'origin' else 'parent' end)
        returning * into req;
        if recipe is not null then perform public.delivery_insert_children(req,recipe); end if;
      else
        select * into strict req from public.inv_delivery_requests d where d.id=target for update;
        if req.parent_request_id is not null or req.purorder <> x->>'purorder' or req.sales_id <> x->>'sales_id' or req.itemcode <> x->>'itemcode' then raise exception 'DELIVERY_TARGET_MISMATCH'; end if;
        if req.cancelled or (req.ordered_qty = qty and req.delivery_date = new_date) then skipped := skipped + 1; continue; end if;
        expected := nullif(x->>'expected_version','')::integer;
        if expected is distinct from req.version then raise exception 'DELIVERY_STALE'; end if;
        if req.cancelled then raise exception 'DELIVERY_CANCELLED'; end if;
        -- Allow an already overshipped request to retain its original plan when rescheduled.
        if qty < least(req.ordered_qty,req.shipped_qty) then raise exception 'DELIVERY_BELOW_SHIPPED'; end if;
        if req.request_type='parent' then
          if exists(select 1 from public.inv_delivery_requests c where c.parent_request_id=req.id and
            qty::bigint*(c.ordered_qty/req.ordered_qty)>2147483647) then raise exception 'DELIVERY_INVALID_QUANTITY'; end if;
          if exists(select 1 from public.inv_delivery_requests c where c.parent_request_id=req.id and
            qty::bigint*(c.ordered_qty/req.ordered_qty)<least(c.ordered_qty,c.shipped_qty)) then raise exception 'DELIVERY_BELOW_SHIPPED'; end if;
          update public.inv_delivery_requests c set ordered_qty=(qty::bigint*(c.ordered_qty/req.ordered_qty))::integer,
            delivery_date=new_date,source_file=p_payload->>'file_name',version=c.version+1,updated_at=now()
            where c.parent_request_id=req.id;
        end if;
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
      return jsonb_build_object('rows',output,'model_version',2,'build_up_version',1);
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
    if req.request_type='parent' and p_action='ship' then raise exception 'DELIVERY_SHIP_CHILDREN_ONLY'; end if;
    if req.request_type='child' and p_action='edit' then raise exception 'DELIVERY_EDIT_PARENT_ONLY'; end if;
    if p_action = 'cancel' then
      if req.shipped_qty >= req.ordered_qty then raise exception 'DELIVERY_DONE'; end if;
      update public.inv_delivery_requests set cancelled=true,version=version+1,updated_at=now() where id=req.id;
      if req.request_type='parent' then
        update public.inv_delivery_requests set cancelled=true,version=version+1,updated_at=now()
        where parent_request_id=req.id and not cancelled and shipped_qty<ordered_qty;
      end if;
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
    left join public.inv_delivery_requests p on p.id=d.parent_request_id
    where d.request_type<>'parent' and (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
      and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer,p.itemcode)))>0);
  return result || jsonb_build_object('rows',coalesce((
    select jsonb_agg(q.row order by q.delivery_date,q.created_at,q.id) from (
      select d.id,d.delivery_date,d.created_at,to_jsonb(d)||jsonb_build_object(
        'parent_itemcode',p.itemcode,
        'system_customer_name',coalesce(p.system_customer_name,d.system_customer_name),
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

create or replace function public.preview_delivery_fifo(p_id uuid,p_quantity integer default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare req public.inv_delivery_requests%rowtype; physical bigint; due integer; qty integer; lots jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select * into strict req from public.inv_delivery_requests where id=p_id;
  if req.request_type='parent' then raise exception 'DELIVERY_SHIP_CHILDREN_ONLY'; end if;
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

create or replace function public.post_manual_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  cmd public.inv_delivery_commands%rowtype;
  item jsonb;
  recipe jsonb;
  request_row public.inv_delivery_requests%rowtype;
  v_itemcode text;
  v_delivery_date date;
  qty integer;
  result jsonb;
begin
  if actor is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'DELIVERY_INVALID_COMMAND';
  end if;

  perform pg_advisory_xact_lock(72638104112000::bigint);
  select * into cmd from public.inv_delivery_commands c where c.id=p_command_id;
  if found then
    if cmd.actor is distinct from actor or cmd.action<>'manual' or cmd.payload is distinct from p_payload then
      raise exception 'DELIVERY_COMMAND_CONFLICT';
    end if;
    return cmd.result;
  end if;

  if jsonb_typeof(p_payload->'itemcode') is distinct from 'string'
    or coalesce(p_payload->>'delivery_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(p_payload->'ordered_qty') is distinct from 'number' then
    raise exception 'DELIVERY_INVALID_ROW';
  end if;
  if (p_payload->>'ordered_qty')::numeric not between 1 and 2147483647
    or (p_payload->>'ordered_qty')::numeric <> trunc((p_payload->>'ordered_qty')::numeric) then
    raise exception 'DELIVERY_INVALID_QUANTITY';
  end if;
  v_itemcode := p_payload->>'itemcode';
  v_delivery_date := (p_payload->>'delivery_date')::date;
  qty := (p_payload->>'ordered_qty')::integer;
  lock table public.item_build_up in share mode;
  recipe := public.delivery_selected_build_up(v_itemcode,p_payload->>'build_up_token');
  if p_payload->'build_up_token' = 'null'::jsonb and recipe is not null then raise exception 'DELIVERY_BUILD_UP_CHANGED:%',v_itemcode; end if;
  item := public.lookup_delivery_build_up(v_itemcode);
  if item is null then raise exception 'DELIVERY_ITEM_NOT_FOUND'; end if;

  -- Internal reference only. No operator needs to invent a PO or Sales ID.
  insert into public.inv_delivery_requests(id,purorder,sales_id,itemcode,delivery_date,
    product_name,customer,unit,unit_label,ordered_qty,delivery_source,created_by,request_type)
  values(p_command_id,'MANUAL-'||p_command_id::text,'MANUAL',v_itemcode,v_delivery_date,
    item->>'product_name',coalesce(item->>'customer',''),'EA','',qty,'manual',actor,case when recipe is null then 'origin' else 'parent' end)
  returning * into request_row;
  if recipe is not null then perform public.delivery_insert_children(request_row,recipe); end if;
  result := jsonb_build_object('request_id',p_command_id,'model_version',2);
  insert into public.inv_delivery_commands(id,actor,action,payload,result)
    values(p_command_id,actor,'manual',p_payload,result);
  return result;
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
      nullif(btrim(coalesce(p.system_customer_name,d.system_customer_name)),'') as system_customer,
      nullif(btrim(d.customer),'') as erp_customer
    from public.inv_delivery_requests d
    left join public.inv_delivery_requests p on p.id=d.parent_request_id
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

create or replace function public.preview_bulk_delivery(p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare review jsonb; extra jsonb;
begin
  review := public.review_delivery_fifo(p_request_ids);
  with pending as materialized (
    select d.id,d.version,d.itemcode from public.inv_delivery_requests d
    where d.id=any(p_request_ids) and d.request_type<>'parent' and not d.cancelled and d.shipped_qty<d.ordered_qty
  ), lots as (
    select i.itemcode,jsonb_agg(jsonb_build_object('incoming_id',i.id::text,
      'production_date',i.production_date,'received_date',i.received_date,'balance_qty',i.balance_qty)
      order by i.production_date nulls first,i.received_date,i.id) as rows
    from (select distinct itemcode from pending) p join public.inv_incoming i using(itemcode)
    where i.balance_qty>0 group by i.itemcode
  )
  select jsonb_build_object(
    'requests',coalesce((select jsonb_agg(to_jsonb(p)) from pending p),'[]'),
    'lots',coalesce((select jsonb_object_agg(itemcode,rows) from lots),'{}')
  ) into extra;
  return review || extra;
end $$;

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
    where d.id is null or d.request_type='parent' or d.version<>r.version or d.cancelled or d.shipped_qty>=d.ordered_qty
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
