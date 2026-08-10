begin;

-- Aggregate the five top-level dashboard summary metrics inside PostgreSQL.
-- The table itself is paged by seven-day windows, while these values always
-- represent the complete user-selected date range.
--
-- Deleted pallets:
--   * do not count toward pallet/produced/scanned/warehouse KPIs;
--   * still contribute their WO quanorder candidate so an order does not vanish
--     from planning context merely because its only pallet was later deleted.

create or replace function public.dashboard_summary(
  p_from date,
  p_to date
)
returns table (
  order_quantity numeric,
  pallet_count bigint,
  produced_quantity bigint,
  scanned_quantity bigint,
  warehouse_quantity bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from date := p_from;
  v_to date := p_to;
begin
  if not public.has_permission('dashboard.view') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_from is null or v_to is null then
    raise exception 'DATE_RANGE_REQUIRED';
  end if;

  if v_from > v_to then
    select v_to, v_from into v_from, v_to;
  end if;

  return query
  with active as (
    select
      p.pallet_id,
      p.wo,
      coalesce(p.quanorder, 0)::numeric as quanorder,
      coalesce(p.quantity, 0)::bigint as quantity,
      lower(coalesce(p.status, '')) as status
    from public.pallet_data p
    where p.effect_to is null
      and p.working_day >= v_from
      and p.working_day <= v_to
  ),
  deleted_terminal as (
    select
      p.wo,
      coalesce(p.quanorder, 0)::numeric as quanorder
    from public.pallet_data p
    where p.effect_to is not null
      and p.note ilike 'delete:%'
      and p.working_day >= v_from
      and p.working_day <= v_to
  ),
  order_candidates as (
    select a.wo, a.quanorder from active a
    union all
    select d.wo, d.quanorder from deleted_terminal d
  ),
  order_by_wo as (
    select
      c.wo,
      max(c.quanorder)::numeric as wo_order_quantity
    from order_candidates c
    where nullif(trim(coalesce(c.wo, '')), '') is not null
    group by c.wo
  ),
  active_totals as (
    select
      count(distinct a.pallet_id)::bigint as pallet_count,
      coalesce(sum(a.quantity), 0)::bigint as produced_quantity,
      coalesce(sum(a.quantity) filter (where a.status <> 'production'), 0)::bigint as scanned_quantity,
      coalesce(sum(a.quantity) filter (where a.status = 'whdone'), 0)::bigint as warehouse_quantity
    from active a
  )
  select
    coalesce((select sum(o.wo_order_quantity) from order_by_wo o), 0)::numeric as order_quantity,
    t.pallet_count,
    t.produced_quantity,
    t.scanned_quantity,
    t.warehouse_quantity
  from active_totals t;
end;
$$;

revoke all on function public.dashboard_summary(date, date) from public;
revoke all on function public.dashboard_summary(date, date) from anon;
grant execute on function public.dashboard_summary(date, date) to authenticated;
grant execute on function public.dashboard_summary(date, date) to service_role;

commit;
