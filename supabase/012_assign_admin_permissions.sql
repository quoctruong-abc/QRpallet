begin;

-- Admin permissions are no longer derived automatically from position.
-- Preserve the current access of existing admins by seeding their position's
-- current permission set into user_permissions. Superadmin can then add/remove
-- individual permissions from the Admin dashboard.

with permission_seed(position, permission_key) as (
  values
    ('planning'::text, 'planning.upload'::text),
    ('planning'::text, 'planning.change'::text),
    ('production'::text, 'pallet.create'::text),
    ('production'::text, 'pallet.edit'::text),
    ('warehouse'::text, 'scan.standard'::text),
    ('warehouse'::text, 'receipt.view'::text)
),
first_superadmin as (
  select id
  from public.profiles
  where role = 'superadmin'
  order by created_at
  limit 1
)
insert into public.user_permissions (user_id, permission_key, granted_by)
select
  admin_profile.id,
  seed.permission_key,
  coalesce((select id from first_superadmin), admin_profile.id)
from public.profiles admin_profile
join permission_seed seed
  on seed.position = admin_profile.position::text
join public.permissions permission
  on permission.permission_key = seed.permission_key
where admin_profile.role = 'admin'
  and admin_profile.is_active = true
on conflict (user_id, permission_key) do nothing;

commit;
