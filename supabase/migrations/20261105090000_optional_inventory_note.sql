begin;

-- Keep note as text and preserve existing values and retry payloads.
alter table public.inv_incoming
  alter column note set default '',
  drop constraint inv_incoming_note_check,
  add constraint inv_incoming_note_check check (length(btrim(note)) <= 2000);

create or replace function public.post_manual_inventory(p_request_id uuid, p_rows jsonb)
returns table (batch_id uuid, row_count integer, total_quantity bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.inv_incoming_batches%rowtype;
  v_row jsonb;
  v_item record;
  v_catalog jsonb := '{}'::jsonb;
  v_code text;
  v_count integer;
  v_total bigint := 0;
  v_quantity numeric;
  v_received date;
  v_production date;
  v_line_no integer := 0;
begin
  if v_actor is null or not public.has_permission('receipt.view')
     or not exists (select 1 from public.profiles p where p.id = v_actor and p.is_active) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_request_id is null then raise exception 'INV_INVALID_REQUEST'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'INV_INVALID_ROWS'; end if;
  v_count := jsonb_array_length(p_rows);
  if v_count not between 1 and 500 then raise exception 'INV_INVALID_ROWS'; end if;

  -- A retry with the same actor, UUID and payload returns the original result.
  -- Concurrent retries serialize here; no additional stock rows can be posted.
  perform pg_advisory_xact_lock(hashtextextended('INV_MANUAL:' || p_request_id::text, 0));
  select b.* into v_existing from public.inv_incoming_batches b where b.id = p_request_id;
  if found then
    if v_existing.entered_by is distinct from v_actor or v_existing.payload is distinct from p_rows then
      raise exception 'INV_REQUEST_CONFLICT';
    end if;
    return query select v_existing.id, v_existing.row_count, v_existing.total_quantity;
    return;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'INV_INVALID_ROW'; end if;
    v_code := btrim(coalesce(v_row->>'itemcode', ''));
    if jsonb_typeof(v_row->'itemcode') is distinct from 'string' or length(v_code) not between 1 and 200 or position('*' in v_code) > 0 then
      raise exception 'INV_INVALID_ITEMCODE';
    end if;
    if jsonb_typeof(v_row->'quantity') is distinct from 'number' then raise exception 'INV_INVALID_QUANTITY'; end if;
    v_quantity := (v_row->>'quantity')::numeric;
    if v_quantity <> trunc(v_quantity) or v_quantity not between 1 and 2147483647 then raise exception 'INV_INVALID_QUANTITY'; end if;
    v_total := v_total + v_quantity::bigint;
    if coalesce(jsonb_typeof(v_row->'note'), 'null') not in ('null', 'string')
       or length(btrim(coalesce(v_row->>'note', ''))) > 2000 then
      raise exception 'INV_INVALID_NOTE';
    end if;
    if coalesce(jsonb_typeof(v_row->'wo'), 'null') not in ('null', 'string') or length(coalesce(v_row->>'wo', '')) > 200 then raise exception 'INV_INVALID_WO'; end if;
    begin
      if jsonb_typeof(v_row->'received_date') is distinct from 'string' or coalesce(v_row->>'received_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'INV_INVALID_DATE'; end if;
      v_received := (v_row->>'received_date')::date;
      if to_char(v_received, 'YYYY-MM-DD') <> v_row->>'received_date' then raise exception 'INV_INVALID_DATE'; end if;
      if coalesce(jsonb_typeof(v_row->'production_date'), 'null') not in ('null', 'string') then raise exception 'INV_INVALID_DATE'; end if;
      if nullif(v_row->>'production_date', '') is not null then
        if v_row->>'production_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'INV_INVALID_DATE'; end if;
        v_production := (v_row->>'production_date')::date;
        if to_char(v_production, 'YYYY-MM-DD') <> v_row->>'production_date' then raise exception 'INV_INVALID_DATE'; end if;
      end if;
    exception when others then
      raise exception 'INV_INVALID_DATE';
    end;
  end loop;

  -- Resolve authoritative metadata once per item, in a stable lock order.
  for v_code in select distinct btrim(value->>'itemcode') from jsonb_array_elements(p_rows) order by 1 loop
    select r.* into v_item from public.resolve_warehouse_item(v_code) r;
    if not found or nullif(btrim(v_item.product_name), '') is null or nullif(btrim(v_item.customer), '') is null then
      raise exception 'INV_ITEM_NOT_FOUND:%', v_code;
    end if;
    v_catalog := v_catalog || jsonb_build_object(v_code, jsonb_build_object('product_name', v_item.product_name, 'customer', v_item.customer));
  end loop;

  insert into public.inv_incoming_batches(id, entered_by, payload, row_count, total_quantity)
  values (p_request_id, v_actor, p_rows, v_count, v_total);

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_line_no := v_line_no + 1;
    v_code := btrim(v_row->>'itemcode');
    insert into public.inv_incoming (
      received_date, production_date, itemcode, product_name, customer, wo,
      received_qty, issued_qty, entered_by, note, manual_batch_id, manual_line_no
    ) values (
      (v_row->>'received_date')::date, nullif(v_row->>'production_date', '')::date,
      v_code, v_catalog->v_code->>'product_name', v_catalog->v_code->>'customer', nullif(btrim(v_row->>'wo'), ''),
      (v_row->>'quantity')::numeric::integer, 0, v_actor, btrim(coalesce(v_row->>'note', '')), p_request_id, v_line_no
    );
  end loop;
  return query select p_request_id, v_count, v_total;
end;
$$;

-- CREATE OR REPLACE preserves the RPC's existing execute permissions.
notify pgrst, 'reload schema';
commit;
