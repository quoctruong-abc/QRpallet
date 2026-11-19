begin;

-- One row is one incoming stock layer, not an item-level aggregate. Manual
-- entries need no legacy receipt; scan integration will be implemented later.
create table if not exists public.inv_incoming (
  id bigint generated always as identity primary key,
  received_date date not null default public.vietnam_working_day(now()),
  production_date date,
  itemcode text not null,
  product_name text not null,
  customer text not null,
  wo text,
  received_qty integer not null,
  issued_qty integer not null default 0,
  balance_qty integer generated always as (received_qty - issued_qty) stored,
  entered_by uuid default auth.uid(),
  entered_by_name text not null,
  created_at timestamptz not null default now(),
  receipt_id text,
  note text not null,
  updated_at timestamptz not null default now(),

  constraint inv_incoming_itemcode_check
    check (length(btrim(itemcode)) between 1 and 200 and position('*' in itemcode) = 0),
  constraint inv_incoming_product_name_check
    check (nullif(btrim(product_name), '') is not null),
  constraint inv_incoming_customer_check
    check (nullif(btrim(customer), '') is not null),
  constraint inv_incoming_wo_check
    check (wo is null or length(btrim(wo)) between 1 and 200),
  constraint inv_incoming_received_qty_check check (received_qty > 0),
  constraint inv_incoming_issued_qty_check check (issued_qty >= 0 and issued_qty <= received_qty),
  constraint inv_incoming_entered_by_name_check
    check (nullif(btrim(entered_by_name), '') is not null),
  constraint inv_incoming_note_check
    check (length(btrim(note)) between 1 and 2000),
  constraint inv_incoming_entered_by_fkey
    foreign key (entered_by) references public.profiles(id) on delete set null,
  constraint inv_incoming_receipt_fkey
    foreign key (receipt_id) references public.wh_receipt(receipt_id) on delete restrict
);

comment on table public.inv_incoming is
  'Warehouse incoming stock layers. Independent from wh_data_pallet; no automatic scan import.';
comment on column public.inv_incoming.received_date is
  'Business receipt date; defaults to the existing Vietnam working day with the 06:00 cutoff.';
comment on column public.inv_incoming.production_date is
  'Optional production date. When unknown, FIFO may use received_date without inventing a production date.';
comment on column public.inv_incoming.received_qty is 'Original received quantity for this stock layer.';
comment on column public.inv_incoming.issued_qty is
  'Issued total for this stock layer. Future outgoing transactions must keep this total consistent with linked issue lines.';
comment on column public.inv_incoming.balance_qty is
  'Read-only generated quantity: received_qty - issued_qty. Cannot be entered or updated directly.';
comment on column public.inv_incoming.entered_by is
  'Profile of the operator who created the row; nullable only to retain history after profile deletion.';
comment on column public.inv_incoming.entered_by_name is
  'Operator name captured at insertion, preserved after profile rename or deletion.';
comment on column public.inv_incoming.created_at is
  'Actual record creation timestamp, distinct from the business receipt date.';
comment on column public.inv_incoming.receipt_id is
  'Optional FK to the existing warehouse receipt. Manual stock entries may leave it NULL.';

-- Do not accept a client-supplied display name as the operator identity. Future
-- server writes must pass the authorized profile ID when using service_role.
create or replace function public.set_inv_incoming_operator()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.entered_by is null then
    raise exception 'INVENTORY_OPERATOR_REQUIRED';
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.username), ''))
    into new.entered_by_name
  from public.profiles p
  where p.id = new.entered_by;

  if not found or new.entered_by_name is null then
    raise exception 'INVENTORY_OPERATOR_NOT_FOUND';
  end if;

  return new;
end;
$$;

drop trigger if exists inv_incoming_set_operator on public.inv_incoming;
create trigger inv_incoming_set_operator
  before insert on public.inv_incoming
  for each row execute function public.set_inv_incoming_operator();

drop trigger if exists inv_incoming_set_updated_at on public.inv_incoming;
create trigger inv_incoming_set_updated_at
  before update on public.inv_incoming
  for each row execute function public.set_updated_at();

create index if not exists inv_incoming_fifo_idx
  on public.inv_incoming (itemcode, (coalesce(production_date, received_date)), received_date, id)
  where balance_qty > 0;
create index if not exists inv_incoming_received_date_idx
  on public.inv_incoming (received_date desc, id desc);
create index if not exists inv_incoming_receipt_idx
  on public.inv_incoming (receipt_id) where receipt_id is not null;
create index if not exists inv_incoming_entered_by_idx
  on public.inv_incoming (entered_by) where entered_by is not null;

alter table public.inv_incoming enable row level security;

drop policy if exists inv_incoming_read on public.inv_incoming;
create policy inv_incoming_read on public.inv_incoming
  for select to authenticated
  using (public.has_permission('receipt.view'));

-- This migration creates storage only. No browser writes or posting RPC are
-- exposed yet; inventory posting and outgoing allocation are separate steps.
revoke all on table public.inv_incoming from public, anon, authenticated;
grant select on table public.inv_incoming to authenticated;
grant select, insert, update, delete on table public.inv_incoming to service_role;
revoke all on sequence public.inv_incoming_id_seq from public, anon, authenticated;
grant usage, select on sequence public.inv_incoming_id_seq to service_role;
revoke all on function public.set_inv_incoming_operator() from public, anon, authenticated;
grant execute on function public.set_inv_incoming_operator() to service_role;

commit;
