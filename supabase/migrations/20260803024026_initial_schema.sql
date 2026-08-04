-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

DROP EXTENSION pg_net;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;

CREATE FUNCTION public.cancel_warehouse_receipt (
  p_receipt_id text
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  target_receipt public.wh_receipt;
  pallet_count integer;
begin
  if not public.has_permission('receipt.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into target_receipt
  from public.wh_receipt
  where receipt_id = p_receipt_id
  for update;

  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if target_receipt.status = 'cancelled' then
    raise exception 'RECEIPT_ALREADY_CANCELLED';
  end if;

  update public.pallet_data
  set status = 'production', wh_receipt = null
  where wh_receipt = p_receipt_id
    and effect_to is null
    and status = 'WHdone';

  get diagnostics pallet_count = row_count;

  update public.wh_receipt
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where receipt_id = p_receipt_id;

  return pallet_count;
end;
$function$;

GRANT ALL ON FUNCTION public.cancel_warehouse_receipt(text) TO anon;

GRANT ALL ON FUNCTION public.cancel_warehouse_receipt(text) TO authenticated;

GRANT ALL ON FUNCTION public.cancel_warehouse_receipt(text) TO service_role;

CREATE FUNCTION public.create_warehouse_receipt_from_scan (
  p_pallet_ids text[]
)
  RETURNS TABLE (
    receipt_id     text,
    receipt_date   date,
    total_pallet   integer,
    total_quantity bigint
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_date date := public.vietnam_working_day(now());
  v_order integer;
  v_receipt_id text;
  v_total_pallet integer;
  v_total_quantity bigint;
begin
  if coalesce(array_length(p_pallet_ids, 1), 0) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'warehouse'
  ) then
    raise exception 'Not authorized';
  end if;

  if exists (
    select 1
    from unnest(p_pallet_ids) x(pallet_id)
    left join public.pallet_data p
      on p.pallet_id = x.pallet_id
     and p.effect_to is null
    where p.pallet_id is null
       or p.status <> 'pendingWH'
       or (not public.is_admin() and p.scanned_by is distinct from auth.uid())
  ) then
    raise exception 'PALLET_STATUS_CHANGED_OR_NOT_OWNER';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('WH_RECEIPT_' || to_char(v_date, 'YYYYMMDD'))
  );

  select count(*)::integer,
         coalesce(sum(quantity), 0)::bigint
    into v_total_pallet, v_total_quantity
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  select coalesce(
           max((regexp_match(w.receipt_id, '-([0-9]+)$'))[1]::integer),
           0
         ) + 1
    into v_order
  from public.wh_receipt w
  where w.receipt_date = v_date;

  v_receipt_id :=
    'WH-' || to_char(v_date, 'DDMMYY') || '-' || lpad(v_order::text, 3, '0');

  insert into public.wh_receipt (
    receipt_id,
    receipt_date,
    total_pallet,
    total_quantity,
    user_id
  ) values (
    v_receipt_id,
    v_date,
    v_total_pallet,
    v_total_quantity,
    auth.uid()
  );

  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  update public.pallet_data
  set status = 'WHdone',
      wh_receipt = v_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  return query
  select v_receipt_id, v_date, v_total_pallet, v_total_quantity;
end;
$function$;

GRANT ALL ON FUNCTION public.create_warehouse_receipt_from_scan(text[]) TO anon;

GRANT ALL ON FUNCTION public.create_warehouse_receipt_from_scan(text[]) TO authenticated;

GRANT ALL ON FUNCTION public.create_warehouse_receipt_from_scan(text[]) TO service_role;

CREATE FUNCTION public.create_warehouse_receipt (
  p_pallet_ids text[]
)
  RETURNS TABLE (
    receipt_id     text,
    receipt_date   date,
    total_pallet   integer,
    total_quantity bigint
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_date date := current_date;
  v_order integer;
  v_receipt_id text;
  v_total_pallet integer;
  v_total_quantity bigint;
  v_requested_count integer := coalesce(array_length(p_pallet_ids, 1), 0);
begin
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
  end if;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  perform pg_advisory_xact_lock(hashtext('WH_RECEIPT_' || to_char(v_date, 'YYYYMMDD')));

  -- Lock the actual pallet rows first. FOR UPDATE cannot be used on count/sum.
  perform p.pallet_id
  from public.pallet_data p
  where p.pallet_id = any(p_pallet_ids)
    and p.effect_to is null
  for update;

  -- Validate every requested pallet after acquiring the row locks.
  select count(*)::integer,
         coalesce(sum(p.quantity), 0)::bigint
    into v_total_pallet, v_total_quantity
  from public.pallet_data p
  where p.pallet_id = any(p_pallet_ids)
    and p.effect_to is null
    and p.status = 'processingWH';

  if v_total_pallet <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  select coalesce(max((regexp_match(w.receipt_id, '-([0-9]+)$'))[1]::integer), 0) + 1
    into v_order
  from public.wh_receipt w
  where w.receipt_date = v_date;

  v_receipt_id := 'WH-' || to_char(v_date, 'DDMMYY') || '-' || lpad(v_order::text, 3, '0');

  insert into public.wh_receipt (
    receipt_id,
    receipt_date,
    total_pallet,
    total_quantity,
    user_id
  ) values (
    v_receipt_id,
    v_date,
    v_total_pallet,
    v_total_quantity,
    auth.uid()
  );

  update public.pallet_data
  set status = 'WHdone',
      wh_receipt = v_receipt_id
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  if not found then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  select v_receipt_id, v_date, v_total_pallet, v_total_quantity;
end;
$function$;

REVOKE ALL ON FUNCTION public.create_warehouse_receipt(text[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.create_warehouse_receipt(text[]) TO anon;

GRANT ALL ON FUNCTION public.create_warehouse_receipt(text[]) TO authenticated;

GRANT ALL ON FUNCTION public.create_warehouse_receipt(text[]) TO service_role;

CREATE FUNCTION public.current_profile_position()
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select p.position
  from public.profiles p
  where p.id = auth.uid() and p.is_active = true
$function$;

GRANT ALL ON FUNCTION public.current_profile_position() TO anon;

GRANT ALL ON FUNCTION public.current_profile_position() TO authenticated;

GRANT ALL ON FUNCTION public.current_profile_position() TO service_role;

CREATE FUNCTION public.current_profile_role()
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.is_active = true
$function$;

GRANT ALL ON FUNCTION public.current_profile_role() TO anon;

GRANT ALL ON FUNCTION public.current_profile_role() TO authenticated;

GRANT ALL ON FUNCTION public.current_profile_role() TO service_role;

CREATE FUNCTION public.handle_new_auth_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
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
$function$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

GRANT ALL ON FUNCTION public.handle_new_auth_user() TO anon;

GRANT ALL ON FUNCTION public.handle_new_auth_user() TO authenticated;

GRANT ALL ON FUNCTION public.handle_new_auth_user() TO service_role;

CREATE FUNCTION public.has_permission (
  p_permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select coalesce((
    select case
      when p.role = 'superadmin' then true
      when p.role = 'admin' then
        (p.position = 'planning' and p_permission in ('planning.upload','planning.change'))
        or (p.position = 'production' and p_permission in ('pallet.create','pallet.edit','receipt.create','receipt.edit'))
        or (p.position = 'warehouse' and p_permission = 'scan.standard')
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
  ),false)
$function$;

GRANT ALL ON FUNCTION public.has_permission(text) TO anon;

GRANT ALL ON FUNCTION public.has_permission(text) TO authenticated;

GRANT ALL ON FUNCTION public.has_permission(text) TO service_role;

CREATE FUNCTION public.is_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select coalesce(public.current_profile_role() in ('superadmin','admin'),false)
$function$;

GRANT ALL ON FUNCTION public.is_admin() TO anon;

GRANT ALL ON FUNCTION public.is_admin() TO authenticated;

GRANT ALL ON FUNCTION public.is_admin() TO service_role;

CREATE FUNCTION public.replace_planning_inject (
  p_rows        jsonb,
  p_source_file text
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  inserted_count integer;
begin
  if not public.has_permission('planning.upload') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  truncate table public.planning_inject restart identity;

  insert into public.planning_inject (
    machine,itemcode,product_name,customer,wo,netweight,quanperh,quanperday,
    color,material,package,quanorder,source_file,imported_by,imported_at
  )
  select
    x.machine,x.itemcode,x.product_name,x.customer,x.wo,x.netweight,x.quanperh,x.quanperday,
    x.color,x.material,x.package,x.quanorder,p_source_file,auth.uid(),now()
  from jsonb_to_recordset(p_rows) as x(
    machine text,itemcode text,product_name text,customer text,wo text,
    netweight numeric,quanperh numeric,quanperday numeric,color text,
    material text,package text,quanorder numeric
  );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;

GRANT ALL ON FUNCTION public.replace_planning_inject(jsonb, text) TO anon;

GRANT ALL ON FUNCTION public.replace_planning_inject(jsonb, text) TO authenticated;

GRANT ALL ON FUNCTION public.replace_planning_inject(jsonb, text) TO service_role;

CREATE FUNCTION public.rls_auto_enable()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog'
  AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;

GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;

GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;

CREATE FUNCTION public.set_pallet_working_day()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
declare
  v_original_working_day date;
begin
  -- Version rows created by edit/delete keep the working day of the original
  -- physical pallet row instead of receiving the current working day.
  if new.old_data_refer is not null then
    select working_day
      into v_original_working_day
    from public.pallet_data
    where id = new.old_data_refer;

    if v_original_working_day is not null then
      new.working_day := v_original_working_day;
      return new;
    end if;
  end if;

  if new.working_day is null then
    new.working_day := (
      timezone('Asia/Ho_Chi_Minh', coalesce(new.created_at, now())) - interval '6 hours'
    )::date;
  end if;

  return new;
end;
$function$;

GRANT ALL ON FUNCTION public.set_pallet_working_day() TO anon;

GRANT ALL ON FUNCTION public.set_pallet_working_day() TO authenticated;

GRANT ALL ON FUNCTION public.set_pallet_working_day() TO service_role;

CREATE FUNCTION public.set_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;

GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;

GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;

CREATE FUNCTION public.set_wh_receipt_working_day()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
begin
  new.receipt_date := public.vietnam_working_day(coalesce(new.created_at, now()));
  return new;
end;
$function$;

GRANT ALL ON FUNCTION public.set_wh_receipt_working_day() TO anon;

GRANT ALL ON FUNCTION public.set_wh_receipt_working_day() TO authenticated;

GRANT ALL ON FUNCTION public.set_wh_receipt_working_day() TO service_role;

CREATE FUNCTION public.vietnam_working_day (
  p_timestamp timestamp with time zone DEFAULT now()
)
  RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  select (
    timezone('Asia/Ho_Chi_Minh', p_timestamp) - interval '6 hours'
  )::date;
$function$;

GRANT ALL ON FUNCTION public.vietnam_working_day(timestamp WITH time zone) TO anon;

GRANT ALL ON FUNCTION public.vietnam_working_day(timestamp WITH time zone) TO authenticated;

GRANT ALL ON FUNCTION public.vietnam_working_day(timestamp WITH time zone) TO service_role;

CREATE TABLE public.item_pallet_config (
  itemcode            text                     NOT NULL,
  quantity_per_pallet integer                  NOT NULL,
  created_at          timestamp with time zone DEFAULT now() NOT NULL,
  updated_at          timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.item_pallet_config
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.item_pallet_config
  ADD CONSTRAINT item_pallet_config_pkey PRIMARY KEY (itemcode);

ALTER TABLE public.item_pallet_config
  ADD CONSTRAINT item_pallet_config_quantity_per_pallet_check CHECK (quantity_per_pallet > 0);

GRANT SELECT ON public.item_pallet_config TO authenticated;

GRANT ALL ON public.item_pallet_config TO service_role;

CREATE TRIGGER item_pallet_config_set_updated_at
  BEFORE UPDATE ON public.item_pallet_config
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY item_pallet_config_select_authorized ON public.item_pallet_config
  FOR SELECT
  TO authenticated
  USING ((public.has_permission('pallet.create'::text) OR public.has_permission('pallet.edit'::text)));

CREATE TABLE public.pallet_change_history (
  id             bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  pallet_data_id bigint                   NOT NULL,
  pallet_id      text                     NOT NULL,
  change_type    text                     DEFAULT 'scan_return'::text NOT NULL,
  scanned_by     uuid,
  scanned_at     timestamp with time zone NOT NULL,
  cancelled_by   uuid                     NOT NULL,
  cancelled_at   timestamp with time zone NOT NULL,
  created_at     timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.pallet_change_history
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pallet_change_history
  ADD CONSTRAINT pallet_change_history_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id);

ALTER TABLE public.pallet_change_history
  ADD CONSTRAINT pallet_change_history_change_type_check CHECK (change_type = 'scan_return'::text);

ALTER TABLE public.pallet_change_history
  ADD CONSTRAINT pallet_change_history_pkey PRIMARY KEY (id);

ALTER TABLE public.pallet_change_history
  ADD CONSTRAINT pallet_change_history_scanned_by_fkey FOREIGN KEY (scanned_by) REFERENCES auth.users(id);

GRANT ALL ON public.pallet_change_history TO authenticated;

GRANT ALL ON public.pallet_change_history TO service_role;

CREATE INDEX pallet_change_history_pallet_data_id_idx ON public.pallet_change_history (pallet_data_id);

CREATE INDEX pallet_change_history_pallet_id_idx ON public.pallet_change_history (pallet_id);

CREATE INDEX pallet_change_history_cancelled_at_idx ON public.pallet_change_history (cancelled_at DESC);

CREATE POLICY pallet_change_history_read ON public.pallet_change_history
  FOR SELECT
  TO authenticated
  USING (true);

CREATE TABLE public.pallet_data (
  id                 bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  pallet_id          text                     NOT NULL,
  itemcode           text                     NOT NULL,
  product_name       text,
  customer           text,
  wo                 text                     NOT NULL,
  quanorder          numeric,
  machine            text,
  quantity           integer                  NOT NULL,
  status             text                     DEFAULT 'production'::text NOT NULL,
  effect_to          timestamp with time zone,
  note               text,
  wh_receipt         text,
  created_by         uuid,
  created_at         timestamp with time zone DEFAULT now() NOT NULL,
  updated_at         timestamp with time zone DEFAULT now() NOT NULL,
  scanned_at         timestamp with time zone,
  scanned_by         uuid,
  scan_confirmed_at  timestamp with time zone,
  scan_confirmed_by  uuid,
  warehouse_done_at  timestamp with time zone,
  warehouse_done_by  uuid,
  return_from_status text,
  has_been_edited    boolean                  DEFAULT false NOT NULL,
  edit_count         integer                  DEFAULT 0 NOT NULL,
  deleted_at         timestamp with time zone,
  deleted_by         uuid,
  old_data_refer     bigint,
  has_been_return    boolean                  DEFAULT false NOT NULL,
  working_day        date                     NOT NULL
);

CREATE FUNCTION public.cancel_pending_pallet (
  p_pallet_id text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_row public.pallet_data;
  v_cancelled_at timestamptz := now();
begin
  select * into v_row
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if v_row.status <> 'pendingWH' then
    raise exception 'INVALID_STATUS:%', v_row.status;
  end if;

  if not public.is_admin() and v_row.scanned_by is distinct from auth.uid() then
    raise exception 'NOT_SCAN_OWNER';
  end if;

  insert into public.pallet_change_history (
    pallet_data_id,
    pallet_id,
    change_type,
    scanned_by,
    scanned_at,
    cancelled_by,
    cancelled_at
  ) values (
    v_row.id,
    v_row.pallet_id,
    'scan_return',
    v_row.scanned_by,
    coalesce(v_row.scanned_at, v_row.updated_at, v_cancelled_at),
    auth.uid(),
    v_cancelled_at
  );

  update public.pallet_data
  set status = 'production',
      scanned_by = null,
      scanned_at = null,
      has_been_return = true,
      updated_at = v_cancelled_at
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

GRANT ALL ON FUNCTION public.cancel_pending_pallet(text) TO anon;

GRANT ALL ON FUNCTION public.cancel_pending_pallet(text) TO authenticated;

GRANT ALL ON FUNCTION public.cancel_pending_pallet(text) TO service_role;

CREATE FUNCTION public.cancel_processing_pallets (
  p_pallet_ids text[]
)
  RETURNS SETOF public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_requested_count integer := coalesce(array_length(p_pallet_ids, 1), 0);
  v_locked_count integer;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'warehouse'
  ) then
    raise exception 'Not authorized';
  end if;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  -- Lock each active pallet row. Do not combine FOR UPDATE with aggregate queries.
  perform 1
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
  order by pallet_id
  for update;

  select count(*)::integer
    into v_locked_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH';

  if v_locked_count <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'production',
      wh_receipt = null
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'processingWH'
  returning *;
end;
$function$;

REVOKE ALL ON FUNCTION public.cancel_processing_pallets(text[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.cancel_processing_pallets(text[]) TO anon;

GRANT ALL ON FUNCTION public.cancel_processing_pallets(text[]) TO authenticated;

GRANT ALL ON FUNCTION public.cancel_processing_pallets(text[]) TO service_role;

CREATE FUNCTION public.confirm_pending_pallets_tracked (
  p_pallet_ids text[]
)
  RETURNS SETOF public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_actor uuid := auth.uid();
  v_requested_count integer;
  v_locked_count integer;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if p_pallet_ids is null or cardinality(p_pallet_ids) = 0 then
    raise exception 'NO_PALLETS';
  end if;

  select count(distinct pallet_id)
    into v_requested_count
  from unnest(p_pallet_ids) as requested(pallet_id)
  where nullif(btrim(pallet_id), '') is not null;

  if v_requested_count = 0 then
    raise exception 'NO_PALLETS';
  end if;

  -- Row locking must be performed on real pallet rows, not on count(*).
  perform 1
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
  for update;

  select count(*)
    into v_locked_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH';

  if v_locked_count <> v_requested_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH'
  returning *;
end;
$function$;

REVOKE ALL ON FUNCTION public.confirm_pending_pallets_tracked(text[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.confirm_pending_pallets_tracked(text[]) TO anon;

GRANT ALL ON FUNCTION public.confirm_pending_pallets_tracked(text[]) TO authenticated;

GRANT ALL ON FUNCTION public.confirm_pending_pallets_tracked(text[]) TO service_role;

CREATE FUNCTION public.confirm_pending_pallets (
  p_pallet_ids text[]
)
  RETURNS SETOF public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  expected_count integer;
  matched_count integer;
begin
  if not public.has_permission('scan.standard') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  expected_count := coalesce(array_length(p_pallet_ids,1),0);
  if expected_count = 0 then raise exception 'EMPTY_LIST'; end if;

  select count(*) into matched_count
  from public.pallet_data
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH'
  for update;

  if matched_count <> expected_count then
    raise exception 'PALLET_STATUS_CHANGED';
  end if;

  return query
  update public.pallet_data
  set status = 'processingWH'
  where pallet_id = any(p_pallet_ids)
    and effect_to is null
    and status = 'pendingWH'
  returning *;
end;
$function$;

GRANT ALL ON FUNCTION public.confirm_pending_pallets(text[]) TO anon;

GRANT ALL ON FUNCTION public.confirm_pending_pallets(text[]) TO authenticated;

GRANT ALL ON FUNCTION public.confirm_pending_pallets(text[]) TO service_role;

CREATE FUNCTION public.create_pallet_record (
  p_itemcode     text,
  p_product_name text,
  p_customer     text,
  p_wo           text,
  p_quanorder    numeric,
  p_machine      text,
  p_quantity     integer,
  p_note         text    DEFAULT NULL::text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  next_number integer;
  new_pallet_id text;
  new_row public.pallet_data;
begin
  if not public.has_permission('pallet.create') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(trim(p_wo),'') = '' then raise exception 'WO_REQUIRED'; end if;
  if coalesce(trim(p_itemcode),'') = '' then raise exception 'ITEMCODE_REQUIRED'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  perform pg_advisory_xact_lock(hashtext(p_wo));

  select coalesce(max((regexp_match(pallet_id,'-([0-9]+)$'))[1]::integer),0) + 1
  into next_number
  from public.pallet_data
  where wo = p_wo;

  new_pallet_id := p_wo || '-' || lpad(next_number::text,3,'0');

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,
    quantity,status,note,created_by
  ) values (
    new_pallet_id,p_itemcode,p_product_name,p_customer,p_wo,p_quanorder,p_machine,
    p_quantity,'production',p_note,auth.uid()
  ) returning * into new_row;

  return new_row;
end;
$function$;

GRANT ALL ON FUNCTION public.create_pallet_record(text, text, text, text, numeric, text, integer, text) TO anon;

GRANT ALL ON FUNCTION public.create_pallet_record(text, text, text, text, numeric, text, integer, text) TO authenticated;

GRANT ALL ON FUNCTION public.create_pallet_record(text, text, text, text, numeric, text, integer, text) TO service_role;

CREATE FUNCTION public.delete_pallet_record_tracked (
  p_pallet_id text,
  p_reason    text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_old public.pallet_data;
  v_deleted public.pallet_data;
  v_now timestamptz := now();
begin
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_old
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then
    raise exception 'PALLET_NOT_FOUND';
  end if;

  if v_old.status <> 'production' then
    raise exception 'INVALID_STATUS:%', v_old.status;
  end if;

  update public.pallet_data
  set effect_to = v_now,
      updated_at = v_now
  where id = v_old.id;

  insert into public.pallet_data (
    pallet_id,
    itemcode,
    product_name,
    customer,
    wo,
    quanorder,
    machine,
    quantity,
    status,
    created_by,
    note,
    old_data_refer,
    effect_to,
    created_at,
    updated_at
  ) values (
    v_old.pallet_id,
    v_old.itemcode,
    v_old.product_name,
    v_old.customer,
    v_old.wo,
    v_old.quanorder,
    v_old.machine,
    v_old.quantity,
    v_old.status,
    auth.uid(),
    'delete: ' || trim(p_reason),
    v_old.id,
    v_now,
    v_now,
    v_now
  )
  returning * into v_deleted;

  return v_deleted;
end;
$function$;

GRANT ALL ON FUNCTION public.delete_pallet_record_tracked(text, text) TO anon;

GRANT ALL ON FUNCTION public.delete_pallet_record_tracked(text, text) TO authenticated;

GRANT ALL ON FUNCTION public.delete_pallet_record_tracked(text, text) TO service_role;

CREATE FUNCTION public.delete_pallet_record (
  p_pallet_id text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  deleted_row public.pallet_data;
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into deleted_row
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if deleted_row.status <> 'production' then
    raise exception 'INVALID_STATUS:%',deleted_row.status;
  end if;

  update public.pallet_data
  set effect_to = now(), note = concat_ws(' | ',note,'delete')
  where id = deleted_row.id
  returning * into deleted_row;

  return deleted_row;
end;
$function$;

GRANT ALL ON FUNCTION public.delete_pallet_record(text) TO anon;

GRANT ALL ON FUNCTION public.delete_pallet_record(text) TO authenticated;

GRANT ALL ON FUNCTION public.delete_pallet_record(text) TO service_role;

CREATE FUNCTION public.edit_pallet_quantity_tracked (
  p_pallet_id text,
  p_quantity  integer,
  p_reason    text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_old public.pallet_data;
  v_new public.pallet_data;
  v_now timestamptz := now();
begin
  if not public.is_admin() and not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'production'
  ) then
    raise exception 'Not authorized';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_old
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if v_old.status <> 'production' then
    raise exception 'INVALID_STATUS:%', v_old.status;
  end if;

  update public.pallet_data
  set effect_to = v_now,
      updated_at = v_now
  where id = v_old.id;

  insert into public.pallet_data (
    pallet_id,
    itemcode,
    product_name,
    customer,
    wo,
    quanorder,
    machine,
    quantity,
    status,
    created_by,
    note,
    old_data_refer,
    has_been_edited,
    edit_count,
    has_been_return,
    created_at,
    updated_at
  ) values (
    v_old.pallet_id,
    v_old.itemcode,
    v_old.product_name,
    v_old.customer,
    v_old.wo,
    v_old.quanorder,
    v_old.machine,
    p_quantity,
    v_old.status,
    auth.uid(),
    'edit: ' || trim(p_reason),
    v_old.id,
    true,
    coalesce(v_old.edit_count, 0) + 1,
    coalesce(v_old.has_been_return, false),
    v_now,
    v_now
  )
  returning * into v_new;

  return v_new;
end;
$function$;

GRANT ALL ON FUNCTION public.edit_pallet_quantity_tracked(text, integer, text) TO anon;

GRANT ALL ON FUNCTION public.edit_pallet_quantity_tracked(text, integer, text) TO authenticated;

GRANT ALL ON FUNCTION public.edit_pallet_quantity_tracked(text, integer, text) TO service_role;

CREATE FUNCTION public.edit_pallet_quantity (
  p_pallet_id text,
  p_quantity  integer
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  current_row public.pallet_data;
  new_row public.pallet_data;
begin
  if not public.has_permission('pallet.edit') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select * into current_row
  from public.pallet_data
  where pallet_id = p_pallet_id and effect_to is null
  for update;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  if current_row.status <> 'production' then
    raise exception 'INVALID_STATUS:%',current_row.status;
  end if;

  update public.pallet_data
  set effect_to = now(), note = concat_ws(' | ',note,'edit old quantity=' || quantity)
  where id = current_row.id;

  insert into public.pallet_data (
    pallet_id,itemcode,product_name,customer,wo,quanorder,machine,
    quantity,status,effect_to,note,wh_receipt,created_by,created_at
  ) values (
    current_row.pallet_id,current_row.itemcode,current_row.product_name,current_row.customer,
    current_row.wo,current_row.quanorder,current_row.machine,p_quantity,current_row.status,
    null,concat_ws(' | ',current_row.note,'edit new quantity=' || p_quantity),
    current_row.wh_receipt,auth.uid(),now()
  ) returning * into new_row;

  return new_row;
end;
$function$;

GRANT ALL ON FUNCTION public.edit_pallet_quantity(text, integer) TO anon;

GRANT ALL ON FUNCTION public.edit_pallet_quantity(text, integer) TO authenticated;

GRANT ALL ON FUNCTION public.edit_pallet_quantity(text, integer) TO service_role;

CREATE FUNCTION public.scan_pallet_to_pending (
  p_pallet_id text
)
  RETURNS public.pallet_data
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_row public.pallet_data;
begin
  if not public.is_admin() and not exists (
    select 1 from public.profiles
    where id = auth.uid()
      and is_active = true
      and position = 'warehouse'
  ) then
    raise exception 'Not authorized';
  end if;

  update public.pallet_data
  set status = 'pendingWH',
      scanned_by = auth.uid(),
      scanned_at = now()
  where pallet_id = trim(p_pallet_id)
    and effect_to is null
    and status = 'production'
  returning * into v_row;

  if found then return v_row; end if;

  select * into v_row
  from public.pallet_data
  where pallet_id = trim(p_pallet_id)
    and effect_to is null;

  if not found then raise exception 'PALLET_NOT_FOUND'; end if;
  raise exception 'INVALID_STATUS:%', v_row.status;
end;
$function$;

GRANT ALL ON FUNCTION public.scan_pallet_to_pending(text) TO anon;

GRANT ALL ON FUNCTION public.scan_pallet_to_pending(text) TO authenticated;

GRANT ALL ON FUNCTION public.scan_pallet_to_pending(text) TO service_role;

COMMENT ON COLUMN public.pallet_data.working_day IS 'Vietnam production working day: 06:00 local time to before 06:00 next day.';

ALTER TABLE public.pallet_data
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_pkey PRIMARY KEY (id);

ALTER TABLE public.pallet_change_history
  ADD CONSTRAINT pallet_change_history_pallet_data_id_fkey FOREIGN KEY (pallet_data_id) REFERENCES public.pallet_data(id);

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_old_data_refer_fkey FOREIGN KEY (old_data_refer) REFERENCES public.pallet_data(id);

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_quantity_check CHECK (quantity > 0);

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_return_from_status_check CHECK (return_from_status IS NULL OR (return_from_status = ANY (ARRAY['pendingWH'::text, 'processingWH'::text])));

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_status_check CHECK (status = ANY (ARRAY['production'::text, 'pendingWH'::text, 'processingWH'::text, 'WHdone'::text]));

GRANT SELECT ON public.pallet_data TO authenticated;

GRANT ALL ON public.pallet_data TO service_role;

CREATE INDEX pallet_data_working_day_idx ON public.pallet_data (working_day);

CREATE INDEX pallet_data_scanned_by_status_idx ON public.pallet_data (scanned_by, status)
  WHERE effect_to IS NULL;

CREATE INDEX pallet_data_old_data_refer_idx ON public.pallet_data (old_data_refer);

CREATE UNIQUE INDEX pallet_data_one_active_version_idx ON public.pallet_data (pallet_id)
  WHERE effect_to IS NULL;

CREATE UNIQUE INDEX pallet_data_active_pallet_id_uidx ON public.pallet_data (pallet_id)
  WHERE effect_to IS NULL;

CREATE INDEX pallet_data_wo_idx ON public.pallet_data (wo);

CREATE INDEX pallet_data_itemcode_idx ON public.pallet_data (itemcode);

CREATE INDEX pallet_data_machine_idx ON public.pallet_data (machine);

CREATE INDEX pallet_data_status_idx ON public.pallet_data (status);

CREATE INDEX pallet_data_receipt_idx ON public.pallet_data (wh_receipt);

CREATE TRIGGER pallet_data_set_updated_at
  BEFORE UPDATE ON public.pallet_data
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER pallet_data_set_working_day
  BEFORE INSERT ON public.pallet_data
  FOR EACH ROW
  EXECUTE FUNCTION public.set_pallet_working_day();

CREATE POLICY pallet_data_select_authorized ON public.pallet_data
  FOR SELECT
  TO authenticated
  USING
    ((public.has_permission('pallet.create'::text) OR public.has_permission('pallet.edit'::text) OR public.has_permission('scan.standard'::text) OR
    public.has_permission('receipt.create'::text) OR public.has_permission('receipt.edit'::text)));

CREATE TABLE public.permissions (
  permission_key text                     NOT NULL,
  module         text                     NOT NULL,
  description    text                     NOT NULL,
  created_at     timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.permissions
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.permissions
  ADD CONSTRAINT permissions_pkey PRIMARY KEY (permission_key);

GRANT SELECT ON public.permissions TO authenticated;

GRANT ALL ON public.permissions TO service_role;

CREATE POLICY permissions_read_authenticated ON public.permissions
  FOR SELECT
  TO authenticated
  USING (true);

CREATE TABLE public.planning_inject (
  id           bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  machine      text,
  itemcode     text,
  product_name text,
  customer     text,
  wo           text,
  netweight    numeric,
  quanperh     numeric,
  quanperday   numeric,
  color        text,
  material     text,
  package      text,
  quanorder    numeric,
  source_file  text,
  imported_by  uuid,
  imported_at  timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.planning_inject
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.planning_inject
  ADD CONSTRAINT planning_inject_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.planning_inject
  ADD CONSTRAINT planning_inject_pkey PRIMARY KEY (id);

GRANT SELECT ON public.planning_inject TO authenticated;

GRANT ALL ON public.planning_inject TO service_role;

CREATE INDEX planning_inject_itemcode_idx ON public.planning_inject (itemcode);

CREATE INDEX planning_inject_wo_idx ON public.planning_inject (wo);

CREATE INDEX planning_inject_machine_idx ON public.planning_inject (machine);

CREATE POLICY planning_inject_select_authorized ON public.planning_inject
  FOR SELECT
  TO authenticated
  USING
    ((public.has_permission('planning.upload'::text) OR public.has_permission('planning.change'::text) OR public.has_permission('pallet.create'::text) OR
    public.has_permission('pallet.edit'::text)));

CREATE TABLE public.position_page_access (
  "position" text                     NOT NULL,
  path       text                     NOT NULL,
  is_enabled boolean                  DEFAULT true NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.position_page_access
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.position_page_access
  ADD CONSTRAINT position_page_access_pkey PRIMARY KEY ("position", path);

ALTER TABLE public.position_page_access
  ADD CONSTRAINT position_page_access_position_check CHECK ("position" = ANY (ARRAY['planning'::text, 'production'::text, 'warehouse'::text]));

GRANT DELETE, INSERT, SELECT, UPDATE ON public.position_page_access TO authenticated;

GRANT ALL ON public.position_page_access TO service_role;

CREATE POLICY position_page_access_read ON public.position_page_access
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY position_page_access_superadmin_manage ON public.position_page_access
  TO authenticated
  USING ((public.current_profile_role() = 'superadmin'::text))
  WITH CHECK ((public.current_profile_role() = 'superadmin'::text));

CREATE TABLE public.profiles (
  id            uuid                     NOT NULL,
  email         text                     NOT NULL,
  full_name     text                     DEFAULT 'New user'::text NOT NULL,
  employee_code text,
  role          text                     DEFAULT 'user'::text NOT NULL,
  "position"    text,
  is_active     boolean                  DEFAULT true NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  username      text                     NOT NULL
);

ALTER TABLE public.profiles
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_email_key UNIQUE (email);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_employee_code_key UNIQUE (employee_code);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.position_page_access
  ADD CONSTRAINT position_page_access_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_position_check CHECK ("position" IS NULL OR ("position" = ANY (ARRAY['planning'::text, 'production'::text, 'warehouse'::text])));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY['superadmin'::text, 'admin'::text, 'user'::text]));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_position_check CHECK (role = 'superadmin'::text AND "position" IS NULL OR (role = ANY (ARRAY['admin'::text, 'user'::text])) AND "position" IS
    NOT NULL);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'::text);

GRANT SELECT ON public.profiles TO authenticated;

GRANT ALL ON public.profiles TO service_role;

CREATE INDEX profiles_role_idx ON public.profiles (ROLE);

CREATE INDEX profiles_position_idx ON public.profiles ("position");

CREATE INDEX profiles_active_idx ON public.profiles (is_active);

CREATE UNIQUE INDEX profiles_username_lower_uidx ON public.profiles (lower(username));

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY profiles_select_scope ON public.profiles
  FOR SELECT
  TO authenticated
  USING
    (((id = auth.uid()) OR (public.current_profile_role() = 'superadmin'::text) OR ((public.current_profile_role() = 'admin'::text) AND (ROLE = 'user'::text) AND ("position" =
    public.current_profile_position()))));

CREATE TABLE public.user_permissions (
  user_id        uuid                     NOT NULL,
  permission_key text                     NOT NULL,
  granted_by     uuid,
  created_at     timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.user_permissions
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_permissions
  ADD CONSTRAINT user_permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.user_permissions
  ADD CONSTRAINT user_permissions_permission_key_check
    CHECK (permission_key = ANY (ARRAY['planning.upload'::text, 'planning.change'::text, 'pallet.create'::text, 'pallet.edit'::text, 'scan.standard'::text, 'receipt.view'::text]));

ALTER TABLE public.user_permissions
  ADD CONSTRAINT user_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(permission_key) ON DELETE CASCADE;

ALTER TABLE public.user_permissions
  ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (user_id, permission_key);

ALTER TABLE public.user_permissions
  ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_permissions TO authenticated;

GRANT ALL ON public.user_permissions TO service_role;

CREATE INDEX user_permissions_permission_key_idx ON public.user_permissions (permission_key);

CREATE POLICY user_permissions_manage_scope ON public.user_permissions
  TO authenticated
  USING (((public.current_profile_role() = 'superadmin'::text) OR ((public.current_profile_role() = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.profiles target
  WHERE ((target.id = user_permissions.user_id) AND (target.role = 'user'::text) AND (target."position" = public.current_profile_position())))))))
  WITH CHECK (((public.current_profile_role() = 'superadmin'::text) OR ((public.current_profile_role() = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.profiles target
  WHERE ((target.id = user_permissions.user_id) AND (target.role = 'user'::text) AND (target."position" = public.current_profile_position())))))));

CREATE POLICY user_permissions_read_scope ON public.user_permissions
  FOR SELECT
  TO authenticated
  USING (((user_id = auth.uid()) OR (public.current_profile_role() = 'superadmin'::text) OR ((public.current_profile_role() = 'admin'::text) AND (EXISTS ( SELECT 1
   FROM public.profiles target
  WHERE ((target.id = user_permissions.user_id) AND (target.role = 'user'::text) AND (target."position" = public.current_profile_position())))))));

CREATE TABLE public.wh_receipt (
  receipt_id     text                     NOT NULL,
  receipt_date   date                     DEFAULT CURRENT_DATE NOT NULL,
  total_pallet   integer                  NOT NULL,
  total_quantity bigint                   NOT NULL,
  uid_user       uuid,
  status         text                     DEFAULT 'active'::text NOT NULL,
  created_at     timestamp with time zone DEFAULT now() NOT NULL,
  cancelled_at   timestamp with time zone,
  cancelled_by   uuid,
  user_id        uuid
);

ALTER TABLE public.wh_receipt
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_pkey PRIMARY KEY (receipt_id);

ALTER TABLE public.pallet_data
  ADD CONSTRAINT pallet_data_wh_receipt_fk FOREIGN KEY (wh_receipt) REFERENCES public.wh_receipt(receipt_id) ON DELETE SET NULL;

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_status_check CHECK (status = ANY (ARRAY['active'::text, 'cancelled'::text]));

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_total_pallet_check CHECK (total_pallet > 0);

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_total_quantity_check CHECK (total_quantity > 0);

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_uid_user_fkey FOREIGN KEY (uid_user) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.wh_receipt
  ADD CONSTRAINT wh_receipt_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

GRANT SELECT ON public.wh_receipt TO authenticated;

GRANT ALL ON public.wh_receipt TO service_role;

CREATE INDEX wh_receipt_date_idx ON public.wh_receipt (receipt_date DESC);

CREATE INDEX wh_receipt_status_idx ON public.wh_receipt (status);

CREATE INDEX wh_receipt_user_id_idx ON public.wh_receipt (user_id);

CREATE TRIGGER wh_receipt_set_working_day
  BEFORE INSERT ON public.wh_receipt
  FOR EACH ROW
  EXECUTE FUNCTION public.set_wh_receipt_working_day();

CREATE POLICY wh_receipt_select_authorized ON public.wh_receipt
  FOR SELECT
  TO authenticated
  USING ((public.has_permission('receipt.create'::text) OR public.has_permission('receipt.edit'::text)));

CREATE EVENT TRIGGER ensure_rls
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();
