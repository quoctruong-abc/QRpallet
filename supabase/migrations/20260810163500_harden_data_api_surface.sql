begin;

-- Harden the Supabase Data API surface.
--
-- Design goals:
--   * unauthenticated requests must not reach objects in public;
--   * authenticated users may read only through existing RLS policies and may
--     not perform direct table DML;
--   * authenticated users may execute only the explicitly approved helper/RPC
--     functions below;
--   * future tables/functions/sequences are private by default and require an
--     explicit GRANT in the same migration that creates them.

-- ---------------------------------------------------------------------------
-- 1. Future objects: opt-in exposure only.
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Existing unauthenticated surface: close public completely.
-- Supabase Auth itself lives outside the public schema and is unaffected.
-- ---------------------------------------------------------------------------

revoke usage on schema public from anon;
revoke create on schema public from public, anon, authenticated;

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

-- ---------------------------------------------------------------------------
-- 3. Existing authenticated table surface: read-only through RLS.
-- All business writes are performed by SECURITY DEFINER RPCs or server-side
-- service-role actions, so direct INSERT/UPDATE/DELETE is unnecessary.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on all tables in schema public from authenticated;
revoke usage, select on all sequences in schema public from authenticated;

-- These two audit/receipt tables are server-only in the current application.
-- Dashboard/receipt APIs authorize first and then query them with service-role.
revoke select on table public.pallet_change_history from authenticated;
revoke select on table public.wh_receipt from authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tighten pallet_data SELECT for direct authenticated Data API access.
--
-- Production permissions still need broad read access for pallet operations.
-- Dashboard viewers intentionally need broad read access for reporting/audit.
-- Normal scan users only need to see their own active pendingWH rows; scanning
-- production pallets itself is done through the protected RPC.
-- receipt.view uses server-side APIs and therefore does not need direct access.
-- ---------------------------------------------------------------------------

drop policy if exists pallet_data_select_authorized on public.pallet_data;

create policy pallet_data_select_authorized on public.pallet_data
  for select
  to authenticated
  using (
    public.has_permission('pallet.create')
    or public.has_permission('pallet.edit')
    or public.has_permission('dashboard.view')
    or (
      public.has_permission('scan.standard')
      and lower(coalesce(status, '')) = 'pendingwh'
      and scanned_by = auth.uid()
    )
  );

-- The return-history table is no longer directly exposed to authenticated
-- clients. Keep RLS enabled, but remove the former USING(true) read policy.
drop policy if exists pallet_change_history_read on public.pallet_change_history;

-- wh_receipt is also server-only. Remove the obsolete receipt.create/edit
-- policy so future permission changes cannot accidentally reopen it.
drop policy if exists wh_receipt_select_authorized on public.wh_receipt;

-- ---------------------------------------------------------------------------
-- 5. Existing functions: deny-by-default, then regrant the exact whitelist.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from authenticated;

-- RLS/auth helpers required by authenticated SELECT policies.
grant execute on function public.current_profile_position() to authenticated, service_role;
grant execute on function public.current_profile_role() to authenticated, service_role;
grant execute on function public.has_permission(text) to authenticated, service_role;

-- Supported business RPCs.
grant execute on function public.replace_planning_inject(jsonb, text) to authenticated, service_role;
grant execute on function public.create_pallet_record(text, text, text, text, numeric, text, integer, text) to authenticated, service_role;
grant execute on function public.edit_pallet_quantity_tracked(text, integer, text) to authenticated, service_role;
grant execute on function public.delete_pallet_record_tracked(text, text) to authenticated, service_role;
grant execute on function public.scan_pallet_to_pending(text) to authenticated, service_role;
grant execute on function public.cancel_pending_pallet(text) to authenticated, service_role;
grant execute on function public.create_warehouse_receipt_from_scan(text[]) to authenticated, service_role;
grant execute on function public.dashboard_progress(text, text, date, date) to authenticated, service_role;
grant execute on function public.dashboard_summary(date, date) to authenticated, service_role;

commit;
