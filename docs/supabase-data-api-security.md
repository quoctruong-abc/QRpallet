# Supabase Data API security baseline

Baseline áp dụng sau migration `20260810163500_harden_data_api_surface.sql`.

## Mục tiêu

- `anon` không có quyền sử dụng schema `public`.
- `authenticated` không có quyền direct `INSERT/UPDATE/DELETE` trên public tables.
- Business writes chỉ đi qua RPC đã whitelist hoặc server-side service-role action.
- `authenticated` chỉ được `EXECUTE` các helper/RPC đã whitelist.
- Future tables/functions/sequences mặc định không expose ra Data API; migration tạo object mới phải `GRANT` rõ ràng.
- RLS vẫn là lớp authorization thứ hai cho các bảng còn cho phép `SELECT` trực tiếp.

## Authenticated function whitelist

RLS helpers:

```text
current_profile_position()
current_profile_role()
has_permission(text)
```

Business RPCs:

```text
replace_planning_inject(jsonb,text)
create_pallet_record(text,text,text,text,numeric,text,integer,text)
edit_pallet_quantity_tracked(text,integer,text)
delete_pallet_record_tracked(text,text)
scan_pallet_to_pending(text)
cancel_pending_pallet(text)
create_warehouse_receipt_from_scan(text[])
dashboard_progress(text,text,date,date)
dashboard_summary(date,date)
dashboard_check_item(text)
```

Trigger/event-trigger helpers such as `set_updated_at`, `set_pallet_working_day`, `set_wh_receipt_working_day`, `handle_new_auth_user`, `rls_auto_enable`, `vietnam_working_day` and `is_admin` are not callable directly by `authenticated` after the hardening migration.

## Direct table access rules

- All authenticated public-table access is read-only at the GRANT layer.
- `wh_receipt` is server-only; `authenticated` has no direct SELECT.
- `pallet_change_history` remains SELECT-capable only when RLS confirms `dashboard.view`.
- `pallet_data` direct SELECT:
  - `pallet.create` / `pallet.edit`: broad read for Production operations;
  - `dashboard.view`: broad read for reporting/audit;
  - `scan.standard`: only own active `pendingWH` rows;
  - `receipt.view`: no direct access; receipt APIs authorize first and use service-role.

## Verification queries

Run these read-only queries in Supabase SQL Editor after pushing migrations.

### 1. `anon` table privileges should return zero rows

```sql
select table_schema, table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon'
  and table_schema = 'public'
order by table_name, privilege_type;
```

### 2. `authenticated` must not have direct DML

```sql
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'authenticated'
  and table_schema = 'public'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
order by table_name, privilege_type;
```

Expected: zero rows.

### 3. Review authenticated function whitelist

```sql
select routine_name, privilege_type
from information_schema.role_routine_grants
where grantee = 'authenticated'
  and routine_schema = 'public'
order by routine_name;
```

Expected: only the whitelist above.

### 4. Review current RLS policies

```sql
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

### 5. Review default privileges

```sql
select
  defaclrole::regrole as owner,
  defaclnamespace::regnamespace as schema_name,
  defaclobjtype,
  defaclacl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace;
```

New public objects must not automatically grant access to `anon` or `authenticated`.

## Rule for future migrations

Whenever a migration creates a new table/function/sequence:

1. Enable RLS for exposed tables.
2. Add the minimum required policy.
3. Add only the required `GRANT` explicitly.
4. For a SECURITY DEFINER function, validate permission/ownership inside the function and set a controlled `search_path`.
5. Never grant business RPC execution to `anon` unless a reviewed public unauthenticated use case explicitly requires it.
