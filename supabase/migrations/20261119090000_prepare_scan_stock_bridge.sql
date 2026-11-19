begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Preparation only: no trigger is attached and no pallet/receipt RPC changes.
do $$
begin
  if to_regprocedure('public.warehouse_item_identity(text)') is null
    or to_regprocedure('public.refresh_stock_summary(text[])') is null then
    raise exception 'SCAN_STOCK_PREREQUISITES_MISSING';
  end if;
end $$;
alter table public.inv_incoming
  add column source_type text,
  add column scan_pallet_data_id bigint,
  add column scan_pallet_id text;
alter table public.inv_incoming add constraint inv_incoming_scan_source_check check (
  (source_type is distinct from 'scan' and scan_pallet_data_id is null and scan_pallet_id is null)
  or (source_type='scan' and scan_pallet_data_id is not null and scan_pallet_data_id>0
    and nullif(btrim(scan_pallet_id),'') is not null and receipt_id is not null
    and manual_batch_id is null and manual_line_no is null)
) not valid;
-- Existing rows already satisfy the old stricter condition. Avoid a table-wide
-- validation pass; allow the same optional customer rule for new scan layers.
alter table public.inv_incoming drop constraint inv_incoming_customer_check;
alter table public.inv_incoming add constraint inv_incoming_customer_check check (
  opening_import_id is not null or manual_batch_id is not null
  or scan_pallet_data_id is not null or nullif(btrim(customer),'') is not null
) not valid;
create unique index inv_incoming_scan_source_uq on public.inv_incoming(scan_pallet_data_id) where scan_pallet_data_id is not null;
comment on column public.inv_incoming.scan_pallet_data_id is 'Immutable production-version identity, validated by scan bridge. No new FK/DDL on production tables during preparation.';
comment on column public.inv_incoming.scan_pallet_id is 'Pallet label snapshot for tracing the confirmed receipt.';
comment on column public.inv_incoming.source_type is 'scan for automatic scan stock; existing/manual/opening rows remain unchanged.';

create table public.inv_scan_stock_activation (
  id integer primary key check(id=1),
  activated_at timestamptz not null,
  cutover_note text not null,
  rpc_fingerprints jsonb not null
);
revoke all on public.inv_scan_stock_activation from public,anon,authenticated,service_role;

create function public.scan_stock_receive_transition()
returns trigger language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare actor uuid:=auth.uid(); payload jsonb; issue text;
begin
  if tg_table_schema<>'public' or tg_table_name<>'pallet_data' or tg_op<>'UPDATE' or tg_level<>'STATEMENT' then
    raise exception 'SCAN_STOCK_INVALID_TRIGGER';
  end if;
  -- Only the changed rows are examined. Production edits, scans, cancellation,
  -- position edits and already-WHdone updates return before any inventory lock.
  select jsonb_agg(to_jsonb(n) order by n.id) into payload
    from scan_stock_new n join scan_stock_old o using(id)
    where n.status='WHdone' and o.status is distinct from 'WHdone';
  if payload is null then return null; end if;
  if actor is null or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then
    raise exception 'SCAN_STOCK_NOT_AUTHORIZED';
  end if;
  if jsonb_array_length(payload)>200 then raise exception 'SCAN_STOCK_BATCH_TOO_LARGE'; end if;
  if exists(select 1 from scan_stock_new n join scan_stock_old o using(id)
    where n.status='WHdone' and o.status is distinct from 'WHdone'
      and (o.status is null or o.status not in ('pendingWH','processingWH') or n.effect_to is not null
        or n.wh_receipt is null or n.quantity<=0 or btrim(n.itemcode) !~ '^[^[:space:]*]{1,200}$'
        or length(btrim(n.wo))>200)) then
    raise exception 'SCAN_STOCK_INVALID_PALLET';
  end if;
  if exists(select 1 from jsonb_array_elements(payload) x left join public.wh_receipt r on r.receipt_id=x->>'wh_receipt'
    where r.receipt_id is null or r.status<>'active' or r.user_id is distinct from actor) then
    raise exception 'SCAN_STOCK_INVALID_RECEIPT';
  end if;
  -- Existing receipt RPCs hold their day/pallet locks first. Inventory writers
  -- never wait on receipt day locks. Do not invert this order in a new wrapper.
  perform pg_advisory_xact_lock(72638104112000::bigint);
  if exists(select 1 from jsonb_array_elements(payload) x join public.inv_incoming i on i.scan_pallet_data_id=(x->>'id')::bigint) then
    raise exception 'SCAN_STOCK_ALREADY_POSTED';
  end if;
  with codes as (
    select distinct btrim(x->>'itemcode') as itemcode from jsonb_array_elements(payload) x
    where nullif(btrim(x->>'product_name'),'') is null or nullif(btrim(x->>'customer'),'') is null
  ), identities as materialized (
    select n.* from codes c cross join lateral public.warehouse_item_identity(c.itemcode) n
  )
  select string_agg(distinct btrim(x->>'itemcode'),', ') into issue
    from jsonb_array_elements(payload) x left join identities n on n.itemcode=btrim(x->>'itemcode')
    where coalesce(nullif(btrim(x->>'product_name'),''),n.product_name) is null;
  if issue is not null then raise exception 'SCAN_STOCK_MISSING_NAME:%',issue; end if;
  with codes as (
    select distinct btrim(x->>'itemcode') as itemcode from jsonb_array_elements(payload) x
    where nullif(btrim(x->>'product_name'),'') is null or nullif(btrim(x->>'customer'),'') is null
  ), identities as materialized (
    select n.* from codes c cross join lateral public.warehouse_item_identity(c.itemcode) n
  )
  insert into public.inv_incoming(received_date,production_date,itemcode,product_name,customer,wo,
    received_qty,issued_qty,entered_by,receipt_id,note,source_type,scan_pallet_data_id,scan_pallet_id)
  select r.receipt_date,nullif(x->>'working_day','')::date,btrim(x->>'itemcode'),
    coalesce(nullif(btrim(x->>'product_name'),''),n.product_name),
    coalesce(nullif(btrim(x->>'customer'),''),n.customer,''),nullif(btrim(x->>'wo'),''),
    (x->>'quantity')::integer,0,actor,r.receipt_id,'','scan',(x->>'id')::bigint,x->>'pallet_id'
  from jsonb_array_elements(payload) x join public.wh_receipt r on r.receipt_id=x->>'wh_receipt'
  left join identities n on n.itemcode=btrim(x->>'itemcode') order by x->>'itemcode',(x->>'id')::bigint;
  return null;
exception when lock_not_available then raise exception using errcode='55P03',message='SCAN_STOCK_BUSY';
end $$;

-- Every newly-created receipt must match the final stock/pallet state at COMMIT,
-- including RPC races that update zero pallets or update only part of a batch.
create function public.scan_stock_validate_receipt()
returns trigger language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare receipt public.wh_receipt%rowtype; pallets bigint; quantity bigint; stock_pallets bigint; stock_quantity bigint;
begin
  if tg_table_schema<>'public' or tg_table_name<>'wh_receipt' or tg_op<>'INSERT' then raise exception 'SCAN_STOCK_INVALID_TRIGGER'; end if;
  select * into strict receipt from public.wh_receipt where receipt_id=new.receipt_id;
  select count(*),coalesce(sum(p.quantity),0) into pallets,quantity from public.pallet_data p
    where p.wh_receipt=receipt.receipt_id and p.status='WHdone' and p.effect_to is null;
  select count(*),coalesce(sum(i.received_qty),0) into stock_pallets,stock_quantity from public.inv_incoming i
    where i.receipt_id=receipt.receipt_id and i.source_type='scan';
  if receipt.status<>'active' or pallets<>receipt.total_pallet or quantity<>receipt.total_quantity
    or stock_pallets<>pallets or stock_quantity<>quantity or exists(
      select 1 from public.inv_incoming i left join public.pallet_data p on p.id=i.scan_pallet_data_id
      where i.receipt_id=receipt.receipt_id and i.source_type='scan' and (
        p.id is null or p.wh_receipt is distinct from receipt.receipt_id or p.status<>'WHdone' or p.effect_to is not null
        or i.itemcode is distinct from btrim(p.itemcode) or i.scan_pallet_id is distinct from p.pallet_id
        or i.received_qty<>p.quantity or i.production_date is distinct from p.working_day
        or i.received_date<>receipt.receipt_date or i.wo is distinct from nullif(btrim(p.wo),'')
        or i.entered_by is distinct from receipt.user_id)
    ) then raise exception 'SCAN_STOCK_RECEIPT_MISMATCH:%',receipt.receipt_id; end if;
  return null;
end $$;
revoke all on function public.scan_stock_receive_transition(),public.scan_stock_validate_receipt() from public,anon,authenticated,service_role;

-- Read-only recovery for lost HTTP responses. Match the WHOLE receipt and its
-- confirming operator, not a subset or someone else's receipt. Works before
-- activation too; it never creates/backfills inventory for historical receipts.
create function public.recover_scan_receipt(p_pallet_ids text[])
returns table(receipt_id text,receipt_date date,total_pallet integer,total_quantity bigint)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor uuid:=auth.uid(); target text; matched integer; supplied integer:=cardinality(p_pallet_ids);
begin
  if actor is null or not public.has_permission('scan.standard')
    or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then raise exception 'NOT_AUTHORIZED'; end if;
  if supplied is null or supplied not between 1 and 200 or exists(select 1 from unnest(p_pallet_ids) x where x is null or length(btrim(x)) not between 1 and 128)
    or (select count(distinct btrim(x)) from unnest(p_pallet_ids) x)<>supplied then raise exception 'INVALID_PALLET_ID'; end if;
  select min(p.wh_receipt),count(*)::integer into target,matched from public.pallet_data p
    where p.pallet_id in(select btrim(x) from unnest(p_pallet_ids) x) and p.effect_to is null and p.status='WHdone';
  if matched<>supplied or target is null then return; end if;
  return query select r.receipt_id,r.receipt_date,r.total_pallet,r.total_quantity from public.wh_receipt r
    where r.receipt_id=target and r.status='active' and r.user_id=actor and r.total_pallet=supplied
      and (select count(*) from public.pallet_data p where p.wh_receipt=target and p.effect_to is null)=supplied
      and not exists(select 1 from public.pallet_data p where p.pallet_id in(select btrim(x) from unnest(p_pallet_ids) x)
        and p.effect_to is null and (p.status<>'WHdone' or p.wh_receipt is distinct from target))
      and r.total_quantity=(select sum(p.quantity) from public.pallet_data p where p.wh_receipt=target and p.effect_to is null);
end $$;
revoke all on function public.recover_scan_receipt(text[]) from public,anon,authenticated,service_role;
grant execute on function public.recover_scan_receipt(text[]) to authenticated;

create function public.scan_stock_preflight()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare blockers jsonb:='[]'; rpc jsonb; bad bigint; sample jsonb; enabled integer; posted bigint;
begin
  select coalesce(jsonb_object_agg(p.proname,jsonb_build_object('hash',md5(p.prosrc),'security_definer',p.prosecdef,'settings',p.proconfig)),'{}') into rpc
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.oid in(to_regprocedure('public.create_warehouse_receipt_from_scan(text[])'),to_regprocedure('public.create_warehouse_receipt(text[])'));
  if rpc#>>'{create_warehouse_receipt_from_scan,hash}' is distinct from 'f47cbd310ae324d1ccfc01088740f6b6' then
    blockers:=blockers||jsonb_build_array('SCAN_RPC_DRIFT: inspect actual production function before activation');
  end if;
  if (rpc#>>'{create_warehouse_receipt_from_scan,security_definer}')::boolean is distinct from true then
    blockers:=blockers||jsonb_build_array('SCAN_RPC_SECURITY_DRIFT');
  end if;
  if rpc ? 'create_warehouse_receipt' and rpc#>>'{create_warehouse_receipt,hash}'<>'81c92cfa96945decde2070b13eb7a3e8' then
    blockers:=blockers||jsonb_build_array('LEGACY_RPC_DRIFT: unreviewed legacy confirmation function');
  end if;
  if exists(select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.proname not in('create_warehouse_receipt_from_scan','create_warehouse_receipt')
      and p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?wh_receipt([[:space:](])') then
    blockers:=blockers||jsonb_build_array('OTHER_RECEIPT_WRITERS: review functions writing receipt headers');
  end if;
  if to_regprocedure('public.cancel_warehouse_receipt(text)') is not null then
    blockers:=blockers||jsonb_build_array('LEGACY_RECEIPT_REVERSAL_PRESENT: warehouse stock cannot follow an unreviewed receipt reversal');
  end if;
  if exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and t.tgrelid='public.pallet_data'::regclass
      and t.tgfoid<>'public.scan_stock_receive_transition()'::regprocedure and p.prosrc ilike '%inv_incoming%') then
    blockers:=blockers||jsonb_build_array('OTHER_PALLET_STOCK_TRIGGER: avoid duplicate inventory bridges');
  end if;
  if exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and t.tgrelid='public.inv_incoming'::regclass
      and p.prosrc ~* 'update[[:space:]]+(public\.)?pallet_data([[:space:]])') then
    blockers:=blockers||jsonb_build_array('INVENTORY_BACKFLOW_TRIGGER: review reverse lock ordering');
  end if;
  if (select count(*) from pg_trigger where tgrelid='public.inv_incoming'::regclass and not tgisinternal
    and tgname in('inventory_source_lock','inventory_summary_insert') and tgenabled='O')<>2 then
    blockers:=blockers||jsonb_build_array('INVENTORY_TRIGGERS_MISSING_OR_DISABLED');
  end if;
  if not exists(select 1 from pg_index where indexrelid='public.inv_incoming_scan_source_uq'::regclass and indisvalid and indisunique) then
    blockers:=blockers||jsonb_build_array('SCAN_SOURCE_UNIQUE_INDEX_INVALID');
  end if;
  select count(*) into enabled from pg_trigger where not tgisinternal and tgname in('scan_stock_receive','scan_stock_receipt_complete') and tgenabled='O';
  if enabled<>0 or exists(select 1 from public.inv_scan_stock_activation) then blockers:=blockers||jsonb_build_array('ALREADY_ACTIVATED_OR_PARTIAL_TRIGGER_STATE'); end if;
  select count(*) into posted from public.inv_incoming where scan_pallet_data_id is not null;
  if posted>0 then blockers:=blockers||jsonb_build_array('SCAN_STOCK_EXISTS_BEFORE_ACTIVATION'); end if;
  with pending as materialized (
    select p.* from public.pallet_data p where p.effect_to is null and p.status in('pendingWH','processingWH')
  ), codes as (select distinct btrim(itemcode) as itemcode from pending where nullif(btrim(product_name),'') is null),
  names as materialized (select n.* from codes c cross join lateral public.warehouse_item_identity(c.itemcode) n),
  invalid as (
    select p.pallet_id from pending p left join names n on n.itemcode=btrim(p.itemcode)
    where p.quantity<=0 or btrim(p.itemcode) !~ '^[^[:space:]*]{1,200}$' or length(btrim(p.wo))>200
      or coalesce(nullif(btrim(p.product_name),''),n.product_name) is null
  ) select (select count(*) from invalid),(select coalesce(jsonb_agg(pallet_id),'[]') from(select pallet_id from invalid order by pallet_id limit 25)s) into bad,sample;
  if bad>0 then blockers:=blockers||jsonb_build_array('PENDING_PALLETS_INVALID: fix names/itemcodes/quantities before activation'); end if;
  return jsonb_build_object('prepared_version',1,'server_version',current_setting('server_version'),
    'ready_to_activate',jsonb_array_length(blockers)=0,'blockers',blockers,'enabled_bridge_triggers',enabled,
    'rpc_fingerprints',rpc,'invalid_pending_count',bad,'invalid_pending_sample',sample,
    'pending_missing_production_date',(select count(*) from public.pallet_data where effect_to is null and status in('pendingWH','processingWH') and working_day is null),
    'activation',(select to_jsonb(a) from public.inv_scan_stock_activation a));
end $$;
revoke all on function public.scan_stock_preflight() from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
commit;
