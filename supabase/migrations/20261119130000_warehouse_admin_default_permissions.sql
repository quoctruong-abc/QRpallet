begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Role defaults apply to existing/future Warehouse admins without inserting
-- user_permissions rows. Existing department-scoped grant RLS is retained.
create or replace function public.has_permission(p_permission text)
returns boolean language sql stable security definer set search_path to 'public' as $function$
  select coalesce((
    select case
      when p.role='superadmin' then true
      when p.role='admin' then
        p_permission='dashboard.view'
        or (p.position='planning' and p_permission in ('planning.upload','planning.change','receipt.view'))
        or (p.position='production' and p_permission in ('pallet.create','pallet.edit','receipt.view'))
        or (p.position='warehouse' and p_permission in ('scan.standard','receipt.view','view-WH','edit-WH'))
        or exists(select 1 from public.user_permissions up where up.user_id=p.id and up.permission_key=p_permission)
      else exists(select 1 from public.user_permissions up where up.user_id=p.id and up.permission_key=p_permission)
    end
    from public.profiles p where p.id=auth.uid() and p.is_active=true
  ),false)
$function$;

notify pgrst,'reload schema';
commit;
