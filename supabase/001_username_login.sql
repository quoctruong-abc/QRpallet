-- Run this immediately after supabase/000_clean_install_full_schema.sql.
-- Users log in with username; Supabase Auth keeps an internal email username@qrpallet.local.

begin;

alter table public.profiles
  add column if not exists username text;

update public.profiles p
set username = lower(
  coalesce(
    nullif((select u.raw_user_meta_data ->> 'username' from auth.users u where u.id = p.id), ''),
    split_part(p.email, '@', 1)
  )
)
where p.username is null or btrim(p.username) = '';

alter table public.profiles
  alter column username set not null;

alter table public.profiles
  drop constraint if exists profiles_username_format_check;

alter table public.profiles
  add constraint profiles_username_format_check
  check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

create unique index if not exists profiles_username_lower_uidx
  on public.profiles (lower(username));

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  v_username := lower(coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    split_part(coalesce(new.email, new.id::text || '@qrpallet.local'), '@', 1)
  ));

  insert into public.profiles (
    id,username,email,full_name,employee_code,role,position,is_active
  ) values (
    new.id,
    v_username,
    coalesce(new.email, v_username || '@qrpallet.local'),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name',''),
      v_username
    ),
    nullif(new.raw_user_meta_data ->> 'employee_code',''),
    'user',
    'warehouse',
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

commit;

-- Example first superadmin after creating the Auth user through the application:
-- update public.profiles
-- set role = 'superadmin', position = null, is_active = true
-- where username = 'admin';
