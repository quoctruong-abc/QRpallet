-- Read-only; run as the database owner in SQL Editor after preparation.
-- This does NOT activate, backfill, confirm or post any stock.
begin read only;
select public.scan_stock_preflight();
select t.tgname,pg_get_triggerdef(t.oid) as definition
from pg_trigger t where t.tgrelid in('public.pallet_data'::regclass,'public.wh_receipt'::regclass)
  and not t.tgisinternal order by t.tgrelid::regclass::text,t.tgname;
commit;
