begin;

alter table public.item_pallet_config
  add column "ERP_name" text,
  add column netweight numeric;

create function public.sync_warehouse_master_data(p_rows jsonb,p_preview boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  input_count integer;
  counts jsonb;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='superadmin') then
    raise exception 'MASTER_DATA_NOT_AUTHORIZED';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or p_preview is null then
    raise exception 'MASTER_DATA_INVALID_ROWS';
  end if;
  input_count := jsonb_array_length(p_rows);
  if input_count not between 1 and 20000 then raise exception 'MASTER_DATA_INVALID_ROWS'; end if;
  if exists (
    select from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'itemcode') is distinct from 'string'
      or length(btrim(r->>'itemcode')) not between 1 and 200
      or btrim(r->>'itemcode') ~ '[[:space:]*]'
      or jsonb_typeof(r->'erp_name') is distinct from 'string'
      or length(btrim(r->>'erp_name')) not between 1 and 500
      or coalesce(jsonb_typeof(r->'netweight'),'null') not in ('null','number')
  ) then raise exception 'MASTER_DATA_INVALID_ROW'; end if;
  if exists (
    select from jsonb_to_recordset(p_rows) as r(netweight numeric) where r.netweight not between 0 and 1000000000000000
  ) then raise exception 'MASTER_DATA_INVALID_ROW'; end if;
  if (select count(distinct btrim(r.itemcode)) from jsonb_to_recordset(p_rows) as r(itemcode text))<>input_count then
    raise exception 'MASTER_DATA_DUPLICATE_ITEM';
  end if;

  if not p_preview then perform pg_advisory_xact_lock(72638104112000::bigint); end if;
  select jsonb_build_object(
    'inserted',count(*) filter(where c.itemcode is null),
    'updated',count(*) filter(where c.itemcode is not null and
      (c."ERP_name" is distinct from btrim(r.erp_name) or (r.netweight is not null and c.netweight is distinct from r.netweight))),
    'unchanged',count(*) filter(where c.itemcode is not null and
      c."ERP_name" is not distinct from btrim(r.erp_name) and (r.netweight is null or c.netweight is not distinct from r.netweight))
  ) into counts
  from jsonb_to_recordset(p_rows) as r(itemcode text,erp_name text,netweight numeric)
  left join public.item_pallet_config c on c.itemcode=btrim(r.itemcode);

  if not p_preview then
    insert into public.item_pallet_config as c(itemcode,"ERP_name",product_name,netweight)
    select btrim(r.itemcode),btrim(r.erp_name),btrim(r.erp_name),r.netweight
    from jsonb_to_recordset(p_rows) as r(itemcode text,erp_name text,netweight numeric)
    order by btrim(r.itemcode)
    on conflict(itemcode) do update set
      "ERP_name"=excluded."ERP_name",netweight=coalesce(excluded.netweight,c.netweight)
    where c."ERP_name" is distinct from excluded."ERP_name"
      or (excluded.netweight is not null and c.netweight is distinct from excluded.netweight);
  end if;
  return counts;
end $$;

revoke all on function public.sync_warehouse_master_data(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.sync_warehouse_master_data(jsonb,boolean) to authenticated;

-- A catalog-only item must not create a zero-stock row. Changes to items
-- already tracked by warehouse stock or delivery still refresh as before.
create or replace function public.refresh_changed_stock_items()
returns trigger language plpgsql security definer set search_path=public as $$
declare items text[];
begin
  if tg_op='INSERT' then select array_agg(distinct itemcode) into items from changed_new;
  elsif tg_op='DELETE' then select array_agg(distinct itemcode) into items from changed_old;
  else select array_agg(distinct itemcode) into items from (select itemcode from changed_new union select itemcode from changed_old) x;
  end if;
  if tg_table_name='item_pallet_config' and cardinality(items)>0 then
    select array_agg(s.itemcode) into items from public.inv_stock_summary s where s.itemcode=any(items);
  end if;
  if cardinality(items)>0 then
    if tg_table_name in ('item_pallet_config','inv_incoming') then
      perform public.refresh_delivery_system_customers(items);
    end if;
    perform public.refresh_stock_summary(items);
  end if;
  return null;
end $$;

notify pgrst,'reload schema';
commit;
