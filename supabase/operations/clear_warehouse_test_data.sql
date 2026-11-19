-- MANUAL OPERATION ONLY. Outside supabase/migrations; never auto-deploy/run.
-- Resets ALL rows in 11 tables, not a filtered set. Only for a database whose
-- warehouse ledger contains exclusively test data, BEFORE scan-stock activation.
-- Does not drop tables, reset identities, erase master data or old scan receipts.
-- Pause warehouse writes/imports/approvals and close warehouse tabs on all devices.
-- Export reviewed tables first. Preview JSON is a guard, NOT a backup.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local timezone='UTC';
set local datestyle='ISO, YMD';

do $$
declare
  acknowledgement text:='__REVIEW_REQUIRED__';
  expected_manifest jsonb:='{}'::jsonb;
  names text[]:=array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary'];
  entry text; relation regclass; bad text; actual_manifest jsonb:='{}'; snapshot jsonb; found_rows boolean; audit_count bigint;
begin
  if acknowledgement<>'CLEAR_ONLY_PREACTIVATION_WAREHOUSE_TEST_DATA' then
    raise exception 'WAREHOUSE_CLEANUP_NOT_AUTHORIZED: review scope/backup and change acknowledgement manually';
  end if;
  if jsonb_typeof(expected_manifest)<>'object' or expected_manifest='{}'::jsonb then
    raise exception 'WAREHOUSE_CLEANUP_PREVIEW_REQUIRED: paste the full expected_manifest from the read-only preview';
  end if;
  foreach entry in array names loop
    relation:=to_regclass('public.'||entry);
    if relation is null then raise exception 'WAREHOUSE_CLEANUP_SCHEMA_MISSING:%',entry; end if;
    if not has_table_privilege(current_user,relation,'TRUNCATE') then
      raise exception 'WAREHOUSE_CLEANUP_OWNER_REQUIRED:%',entry;
    end if;
  end loop;
  select string_agg(c.relname,', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and left(c.relname,4)='inv_' and c.relkind in('r','p')
      and not c.relname=any(names) and c.relname<>'inv_scan_stock_activation';
  if bad is not null then raise exception 'WAREHOUSE_CLEANUP_UNKNOWN_TABLES:%',bad; end if;

  -- Serialize with activation's DDL, while remaining compatible with normal
  -- production/scan row writes. Do not take the inventory lock ahead of DDL.
  lock table public.wh_receipt,public.pallet_data in row exclusive mode nowait;
  -- Acquire every target without waiting. A writer/reader already in flight
  -- makes this operation fail and roll back rather than form a lock cycle.
  lock table only public.inv_delivery_issue_lines,
    only public.inv_delivery_issues,
    only public.inv_delivery_reservations_legacy,
    only public.inv_delivery_commands,
    only public.inv_delivery_requests,
    only public.inv_incoming_proposal_lines,
    only public.inv_incoming_proposals,
    only public.inv_incoming,
    only public.inv_incoming_batches,
    only public.inv_opening_imports,
    only public.inv_stock_summary in access exclusive mode nowait;
  foreach entry in array names loop
    relation:=to_regclass('public.'||entry);
    if not exists(select 1 from pg_class c where c.oid=relation and c.relkind='r' and not c.relispartition)
      or exists(select 1 from pg_inherits where inhparent=relation or inhrelid=relation) then
      raise exception 'WAREHOUSE_CLEANUP_UNREVIEWED_TABLE_STRUCTURE:%',entry;
    end if;
  end loop;
  if not pg_try_advisory_xact_lock(72638104112000::bigint) then
    raise exception 'WAREHOUSE_CLEANUP_BUSY: inventory/catalog writer is active; retry after pausing warehouse operations';
  end if;

  if to_regclass('public.inv_scan_stock_activation') is not null then
    execute 'select count(*) from public.inv_scan_stock_activation' into audit_count;
    if audit_count>0 then raise exception 'WAREHOUSE_CLEANUP_ALREADY_ACTIVATED: activation audit must never be cleared'; end if;
  end if;
  if exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and t.tgrelid in('public.pallet_data'::regclass,'public.wh_receipt'::regclass)
      and (t.tgname in('scan_stock_receive','scan_stock_receipt_complete')
        or (p.pronamespace='public'::regnamespace and p.proname in('scan_stock_receive_transition','scan_stock_validate_receipt'))
        or p.prosrc ilike '%inv_incoming%')) then
    raise exception 'WAREHOUSE_CLEANUP_SCAN_TRIGGER_PRESENT: refuse even disabled/partial activation';
  end if;
  if exists(select 1 from public.inv_incoming where receipt_id is not null) then
    raise exception 'WAREHOUSE_CLEANUP_RECEIPT_LINKED_STOCK: review scan/production-linked stock separately';
  end if;
  if exists(select 1 from pg_attribute where attrelid='public.inv_incoming'::regclass and attname='scan_pallet_data_id' and not attisdropped) then
    execute 'select exists(select 1 from public.inv_incoming where scan_pallet_data_id is not null)' into found_rows;
    if found_rows then raise exception 'WAREHOUSE_CLEANUP_SCAN_STOCK_PRESENT'; end if;
  end if;
  if exists(select 1 from pg_attribute where attrelid='public.inv_incoming'::regclass and attname='source_type' and not attisdropped) then
    execute 'select exists(select 1 from public.inv_incoming where source_type=''scan'')' into found_rows;
    if found_rows then raise exception 'WAREHOUSE_CLEANUP_SCAN_STOCK_PRESENT'; end if;
  end if;
  if exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where not t.tgisinternal and c.relnamespace='public'::regnamespace and c.relname=any(names) and (t.tgtype::integer & 32)<>0) then
    raise exception 'WAREHOUSE_CLEANUP_CUSTOM_TRUNCATE_TRIGGER: review side effects first';
  end if;
  select string_agg(c.conrelid::regclass::text||'.'||c.conname,', ') into bad
    from pg_constraint c join pg_class parent on parent.oid=c.confrelid join pg_class child on child.oid=c.conrelid
    where c.contype='f' and parent.relnamespace='public'::regnamespace and parent.relname=any(names)
      and not (child.relnamespace='public'::regnamespace and child.relname=any(names));
  if bad is not null then raise exception 'WAREHOUSE_CLEANUP_EXTERNAL_FK:%',bad; end if;

  foreach entry in array names loop
    execute format('select jsonb_build_object(''rows'',count(*),''md5'',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'''' order by md5(to_jsonb(r)::text)),''''))) from public.%I r',entry) into snapshot;
    actual_manifest:=actual_manifest||jsonb_build_object(entry,snapshot);
  end loop;
  if actual_manifest is distinct from expected_manifest then
    raise exception 'WAREHOUSE_CLEANUP_STALE_PREVIEW: data changed or the manifest is incomplete; run preview and review again';
  end if;

  -- One explicit FK-complete statement; no CASCADE and no ID reuse.
  truncate table only public.inv_delivery_issue_lines,
    only public.inv_delivery_issues,
    only public.inv_delivery_reservations_legacy,
    only public.inv_delivery_commands,
    only public.inv_delivery_requests,
    only public.inv_incoming_proposal_lines,
    only public.inv_incoming_proposals,
    only public.inv_incoming,
    only public.inv_incoming_batches,
    only public.inv_opening_imports,
    only public.inv_stock_summary continue identity restrict;
  foreach entry in array names loop
    execute format('select exists(select 1 from public.%I)',entry) into found_rows;
    if found_rows then raise exception 'WAREHOUSE_CLEANUP_NOT_EMPTY:%',entry; end if;
  end loop;
end $$;
commit;
