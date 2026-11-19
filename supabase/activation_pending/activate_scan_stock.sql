-- HELD: NOT A CLI MIGRATION. Do not move/execute until the user explicitly asks.
-- Change the acknowledgement only for the approved cutover (or isolated tests).
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $$
declare cutover_note text:='__WAITING_FOR_USER_APPROVAL__'; report jsonb;
begin
  if cutover_note='__WAITING_FOR_USER_APPROVAL__' then raise exception 'SCAN_STOCK_ACTIVATION_NOT_AUTHORIZED'; end if;
  -- Never acquire the inventory advisory lock before these DDL locks. Existing
  -- confirms can hold pallet/receipt locks while awaiting an inventory writer.
  lock table public.wh_receipt,public.pallet_data in share row exclusive mode;
  report:=public.scan_stock_preflight();
  if not (report->>'ready_to_activate')::boolean then raise exception 'SCAN_STOCK_PREFLIGHT_FAILED:%',report; end if;
  create trigger scan_stock_receive after update on public.pallet_data
    referencing old table as scan_stock_old new table as scan_stock_new
    for each statement execute function public.scan_stock_receive_transition();
  create constraint trigger scan_stock_receipt_complete after insert on public.wh_receipt
    deferrable initially deferred for each row execute function public.scan_stock_validate_receipt();
  insert into public.inv_scan_stock_activation(id,activated_at,cutover_note,rpc_fingerprints)
    values(1,clock_timestamp(),cutover_note,report->'rpc_fingerprints');
end $$;
commit;
