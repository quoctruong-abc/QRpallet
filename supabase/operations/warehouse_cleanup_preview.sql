-- READ ONLY. Run as database owner in Supabase SQL Editor, before activation.
-- Schema/code review cannot identify which business rows are test data.
-- Review all 11 tables and export a backup before considering the reset script.
begin isolation level repeatable read read only;
set local statement_timeout='30s';
set local timezone='UTC';
set local datestyle='ISO, YMD';

do $$
declare names text[]:=array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary']; missing text[];
begin
  select array_agg(n) into missing from unnest(names) n where to_regclass('public.'||n) is null;
  if missing is not null then raise exception 'WAREHOUSE_CLEANUP_SCHEMA_MISSING:%',missing; end if;
end $$;

select current_database() as database_name,current_user as database_role,transaction_timestamp() as reviewed_at,
  'RESET ALL 11 warehouse ledger tables only; this is NOT automatic test-row detection' as scope;
select 'inv_delivery_issue_lines'::text as table_name,count(*)::bigint as row_count from public.inv_delivery_issue_lines
union all
select 'inv_delivery_issues'::text as table_name,count(*)::bigint as row_count from public.inv_delivery_issues
union all
select 'inv_delivery_reservations_legacy'::text as table_name,count(*)::bigint as row_count from public.inv_delivery_reservations_legacy
union all
select 'inv_delivery_commands'::text as table_name,count(*)::bigint as row_count from public.inv_delivery_commands
union all
select 'inv_delivery_requests'::text as table_name,count(*)::bigint as row_count from public.inv_delivery_requests
union all
select 'inv_incoming_proposal_lines'::text as table_name,count(*)::bigint as row_count from public.inv_incoming_proposal_lines
union all
select 'inv_incoming_proposals'::text as table_name,count(*)::bigint as row_count from public.inv_incoming_proposals
union all
select 'inv_incoming'::text as table_name,count(*)::bigint as row_count from public.inv_incoming
union all
select 'inv_incoming_batches'::text as table_name,count(*)::bigint as row_count from public.inv_incoming_batches
union all
select 'inv_opening_imports'::text as table_name,count(*)::bigint as row_count from public.inv_opening_imports
union all
select 'inv_stock_summary'::text as table_name,count(*)::bigint as row_count from public.inv_stock_summary
order by table_name;

-- Copy this complete JSON into expected_manifest in the separate reset script.
-- The fingerprint catches changes even when the row count stays the same.
with snapshots as (
select 'inv_delivery_issue_lines'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_delivery_issue_lines r
union all
select 'inv_delivery_issues'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_delivery_issues r
union all
select 'inv_delivery_reservations_legacy'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_delivery_reservations_legacy r
union all
select 'inv_delivery_commands'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_delivery_commands r
union all
select 'inv_delivery_requests'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_delivery_requests r
union all
select 'inv_incoming_proposal_lines'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_incoming_proposal_lines r
union all
select 'inv_incoming_proposals'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_incoming_proposals r
union all
select 'inv_incoming'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_incoming r
union all
select 'inv_incoming_batches'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_incoming_batches r
union all
select 'inv_opening_imports'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_opening_imports r
union all
select 'inv_stock_summary'::text as table_name,jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by md5(to_jsonb(r)::text)),''))) as snapshot from public.inv_stock_summary r
)
select jsonb_object_agg(table_name,snapshot order by table_name) as expected_manifest from snapshots;

-- Any foreign key FROM a table outside the reset set INTO the reset set blocks reset.
select c.conrelid::regclass as child_table,c.confrelid::regclass as parent_table,c.conname,
  pg_get_constraintdef(c.oid) as definition,
  not (child.relname=any(array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary']) and child_ns.nspname='public') as external_child_blocks_reset
from pg_constraint c
join pg_class parent on parent.oid=c.confrelid join pg_namespace parent_ns on parent_ns.oid=parent.relnamespace
join pg_class child on child.oid=c.conrelid join pg_namespace child_ns on child_ns.oid=child.relnamespace
where c.contype='f' and parent_ns.nspname='public' and parent.relname=any(array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary'])
order by c.conrelid::regclass::text,c.conname;

-- Includes unexpected legacy/new tables. inv_scan_stock_activation must be kept.
select c.relname as table_name,case when c.relname=any(array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary']) then 'RESET'
  when c.relname='inv_scan_stock_activation' then 'KEEP: activation audit'
  else 'UNKNOWN: blocks reset; review schema first' end as action
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and left(c.relname,4)='inv_' and c.relkind in('r','p')
order by c.relname;

select c.relname as table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal and n.nspname='public' and (
  (c.relname=any(array['inv_delivery_issue_lines','inv_delivery_issues','inv_delivery_reservations_legacy','inv_delivery_commands','inv_delivery_requests','inv_incoming_proposal_lines','inv_incoming_proposals','inv_incoming','inv_incoming_batches','inv_opening_imports','inv_stock_summary']) and (t.tgtype::integer & 32)<>0)
  or c.relname in('pallet_data','wh_receipt')
)
order by c.relname,t.tgname;
-- If preparation is installed, also run scan_stock_preflight.sql for activation audit/status.
commit;
