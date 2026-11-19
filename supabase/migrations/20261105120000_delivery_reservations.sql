begin;

alter table public.inv_incoming
  add column reserved_qty integer not null default 0,
  add column available_qty integer generated always as (received_qty - issued_qty - reserved_qty) stored,
  add constraint inv_incoming_reserved_check check (reserved_qty >= 0 and issued_qty + reserved_qty <= received_qty);

create table public.inv_delivery_requests (
  id uuid primary key default gen_random_uuid(),
  purorder text not null check (length(btrim(purorder)) between 1 and 200),
  sales_id text not null check (length(btrim(sales_id)) between 1 and 200),
  itemcode text not null check (length(btrim(itemcode)) between 1 and 200 and position('*' in itemcode) = 0),
  delivery_date date not null,
  product_name text not null default '',
  customer text not null default '',
  unit text not null check (unit in ('EA', 'SET')),
  unit_label text not null,
  ordered_qty integer not null check (ordered_qty > 0),
  shipped_qty integer not null default 0,
  reserved_qty integer not null default 0,
  cancelled boolean not null default false,
  version integer not null default 1,
  source_file text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purorder, sales_id, itemcode, delivery_date),
  check (shipped_qty >= 0 and reserved_qty >= 0 and shipped_qty::bigint + reserved_qty <= ordered_qty),
  check (not cancelled or reserved_qty = 0)
);
create index inv_delivery_queue_idx on public.inv_delivery_requests (delivery_date, created_at) where not cancelled;

create table public.inv_delivery_reservations (
  request_id uuid not null references public.inv_delivery_requests(id) on delete restrict,
  incoming_id bigint not null references public.inv_incoming(id) on delete restrict,
  quantity integer not null check (quantity >= 0),
  primary key (request_id, incoming_id)
);
create table public.inv_delivery_commands (
  id uuid primary key,
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create table public.inv_delivery_issues (
  id uuid primary key,
  request_id uuid not null references public.inv_delivery_requests(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  shipped_date date not null,
  entered_by uuid references public.profiles(id) on delete set null,
  entered_by_name text not null,
  created_at timestamptz not null default now()
);
create table public.inv_delivery_issue_lines (
  issue_id uuid not null references public.inv_delivery_issues(id) on delete restrict,
  incoming_id bigint not null references public.inv_incoming(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  primary key (issue_id, incoming_id)
);

create index inv_delivery_reservations_incoming_idx on public.inv_delivery_reservations(incoming_id) where quantity > 0;
create index inv_delivery_issues_request_idx on public.inv_delivery_issues(request_id,created_at desc);
create index inv_delivery_issue_lines_incoming_idx on public.inv_delivery_issue_lines(incoming_id);

do $$
declare t text;
begin
  foreach t in array array['inv_delivery_requests','inv_delivery_reservations','inv_delivery_commands','inv_delivery_issues','inv_delivery_issue_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    if t <> 'inv_delivery_commands' then
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy delivery_read on public.%I for select to authenticated using (public.has_permission(''receipt.view''))', t);
    end if;
  end loop;
end $$;

-- Internal helper. All callers hold the delivery advisory lock first.
create function public.reserve_delivery_request(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare
  r public.inv_delivery_requests%rowtype;
  lot record;
  need bigint;
  excess bigint;
  take integer;
begin
  select * into strict r from public.inv_delivery_requests where id = p_id for update;
  need := case when r.cancelled then 0 else r.ordered_qty - r.shipped_qty end;
  excess := r.reserved_qty - need;
  if excess > 0 then
    for lot in
      select a.incoming_id, a.quantity from public.inv_delivery_reservations a
      join public.inv_incoming i on i.id = a.incoming_id
      where a.request_id = p_id and a.quantity > 0
      order by coalesce(i.production_date, i.received_date) desc, i.received_date desc, i.id desc
      for update of a, i
    loop
      take := least(excess, lot.quantity)::integer;
      update public.inv_delivery_reservations set quantity = quantity - take where request_id = p_id and incoming_id = lot.incoming_id;
      update public.inv_incoming set reserved_qty = reserved_qty - take where id = lot.incoming_id;
      excess := excess - take;
      exit when excess = 0;
    end loop;
  end if;
  select coalesce(sum(a.quantity),0) into r.reserved_qty from public.inv_delivery_reservations a where a.request_id = p_id;
  need := need - r.reserved_qty;
  if need > 0 then
    for lot in
      select i.id, i.available_qty from public.inv_incoming i
      where i.itemcode = r.itemcode and i.available_qty > 0
      order by coalesce(i.production_date, i.received_date), i.received_date, i.id
      for update
    loop
      take := least(need, lot.available_qty)::integer;
      insert into public.inv_delivery_reservations(request_id,incoming_id,quantity)
      values (p_id,lot.id,take)
      on conflict (request_id,incoming_id) do update set quantity = inv_delivery_reservations.quantity + excluded.quantity;
      update public.inv_incoming set reserved_qty = reserved_qty + take where id = lot.id;
      need := need - take;
      exit when need = 0;
    end loop;
  end if;
  update public.inv_delivery_requests d
    set reserved_qty = (select coalesce(sum(a.quantity),0) from public.inv_delivery_reservations a where a.request_id = p_id),
        version = version + 1, updated_at = now()
    where d.id = p_id;
end;
$$;
revoke all on function public.reserve_delivery_request(uuid) from public, anon, authenticated, service_role;

-- One RPC owns validation, idempotency, stock row locking and audit history.
create function public.manage_delivery(p_action text, p_command_id uuid, p_payload jsonb)
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
  units jsonb := '{}';
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
      'itemcode',btrim(coalesce(v->>'itemcode','')))) into rows from jsonb_array_elements(rows) v;
    if (select count(*) from jsonb_array_elements(rows)) <>
       (select count(distinct (v->>'purorder',v->>'sales_id',v->>'itemcode',v->>'delivery_date')) from jsonb_array_elements(rows) v)
      then raise exception 'DELIVERY_DUPLICATE_KEY'; end if;
    for x in select value from jsonb_array_elements(rows) order by value->>'delivery_date',value->>'purorder',value->>'sales_id',value->>'itemcode' loop
      if length(btrim(coalesce(x->>'purorder',''))) not between 1 and 200
        or length(btrim(coalesce(x->>'sales_id',''))) not between 1 and 200
        or length(btrim(coalesce(x->>'itemcode',''))) not between 1 and 200
        or position('*' in x->>'itemcode') > 0
        or coalesce(x->>'unit','') not in ('EA','SET')
        or coalesce(x->>'delivery_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or jsonb_typeof(x->'ordered_qty') is distinct from 'number'
        or (x->>'ordered_qty')::numeric not between 1 and 2147483647
        or (x->>'ordered_qty')::numeric <> trunc((x->>'ordered_qty')::numeric)
      then raise exception 'DELIVERY_INVALID_ROW'; end if;
      new_date := (x->>'delivery_date')::date;
      qty := (x->>'ordered_qty')::integer;
      if units ? (x->>'itemcode') and units->>(x->>'itemcode') <> x->>'unit' then raise exception 'DELIVERY_UNIT_CONFLICT:%', x->>'itemcode'; end if;
      units := units || jsonb_build_object(x->>'itemcode', x->>'unit');
      if exists (select 1 from public.inv_delivery_requests d where d.itemcode = x->>'itemcode' and d.unit <> x->>'unit') then
        raise exception 'DELIVERY_UNIT_CONFLICT:%', x->>'itemcode';
      end if;
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
      if x->>'unit' = 'SET' and p_payload->>'confirm_sets' is distinct from 'true' then raise exception 'DELIVERY_CONFIRM_SET_UNIT'; end if;
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
        if req.purorder <> x->>'purorder' or req.sales_id <> x->>'sales_id' or req.itemcode <> x->>'itemcode' or req.unit <> x->>'unit' then raise exception 'DELIVERY_TARGET_MISMATCH'; end if;
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
        'file_name',req.source_file,'confirm_sets',true,'rows',jsonb_build_array(
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

revoke all on function public.manage_delivery(text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.manage_delivery(text,uuid,jsonb) to authenticated;

create function public.list_delivery(p_offset integer default 0, p_search text default '', p_closed boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then raise exception 'DELIVERY_NOT_AUTHORIZED'; end if;
  select jsonb_build_object('total',count(*)) into result from public.inv_delivery_requests d
    where (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
      and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer)))>0);
  return result || jsonb_build_object('rows',coalesce((
    select jsonb_agg(q.row order by q.delivery_date,q.created_at,q.id) from (
      select d.id,d.delivery_date,d.created_at,to_jsonb(d)||jsonb_build_object(
        'shortage_qty',case when d.cancelled then 0 else d.ordered_qty-d.shipped_qty-d.reserved_qty end,
        'status',case when d.cancelled then 'cancelled' when d.shipped_qty=d.ordered_qty then 'done' when d.shipped_qty>0 then 'partial' else 'pending' end
      ) as row from public.inv_delivery_requests d
      where (p_closed or (not d.cancelled and d.shipped_qty<d.ordered_qty))
        and (p_search='' or position(lower(p_search) in lower(concat_ws(' ',d.purorder,d.sales_id,d.itemcode,d.customer)))>0)
      order by d.delivery_date,d.created_at,d.id limit 100 offset greatest(0,p_offset)
    ) q
  ),'[]'));
end;
$$;
revoke all on function public.list_delivery(integer,text,boolean) from public,anon,service_role;
grant execute on function public.list_delivery(integer,text,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
