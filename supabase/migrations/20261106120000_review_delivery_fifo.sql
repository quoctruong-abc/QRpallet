begin;

create function public.review_delivery_fifo(p_request_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_permission('receipt.view')
    or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'DELIVERY_NOT_AUTHORIZED';
  end if;
  if coalesce(cardinality(p_request_ids),0) not between 1 and 50000 then
    raise exception 'DELIVERY_INVALID_REVIEW';
  end if;

  with pending as (
    select d.itemcode,d.ordered_qty-d.shipped_qty as remaining_qty,
      nullif(btrim(d.product_name),'') as product_name,
      nullif(btrim(d.system_customer_name),'') as system_customer,
      nullif(btrim(d.customer),'') as erp_customer
    from public.inv_delivery_requests d
    where d.id=any(p_request_ids) and not d.cancelled and d.shipped_qty<d.ordered_qty
  ), demand as materialized (
    select itemcode,sum(remaining_qty) as quantity,count(*) as request_count,
      max(product_name) as product_name,
      coalesce(string_agg(distinct system_customer,' / ' order by system_customer),
        string_agg(distinct erp_customer,' / ' order by erp_customer)) as customer
    from pending group by itemcode
  ), stock_days as (
    -- FIFO sorts by production date (unknown first), then by receipt and lot.
    -- Within the same production date, only the aggregate quantity is shown.
    select i.itemcode,i.production_date,sum(i.balance_qty) as balance
    from demand d join public.inv_incoming i using(itemcode)
    where i.balance_qty>0 group by i.itemcode,i.production_date
  ), ordered as (
    select *,coalesce(sum(balance) over(partition by itemcode order by production_date nulls first
      rows between unbounded preceding and 1 preceding),0) as previous
    from stock_days
  ), assigned as (
    select s.itemcode,s.production_date,least(s.balance,d.quantity-s.previous) as quantity
    from ordered s join demand d using(itemcode) where s.previous<d.quantity
  ), fifo as (
    select itemcode,sum(quantity) as quantity,
      jsonb_agg(jsonb_build_object('production_date',production_date,'quantity',quantity)
        order by production_date nulls first) as days
    from assigned group by itemcode
  )
  select jsonb_build_object(
    'request_count',coalesce(sum(d.request_count),0),
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'itemcode',d.itemcode,
      'product_name',coalesce(nullif(btrim(s.product_name),''),d.product_name,''),
      'customer',d.customer,
      'quantity',d.quantity,
      'shortage_qty',d.quantity-coalesce(f.quantity,0),
      'days',coalesce(f.days,'[]')
    ) order by d.itemcode),'[]')
  ) into result
  from demand d left join fifo f using(itemcode) left join public.inv_stock_summary s using(itemcode);
  return result;
end $$;

revoke all on function public.review_delivery_fifo(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.review_delivery_fifo(uuid[]) to authenticated;

notify pgrst,'reload schema';
commit;
