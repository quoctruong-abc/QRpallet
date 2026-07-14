begin;

alter table public.wh_receipt
  add column if not exists status text not null default 'active',
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id);

alter table public.wh_receipt drop constraint if exists wh_receipt_status_check;
alter table public.wh_receipt
  add constraint wh_receipt_status_check check (status in ('active', 'cancelled'));

create index if not exists wh_receipt_status_date_idx
  on public.wh_receipt(status, receipt_date desc);

create or replace function public.cancel_warehouse_receipt(p_receipt_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_count integer;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_active = true and position = 'warehouse'
  ) then raise exception 'Not authorized'; end if;

  perform pg_advisory_xact_lock(hashtext('WH_RECEIPT_CANCEL_' || trim(p_receipt_id)));

  select status into v_status
  from public.wh_receipt
  where receipt_id = trim(p_receipt_id)
  for update;

  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if v_status = 'cancelled' then raise exception 'RECEIPT_ALREADY_CANCELLED'; end if;

  update public.pallet_data
  set status = 'production', wh_receipt = null
  where wh_receipt = trim(p_receipt_id)
    and effect_to is null
    and status = 'WHdone';
  get diagnostics v_count = row_count;

  update public.wh_receipt
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where receipt_id = trim(p_receipt_id);

  return v_count;
end;
$$;

grant execute on function public.cancel_warehouse_receipt(text) to authenticated;

commit;
