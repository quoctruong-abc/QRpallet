-- SVN authentication + authorization schema
-- Run this entire file in Supabase Dashboard > SQL Editor.

begin;

-- 1) Application enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'user');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_position') THEN
    CREATE TYPE public.app_position AS ENUM ('planning', 'pallet', 'scanner', 'warehouse');
  END IF;
END
$$;

-- 2) Public profile linked one-to-one with auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL DEFAULT 'New user',
  employee_code text UNIQUE,
  role public.app_role NOT NULL DEFAULT 'user',
  position public.app_position,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_position_by_role CHECK (
    (role = 'admin' AND position IS NULL)
    OR
    (role = 'user' AND position IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles(role);
CREATE INDEX IF NOT EXISTS profiles_position_idx ON public.profiles(position);
CREATE INDEX IF NOT EXISTS profiles_active_idx ON public.profiles(is_active);

-- 3) Automatically create a safe default profile for every Auth user.
-- Role/position are NOT taken from user metadata, preventing self-promotion.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    employee_code,
    role,
    position,
    is_active
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.id::text || '@no-email.local'),
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), split_part(COALESCE(NEW.email, 'New user'), '@', 1)),
    NULLIF(NEW.raw_user_meta_data ->> 'employee_code', ''),
    'user',
    'scanner',
    true
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill profiles for Auth users created before this SQL was run.
INSERT INTO public.profiles (id, email, full_name, employee_code, role, position, is_active)
SELECT
  u.id,
  COALESCE(u.email, u.id::text || '@no-email.local'),
  COALESCE(NULLIF(u.raw_user_meta_data ->> 'full_name', ''), split_part(COALESCE(u.email, 'New user'), '@', 1)),
  NULLIF(u.raw_user_meta_data ->> 'employee_code', ''),
  'user',
  'scanner',
  true
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- 4) Maintain updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5) Helper used by RLS without recursive profile-policy evaluation.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'admin'
      AND p.is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- 6) Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_self_or_admin" ON public.profiles;
CREATE POLICY "profiles_select_self_or_admin"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = (SELECT auth.uid())
  OR public.is_admin()
);

DROP POLICY IF EXISTS "profiles_admin_update" ON public.profiles;
CREATE POLICY "profiles_admin_update"
ON public.profiles
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

REVOKE ALL ON TABLE public.profiles FROM anon;
GRANT SELECT, UPDATE ON TABLE public.profiles TO authenticated;

commit;

-- AFTER RUNNING THIS FILE:
-- 1. Create the first user in Supabase Dashboard > Authentication > Users.
-- 2. Promote that user with the SQL below, replacing the email:
--
-- UPDATE public.profiles
-- SET role = 'admin', position = NULL, is_active = true
-- WHERE email = 'admin@your-company.com';
