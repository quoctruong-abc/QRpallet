begin;

-- Preview and posting share the same field-by-field lookup. The Excel name
-- is only a stock-row fallback; it does not populate the pallet catalog.
create function public.lookup_opening_inventory_items(p_itemcodes text[])
returns table (itemcode text, product_name text, customer text)
language sql
stable
security invoker
set search_path = public
as $$
  select i.itemcode,
    coalesce(nullif(btrim(c.product_name), ''), pn.product_name),
    coalesce(nullif(btrim(c.customer), ''), pc.customer)
  from (select distinct u.itemcode from unnest(p_itemcodes) as u(itemcode) where u.itemcode is not null) i
  left join public.item_pallet_config c on c.itemcode = i.itemcode
  left join lateral (
    select btrim(s.product_name) as product_name from public.pallet_data s
    where s.itemcode = i.itemcode and nullif(btrim(c.product_name), '') is null
      and nullif(btrim(s.product_name), '') is not null
    order by (s.effect_to is null) desc, s.updated_at desc, s.id desc limit 1
  ) pn on true
  left join lateral (
    select btrim(s.customer) as customer from public.pallet_data s
    where s.itemcode = i.itemcode and nullif(btrim(c.customer), '') is null
      and nullif(btrim(s.customer), '') is not null
    order by (s.effect_to is null) desc, s.updated_at desc, s.id desc limit 1
  ) pc on true
$$;

revoke all on function public.lookup_opening_inventory_items(text[]) from public, anon, authenticated;
grant execute on function public.lookup_opening_inventory_items(text[]) to service_role;

drop function public.post_opening_inventory(uuid, text, text, jsonb);

create function public.post_opening_inventory(p_actor uuid, p_fingerprint text, p_file_name text, p_rows jsonb, p_legacy_fingerprint text default null)
returns table (already_imported boolean, line_count integer, missing_customer_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
  v_inserted integer;
  v_missing integer;
begin
  if not exists (select 1 from public.profiles p where p.id = p_actor and p.is_active and p.role = 'superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'INV_OPENING_INVALID_ROWS'; end if;
  v_count := jsonb_array_length(p_rows);
  if v_count not between 1 and 40000 then raise exception 'INV_OPENING_INVALID_ROWS'; end if;

  -- Detect data already posted under the earlier allocation of J.
  if p_legacy_fingerprint is distinct from p_fingerprint then
    return query select true, i.line_count, i.missing_customer_count
      from public.inv_opening_imports i where i.fingerprint = p_legacy_fingerprint;
    if found then return; end if;
  end if;

  -- The import record and stock changes commit together. Concurrent retries wait
  -- on the same fingerprint and return the existing result after it commits.
  insert into public.inv_opening_imports (fingerprint, file_name, entered_by, line_count)
  values (p_fingerprint, p_file_name, p_actor, v_count)
  on conflict (fingerprint) do nothing;
  if not found then
    return query select true, i.line_count, i.missing_customer_count
      from public.inv_opening_imports i where i.fingerprint = p_fingerprint;
    return;
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_rows) as r(
      kind text, production_date date, received_qty integer, issued_qty integer, balance_qty integer
    )
    where r.received_qty is null or r.issued_qty is null or r.balance_qty is null
      or r.received_qty <= 0 or r.issued_qty not between 0 and r.received_qty
      or r.balance_qty <> r.received_qty - r.issued_qty
      or (r.kind = 'opening' and r.production_date is not null)
  ) then raise exception 'INV_OPENING_INVALID_BALANCE'; end if;

  with detail as materialized (
    select * from jsonb_to_recordset(p_rows) as r(
      excel_row integer, kind text, received_date date, production_date date, itemcode text,
      product_name text, wo text, received_qty integer, issued_qty integer
    )
  ), lookup as materialized (
    select l.* from public.lookup_opening_inventory_items(array(select distinct d.itemcode from detail d)) l
  ), backfilled as (
    insert into public.item_pallet_config as c (itemcode, product_name, customer)
    select l.itemcode, l.product_name, l.customer
    from lookup l
    left join public.item_pallet_config existing on existing.itemcode = l.itemcode
    where (l.product_name is not null and nullif(btrim(existing.product_name), '') is null)
       or (l.customer is not null and nullif(btrim(existing.customer), '') is null)
    order by l.itemcode
    on conflict on constraint item_pallet_config_pkey do update
    set product_name = coalesce(nullif(btrim(c.product_name), ''), excluded.product_name),
        customer = coalesce(nullif(btrim(c.customer), ''), excluded.customer)
    returning c.itemcode, c.product_name, c.customer
  ), inserted as (
    insert into public.inv_incoming (
      received_date, production_date, itemcode, product_name, customer, wo, received_qty, issued_qty,
      entered_by, note, opening_import_id, opening_excel_row, opening_kind
    )
    select d.received_date, d.production_date, d.itemcode,
      coalesce(nullif(btrim(b.product_name), ''), l.product_name, nullif(btrim(d.product_name), '')),
      coalesce(nullif(btrim(b.customer), ''), l.customer, ''), d.wo, d.received_qty, d.issued_qty,
      p_actor, '', p_fingerprint, d.excel_row, d.kind
    from detail d
    join lookup l on l.itemcode = d.itemcode
    left join backfilled b on b.itemcode = d.itemcode
    order by d.excel_row, d.kind
    returning customer
  )
  select count(*), count(*) filter (where customer = '') into v_inserted, v_missing from inserted;
  if v_inserted <> v_count then raise exception 'INV_OPENING_INVALID_ROWS'; end if;

  update public.inv_opening_imports i set missing_customer_count = v_missing
    where i.fingerprint = p_fingerprint;
  return query select false, v_count, v_missing;
end;
$$;

revoke all on function public.post_opening_inventory(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.post_opening_inventory(uuid, text, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';
commit;
