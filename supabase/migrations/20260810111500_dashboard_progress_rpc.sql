create or replace function public.dashboard_progress(
  p_mode text,
  p_key text,
  p_from date default null,
  p_to date default null
)
returns table (
  mode text,
  key text,
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
  v_mode text := lower(trim(coalesce(p_mode, '')));
  v_key text := trim(coalesce(p_key, ''));
  v_from date := p_from;
  v_to date := p_to;
begin
  if not public.has_permission('dashboard.view') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_mode not in ('wo', 'item') then
    raise exception 'INVALID_MODE';
  end if;

  if v_key = '' then
    raise exception 'KEY_REQUIRED';
  end if;

  if v_from is not null and v_to is not null and v_from > v_to then
    select v_to, v_from into v_from, v_to;
  end if;

  return query
  with filtered as (
    select
      p.pallet_id,
      p.wo,
      p.itemcode,
      coalesce(p.quanorder, 0)::numeric as quanorder,
      coalesce(p.quantity, 0)::bigint as quantity,
      p.status
    from public.pallet_data p
    where p.effect_to is null
      and (
        (v_mode = 'wo' and p.wo = v_key)
        or (v_mode = 'item' and p.itemcode = v_key)
      )
      and (v_from is null or p.working_day >= v_from)
      and (v_to is null or p.working_day <= v_to)
  ),
  order_by_wo as (
    select f.wo, max(f.quanorder)::numeric as wo_order_quantity
    from filtered f
    where nullif(trim(coalesce(f.wo, '')), '') is not null
    group by f.wo
  ),
  totals as (
    select
      count(distinct f.pallet_id)::bigint as pallet_count,
      coalesce(sum(f.quantity), 0)::bigint as produced_quantity,
      coalesce(sum(f.quantity) filter (where lower(coalesce(f.status, '')) <> 'production'), 0)::bigint as scanned_quantity,
      coalesce(sum(f.quantity) filter (where lower(coalesce(f.status, '')) = 'whdone'), 0)::bigint as warehouse_quantity,
      coalesce(max(f.quanorder), 0)::numeric as wo_order_quantity
    from filtered f
  )
  select
    v_mode,
    v_key,
    case
      when v_mode = 'wo' then t.wo_order_quantity
      else coalesce((select sum(o.wo_order_quantity) from order_by_wo o), 0)::numeric
    end as order_quantity,
    t.pallet_count,
    t.produced_quantity,
    t.scanned_quantity,
    t.warehouse_quantity
  from totals t;
end;
$$;

revoke all on function public.dashboard_progress(text, text, date, date) from public;
grant execute on function public.dashboard_progress(text, text, date, date) to authenticated;
grant execute on function public.dashboard_progress(text, text, date, date) to service_role;
