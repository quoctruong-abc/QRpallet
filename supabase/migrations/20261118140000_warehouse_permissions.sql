begin;

insert into public.permissions(permission_key,module,description) values
  ('view-WH','warehouse','Xem kho và đề xuất nhập/xuất kho thủ công'),
  ('edit-WH','warehouse','Duyệt, ghi nhận và chỉnh sửa nhập/xuất kho')
on conflict(permission_key) do update set module=excluded.module,description=excluded.description;

alter table public.user_permissions drop constraint if exists user_permissions_permission_key_check;
alter table public.user_permissions add constraint user_permissions_permission_key_check check(permission_key in (
  'planning.upload','planning.change','pallet.create','pallet.edit','scan.standard','receipt.view','dashboard.view','view-WH','edit-WH'
));
-- Keep warehouse grants within the Warehouse admin's department; Super Admin
-- can grant them to any mapped account. Ordinary users cannot grant themselves.
drop policy if exists user_permissions_manage_scope on public.user_permissions;
create policy user_permissions_manage_scope on public.user_permissions to authenticated
using (
  public.current_profile_role()='superadmin' or (
    public.current_profile_role()='admin' and permission_key<>'dashboard.view'
    and (permission_key not in ('view-WH','edit-WH') or public.current_profile_position()='warehouse')
    and exists(select 1 from public.profiles p where p.id=user_permissions.user_id and p.role='user' and p.position=public.current_profile_position())
  )
)
with check (
  public.current_profile_role()='superadmin' or (
    public.current_profile_role()='admin' and permission_key<>'dashboard.view'
    and (permission_key not in ('view-WH','edit-WH') or public.current_profile_position()='warehouse')
    and exists(select 1 from public.profiles p where p.id=user_permissions.user_id and p.role='user' and p.position=public.current_profile_position())
  )
);
-- No legacy receipt grant implies warehouse editing. Superadmin retains the
-- existing global bypass; all other accounts receive the new grants explicitly.
create function public.warehouse_access(p_edit boolean default false)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and public.has_permission('view-WH')
    and (not p_edit or public.has_permission('edit-WH'))
    and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active);
$$;
revoke all on function public.warehouse_access(boolean) from public,anon,authenticated,service_role;
grant execute on function public.warehouse_access(boolean) to authenticated;

-- Change authorization only, including private delegation layers. Keep the
-- tested posting/FIFO/recipe/idempotency bodies and existing RPC privileges.
do $$
declare entry record; signature regprocedure; source text; replacement text;
begin
  for entry in select * from (values
    ('lookup_manual_delivery_item(text)','view'),
    ('lookup_delivery_build_up(text)','view'),
    ('list_delivery(integer,text,boolean)','view'),
    ('list_stock_summary(integer,text,boolean)','view'),
    ('list_stock_production_dates(text)','view'),
    ('preview_delivery_fifo(uuid,integer)','view'),
    ('review_delivery_fifo(uuid[])','view'),
    ('delivery_request_details(uuid)','view'),
    -- Manual delivery creates a shared proposal, not a stock issue.
    ('post_manual_delivery(uuid,jsonb)','view'),
    ('post_manual_delivery_before_active(uuid,jsonb)','view'),
    ('post_manual_delivery_catalog_v1(uuid,jsonb)','view'),
    ('post_manual_inventory(uuid,jsonb)','edit'),
    ('post_bulk_delivery(uuid,jsonb)','edit'),
    ('post_bulk_delivery_components_v1(uuid,jsonb)','edit'),
    ('manage_delivery(text,uuid,jsonb)','action'),
    ('manage_delivery_before_active(text,uuid,jsonb)','action'),
    ('manage_delivery_components_v1(text,uuid,jsonb)','action')
  ) x(signature,mode) loop
    signature:=to_regprocedure('public.'||entry.signature);
    if signature is null then raise exception 'WH_PERMISSION_MISSING_RPC:%',entry.signature; end if;
    source:=pg_get_functiondef(signature);
    replacement:=case entry.mode when 'view' then 'public.warehouse_access(false)'
      when 'edit' then 'public.warehouse_access(true)'
      else 'public.warehouse_access(p_action is distinct from ''preview'')' end;
    if position('public.has_permission(''receipt.view'')' in source)=0 then
      raise exception 'WH_PERMISSION_UNEXPECTED_RPC:%',entry.signature;
    end if;
    execute replace(source,'public.has_permission(''receipt.view'')',replacement);
  end loop;

  signature:='public.warehouse_catalog_manage(text,jsonb)'::regprocedure;
  source:=pg_get_functiondef(signature);
  replacement:='not exists(select 1 from public.profiles p where p.id=actor and p.is_active and p.role=''superadmin'')';
  if position(replacement in source)=0 then raise exception 'WH_PERMISSION_UNEXPECTED_CATALOG'; end if;
  execute replace(source,replacement,'not public.warehouse_access(true)');
end $$;

alter policy inv_incoming_read on public.inv_incoming using(public.warehouse_access(false));
alter policy inv_incoming_batches_read on public.inv_incoming_batches using(public.warehouse_access(false));
alter policy stock_summary_read on public.inv_stock_summary using(public.warehouse_access(false));
alter policy delivery_read on public.inv_delivery_requests using(public.warehouse_access(false));
alter policy delivery_read on public.inv_delivery_reservations_legacy using(public.warehouse_access(false));
alter policy delivery_read on public.inv_delivery_issues using(public.warehouse_access(false));
alter policy delivery_read on public.inv_delivery_issue_lines using(public.warehouse_access(false));

notify pgrst,'reload schema';
commit;
