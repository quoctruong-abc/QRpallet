begin;

create table public.inv_opening_imports (
  fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{64}$'),
  file_name text not null check (length(file_name) between 1 and 255),
  entered_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  line_count integer not null check (line_count between 1 and 40000),
  missing_customer_count integer not null default 0 check (missing_customer_count between 0 and line_count)
);

alter table public.inv_opening_imports enable row level security;
revoke all on public.inv_opening_imports from public, anon, authenticated;
grant select, insert, update on public.inv_opening_imports to service_role;

alter table public.inv_incoming
  add column opening_import_id text references public.inv_opening_imports(fingerprint) on delete restrict,
  add column opening_excel_row integer,
  add column opening_kind text,
  drop constraint inv_incoming_customer_check,
  add constraint inv_incoming_customer_check
    check (opening_import_id is not null or nullif(btrim(customer), '') is not null),
  add constraint inv_incoming_opening_source_check check (
    (opening_import_id is null and opening_excel_row is null and opening_kind is null)
    or (opening_import_id is not null and manual_batch_id is null
        and opening_excel_row is not null and opening_excel_row >= 6
        and opening_kind is not null and opening_kind in ('opening', 'receipt')
        and (opening_kind <> 'opening' or production_date is null))
  );

create unique index inv_incoming_opening_line_uidx
  on public.inv_incoming (opening_import_id, opening_excel_row, opening_kind)
  where opening_import_id is not null;

create function public.post_opening_inventory(p_actor uuid, p_fingerprint text, p_file_name text, p_rows jsonb)
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
      or (r.kind = 'opening' and (r.issued_qty <> 0 or r.production_date is not null))
  ) then raise exception 'INV_OPENING_INVALID_BALANCE'; end if;

  with detail as materialized (
    select * from jsonb_to_recordset(p_rows) as r(
      excel_row integer, kind text, received_date date, production_date date, itemcode text,
      product_name text, wo text, received_qty integer, issued_qty integer
    )
  ), items as (
    select distinct on (d.itemcode) d.itemcode, d.product_name
    from detail d order by d.itemcode, d.excel_row, d.kind
  ), lookup as materialized (
    select i.itemcode, nullif(btrim(c.customer), '') as catalog_customer,
      p.customer as pallet_customer, coalesce(p.product_name, i.product_name) as catalog_name
    from items i
    left join public.item_pallet_config c on c.itemcode = i.itemcode
    left join lateral (
      select btrim(s.customer) as customer, nullif(btrim(s.product_name), '') as product_name
      from public.pallet_data s
      where nullif(btrim(c.customer), '') is null and s.itemcode = i.itemcode
        and nullif(btrim(s.customer), '') is not null
      order by (s.effect_to is null) desc, s.updated_at desc, s.id desc
      limit 1
    ) p on true
  ), backfilled as (
    insert into public.item_pallet_config as c (itemcode, product_name, customer)
    select l.itemcode, l.catalog_name, l.pallet_customer from lookup l
    where l.catalog_customer is null and l.pallet_customer is not null
    order by l.itemcode
    on conflict on constraint item_pallet_config_pkey do update
    set product_name = coalesce(nullif(btrim(c.product_name), ''), excluded.product_name),
        customer = coalesce(nullif(btrim(c.customer), ''), excluded.customer)
    returning c.itemcode, c.customer
  ), inserted as (
    insert into public.inv_incoming (
      received_date, production_date, itemcode, product_name, customer, wo, received_qty, issued_qty,
      entered_by, note, opening_import_id, opening_excel_row, opening_kind
    )
    select d.received_date, d.production_date, d.itemcode, d.product_name,
      coalesce(b.customer, l.catalog_customer, ''), d.wo, d.received_qty, d.issued_qty,
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

revoke all on function public.post_opening_inventory(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.post_opening_inventory(uuid, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
