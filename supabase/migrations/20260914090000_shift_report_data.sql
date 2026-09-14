begin;

create table if not exists public.shift_report_data (
  id_report text primary key,
  report_date date not null,
  machine text not null,
  itemcode text not null,
  wo text not null,
  ok_goods numeric not null check (ok_goods >= 0),
  constraint shift_report_data_date_machine_wo_key unique (report_date, machine, wo)
);

create index if not exists shift_report_data_report_date_idx
  on public.shift_report_data (report_date);

create index if not exists shift_report_data_itemcode_idx
  on public.shift_report_data (itemcode);

create index if not exists shift_report_data_wo_idx
  on public.shift_report_data (wo);

alter table public.shift_report_data enable row level security;

drop policy if exists shift_report_data_dashboard_read on public.shift_report_data;
create policy shift_report_data_dashboard_read on public.shift_report_data
  for select
  to authenticated
  using (public.has_permission('dashboard.view'));

revoke all on table public.shift_report_data from public, anon, authenticated;
grant select on table public.shift_report_data to authenticated;
grant select, insert, update, delete on table public.shift_report_data to service_role;

commit;
