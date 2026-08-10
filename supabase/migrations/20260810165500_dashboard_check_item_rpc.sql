begin;

create or replace function public.dashboard_check_item(
  p_itemcode text
)
returns table (
  itemcode text,
  product_name text,
  customer text,
  first_working_day date,
  last_working_day date,
  wo text,
  order_quantity numeric,
  pallet_count bigint,
  produced_quantity bigint,
  scanned_quantity bigint,
  warehouse_quantity bigint,
  warning boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_itemcode text := trim(coalesce(p_itemcode, ''));
begin
  if not public.has_permission('dashboard.view') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_itemcode = '' or length(v_itemcode) > 128 then
    raise exception 'INVALID_ITEMCODE';
  end if;

  return query
  with active as (
    select
      p.pallet_id,
      p.itemcode,
      p.product_name,
      p.customer,
      p.wo,
      p.working_day,
      coalesce(p.quanorder, 0)::numeric as quanorder,
      coalesce(p.quantity, 0)::bigint as quantity,
      lower(coalesce(p.status, '')) as status,
      coalesce(p.has_been_edited, false) as has_been_edited,
      coalesce(p.has_been_return, false) as has_been_return,
      false as is_deleted
    from public.pallet_data p
    where p.effect_to is null
      and p.itemcode = v_itemcode
  ),
  deleted_terminal as (
    select
      p.pallet_id,
      p.itemcode,
      p.product_name,
      p.customer,
      p.wo,
      p.working_day,
      coalesce(p.quanorder, 0)::numeric as quanorder,
      0::bigint as quantity,
      lower(coalesce(p.status, '')) as status,
      coalesce(p.has_been_edited, false) as has_been_edited,
      coalesce(p.has_been_return, false) as has_been_return,
      true as is_deleted
    from public.pallet_data p
    where p.effect_to is not null
      and p.note ilike 'delete:%'
      and p.itemcode = v_itemcode
  ),
  item_rows as (
    select * from active
    union all
    select * from deleted_terminal
  ),
  product_names as (
    select distinct trim(r.product_name) as value
    from item_rows r
    where nullif(trim(coalesce(r.product_name, '')), '') is not null
  ),
  customers as (
    select distinct trim(r.customer) as value
    from item_rows r
    where nullif(trim(coalesce(r.customer, '')), '') is not null
  ),
  item_meta as (
    select
      coalesce((select string_agg(pn.value, ' / ' order by pn.value) from product_names pn), '—') as product_name,
      coalesce((select string_agg(c.value, ' / ' order by c.value) from customers c), '—') as customer,
      min(r.working_day) as first_working_day,
      max(r.working_day) as last_working_day
    from item_rows r
  ),
  wo_keys as (
    select distinct trim(r.wo) as wo
    from item_rows r
    where nullif(trim(coalesce(r.wo, '')), '') is not null
  ),
  order_by_wo as (
    select trim(r.wo) as wo, max(r.quanorder)::numeric as order_quantity
    from item_rows r
    where nullif(trim(coalesce(r.wo, '')), '') is not null
    group by trim(r.wo)
  ),
  active_totals as (
    select
      trim(a.wo) as wo,
      count(distinct a.pallet_id)::bigint as pallet_count,
      coalesce(sum(a.quantity), 0)::bigint as produced_quantity,
      coalesce(sum(a.quantity) filter (where a.status <> 'production'), 0)::bigint as scanned_quantity,
      coalesce(sum(a.quantity) filter (where a.status = 'whdone'), 0)::bigint as warehouse_quantity
    from active a
    where nullif(trim(coalesce(a.wo, '')), '') is not null
    group by trim(a.wo)
  ),
  warning_by_wo as (
    select
      trim(r.wo) as wo,
      bool_or(r.has_been_edited or r.has_been_return or r.is_deleted) as warning
    from item_rows r
    where nullif(trim(coalesce(r.wo, '')), '') is not null
    group by trim(r.wo)
  )
  select
    v_itemcode as itemcode,
    m.product_name,
    m.customer,
    m.first_working_day,
    m.last_working_day,
    k.wo,
    coalesce(o.order_quantity, 0)::numeric as order_quantity,
    coalesce(t.pallet_count, 0)::bigint as pallet_count,
    coalesce(t.produced_quantity, 0)::bigint as produced_quantity,
    coalesce(t.scanned_quantity, 0)::bigint as scanned_quantity,
    coalesce(t.warehouse_quantity, 0)::bigint as warehouse_quantity,
    coalesce(w.warning, false) as warning
  from wo_keys k
  cross join item_meta m
  left join order_by_wo o on o.wo = k.wo
  left join active_totals t on t.wo = k.wo
  left join warning_by_wo w on w.wo = k.wo
  order by k.wo;
end;
$$;

revoke all on function public.dashboard_check_item(text) from public;
revoke all on function public.dashboard_check_item(text) from anon;
grant execute on function public.dashboard_check_item(text) to authenticated;
grant execute on function public.dashboard_check_item(text) to service_role;

commit;
