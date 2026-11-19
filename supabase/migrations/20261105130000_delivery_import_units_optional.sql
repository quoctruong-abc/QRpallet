begin;

-- Unit labels are metadata only for now. Keep source quantities unchanged,
-- remove unit confirmation/conflict gates, and preserve delivery priority/FIFO.
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
  stock jsonb := '{}';
  targets jsonb := '{}';
  qty integer;
  own_reserve integer;
  available bigint;
  held bigint;
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
        if not stock ? (x->>'itemcode') then
          select coalesce(sum(i.available_qty),0) into available from public.inv_incoming i where i.itemcode = x->>'itemcode';
        else available := (stock->>(x->>'itemcode'))::bigint; end if;
        own_reserve := coalesce(natural_row.reserved_qty,0);
        held := case when coalesce(natural_row.cancelled,false) then 0
          when natural_row.ordered_qty = qty then own_reserve
          else least(greatest(0, qty - coalesce(natural_row.shipped_qty,0))::bigint,available + own_reserve) end;
        stock := stock || jsonb_build_object(x->>'itemcode', available + own_reserve - held);
        output := output || jsonb_build_array(x || jsonb_build_object(
          'existing',existing,'candidates',candidates,'available_qty',available,
          'suggested_reserved',held,'shortage_qty',greatest(0,qty - coalesce(natural_row.shipped_qty,0) - held)));
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
        if qty < req.shipped_qty then raise exception 'DELIVERY_BELOW_SHIPPED'; end if;
        -- Trim reservations before lowering the requested quantity.
        if qty < req.shipped_qty + req.reserved_qty then
          remaining := req.shipped_qty + req.reserved_qty - qty;
          for rec in select a.* from public.inv_delivery_reservations a join public.inv_incoming i on i.id=a.incoming_id
            where a.request_id=req.id and a.quantity>0
            order by coalesce(i.production_date,i.received_date) desc,i.received_date desc,i.id desc for update of a,i loop
            take := least(remaining,rec.quantity);
            update public.inv_delivery_reservations set quantity=quantity-take where request_id=req.id and incoming_id=rec.incoming_id;
            update public.inv_incoming set reserved_qty=reserved_qty-take where id=rec.incoming_id;
            remaining := remaining-take;
            exit when remaining=0;
          end loop;
          update public.inv_delivery_requests set reserved_qty=qty-shipped_qty where id=req.id;
        end if;
        update public.inv_delivery_requests set ordered_qty=qty,delivery_date=new_date,source_file=p_payload->>'file_name',updated_at=now() where id=req.id;
      end if;
      perform public.reserve_delivery_request(req.id);
      changed := changed+1;
    end loop;
    if p_action = 'preview' then return jsonb_build_object('rows',output); end if;
    result := jsonb_build_object('changed',changed,'skipped',skipped);
  elsif p_action = 'reserve' then
    for rec in select d.id from public.inv_delivery_requests d
      where not d.cancelled and d.shipped_qty + d.reserved_qty < d.ordered_qty
      order by d.delivery_date,d.created_at,d.id loop
      perform public.reserve_delivery_request(rec.id);
      changed := changed+1;
    end loop;
    result := jsonb_build_object('updated',changed);
  else
    target := (p_payload->>'id')::uuid;
    select * into strict req from public.inv_delivery_requests d where d.id=target for update;
    if (p_payload->>'version')::integer is distinct from req.version then raise exception 'DELIVERY_STALE'; end if;
    if req.cancelled then raise exception 'DELIVERY_CANCELLED'; end if;
    if p_action = 'cancel' then
      if req.shipped_qty = req.ordered_qty then raise exception 'DELIVERY_DONE'; end if;
      for rec in select * from public.inv_delivery_reservations a where a.request_id=req.id and a.quantity>0 order by a.incoming_id for update loop
        update public.inv_incoming set reserved_qty=reserved_qty-rec.quantity where id=rec.incoming_id;
      end loop;
      update public.inv_delivery_reservations set quantity=0 where request_id=req.id;
      update public.inv_delivery_requests set reserved_qty=0,cancelled=true,version=version+1,updated_at=now() where id=req.id;
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
      if jsonb_typeof(p_payload->'quantity') is distinct from 'number'
        or (p_payload->>'quantity')::numeric <> trunc((p_payload->>'quantity')::numeric)
        or (p_payload->>'quantity')::numeric not between 1 and req.reserved_qty then raise exception 'DELIVERY_INSUFFICIENT_RESERVED'; end if;
      qty := (p_payload->>'quantity')::integer;
      if coalesce(p_payload->>'shipped_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'DELIVERY_INVALID_DATE'; end if;
      new_date := (p_payload->>'shipped_date')::date;
      insert into public.inv_delivery_issues(id,request_id,quantity,shipped_date,entered_by,entered_by_name)
        select p_command_id,req.id,qty,new_date,actor,coalesce(nullif(btrim(p.full_name),''),p.username) from public.profiles p where p.id=actor;
      remaining := qty;
      for rec in select a.* from public.inv_delivery_reservations a join public.inv_incoming i on i.id=a.incoming_id
        where a.request_id=req.id and a.quantity>0
        order by coalesce(i.production_date,i.received_date),i.received_date,i.id for update of a,i loop
        take := least(remaining,rec.quantity);
        insert into public.inv_delivery_issue_lines(issue_id,incoming_id,quantity) values(p_command_id,rec.incoming_id,take);
        update public.inv_incoming set reserved_qty=reserved_qty-take,issued_qty=issued_qty+take where id=rec.incoming_id;
        update public.inv_delivery_reservations set quantity=quantity-take where request_id=req.id and incoming_id=rec.incoming_id;
        remaining := remaining-take;
        exit when remaining=0;
      end loop;
      if remaining <> 0 then raise exception 'DELIVERY_RESERVATION_MISMATCH'; end if;
      update public.inv_delivery_requests set reserved_qty=reserved_qty-qty,shipped_qty=shipped_qty+qty,version=version+1,updated_at=now() where id=req.id;
      result := jsonb_build_object('shipped',qty,'issue_id',p_command_id);
    end if;
  end if;
  insert into public.inv_delivery_commands(id,actor,action,payload,result) values(p_command_id,actor,p_action,p_payload,result);
  return result;
end;
$$;

-- CREATE OR REPLACE preserves the authenticated-only execute grant.
notify pgrst, 'reload schema';
commit;
