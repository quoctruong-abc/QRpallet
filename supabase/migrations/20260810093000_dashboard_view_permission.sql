-- Make the production dashboard a grantable module.
-- Final rule:
--   * superadmin: always allowed
--   * admin: always allowed
--   * user: allowed only with explicit dashboard.view granted by Super Admin

insert into public.permissions (permission_key, module, description)
values ('dashboard.view', 'dashboard', 'View production dashboard')
on conflict (permission_key) do update
set module = excluded.module,
    description = excluded.description;

alter table public.user_permissions
  drop constraint if exists user_permissions_permission_key_check;

alter table public.user_permissions
  add constraint user_permissions_permission_key_check
  check (
    permission_key = any (
      array[
        'planning.upload'::text,
        'planning.change'::text,
        'pallet.create'::text,
        'pallet.edit'::text,
        'scan.standard'::text,
        'receipt.view'::text,
        'dashboard.view'::text
      ]
    )
  );

-- Admins may still manage user permissions inside their own position, but the
-- Dashboard permission is reserved for Super Admin at the database layer too.
drop policy if exists user_permissions_manage_scope on public.user_permissions;

create policy user_permissions_manage_scope on public.user_permissions
  to authenticated
  using (
    public.current_profile_role() = 'superadmin'
    or (
      public.current_profile_role() = 'admin'
      and permission_key <> 'dashboard.view'
      and exists (
        select 1
        from public.profiles target
        where target.id = user_permissions.user_id
          and target.role = 'user'
          and target.position = public.current_profile_position()
      )
    )
  )
  with check (
    public.current_profile_role() = 'superadmin'
    or (
      public.current_profile_role() = 'admin'
      and permission_key <> 'dashboard.view'
      and exists (
        select 1
        from public.profiles target
        where target.id = user_permissions.user_id
          and target.role = 'user'
          and target.position = public.current_profile_position()
      )
    )
  );

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((
    select case
      when p.role = 'superadmin' then true
      when p.role = 'admin' then
        p_permission = 'dashboard.view'
        or (p.position = 'planning' and p_permission in ('planning.upload', 'planning.change', 'receipt.view'))
        or (p.position = 'production' and p_permission in ('pallet.create', 'pallet.edit', 'receipt.view'))
        or (p.position = 'warehouse' and p_permission in ('scan.standard', 'receipt.view'))
        or exists (
          select 1
          from public.user_permissions up
          where up.user_id = p.id
            and up.permission_key = p_permission
        )
      else exists (
        select 1
        from public.user_permissions up
        where up.user_id = p.id
          and up.permission_key = p_permission
      )
    end
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active = true
  ), false)
$function$;

revoke all on function public.has_permission(text) from public;
grant execute on function public.has_permission(text) to anon;
grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.has_permission(text) to service_role;
