begin;

select pg_advisory_xact_lock(72638104112000::bigint);

alter table public.inv_delivery_requests add column delivery_source text not null default 'erp'
  check (delivery_source in ('erp','manual'));

-- Preview and posting use the same internal item names; never source them
-- from an ERP delivery. Keep the catalog/customer priority used by the queue.
create function public.lookup_manual_delivery_item(p_itemcode text)
returns table(product_name text, customer text)
language plpgsql stable security definer set search_path=public as $$
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if length(coalesce(p_itemcode,'')) not between 1 and 200
    or btrim(p_itemcode) is distinct from p_itemcode or position('*' in p_itemcode)>0 then
    raise exception 'DELIVERY_INVALID_ITEM';
  end if;
  return query
    select names.product_name,names.customer from (
      select coalesce(c.product_name,i.product_name) as product_name,
        coalesce(public.resolve_delivery_system_customer(p_itemcode),c.customer) as customer
      from public.lookup_opening_inventory_items(array[p_itemcode]) c
      left join lateral (
        select btrim(q.product_name) as product_name from public.inv_incoming q
        where q.itemcode=p_itemcode and nullif(btrim(q.product_name),'') is not null
        order by q.id desc limit 1
      ) i on true
    ) names where names.product_name is not null;
end $$;

-- Preserve a manual schedule's internal customer snapshot when the catalog
-- and incoming lots lack one (e.g. a customer resolved from pallet history).
create or replace function public.set_delivery_system_customer()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  new.system_customer_name := coalesce(public.resolve_delivery_system_customer(new.itemcode),
    case when new.delivery_source='manual' then nullif(new.customer,'') end);
  return new;
end $$;

create or replace function public.refresh_delivery_system_customers(p_items text[])
returns void language sql security definer set search_path=public as $$
  with names as materialized (
    select d.itemcode, public.resolve_delivery_system_customer(d.itemcode) as customer
    from (select distinct r.itemcode from public.inv_delivery_requests r where r.itemcode=any(p_items)) d
  )
  update public.inv_delivery_requests r
  set system_customer_name=coalesce(n.customer,case when r.delivery_source='manual' then nullif(r.customer,'') end)
  from names n where r.itemcode=n.itemcode and r.system_customer_name is distinct from
    coalesce(n.customer,case when r.delivery_source='manual' then nullif(r.customer,'') end);
$$;

create function public.post_manual_delivery(p_command_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  cmd public.inv_delivery_commands%rowtype;
  item record;
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
  select * into item from public.lookup_manual_delivery_item(v_itemcode);
  if not found then raise exception 'DELIVERY_ITEM_NOT_FOUND'; end if;

  -- Internal reference only. No operator needs to invent a PO or Sales ID.
  insert into public.inv_delivery_requests(id,purorder,sales_id,itemcode,delivery_date,
    product_name,customer,unit,unit_label,ordered_qty,delivery_source,created_by)
  values(p_command_id,'MANUAL-'||p_command_id::text,'MANUAL',v_itemcode,v_delivery_date,
    item.product_name,coalesce(item.customer,''),'EA','',qty,'manual',actor);
  result := jsonb_build_object('request_id',p_command_id,'model_version',2);
  insert into public.inv_delivery_commands(id,actor,action,payload,result)
    values(p_command_id,actor,'manual',p_payload,result);
  return result;
end $$;

revoke all on function public.lookup_manual_delivery_item(text),public.post_manual_delivery(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.lookup_manual_delivery_item(text),public.post_manual_delivery(uuid,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
