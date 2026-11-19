begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Keep the existing creation RPC, permissions and behavior. Only repair the
-- counter formatting: lpad('1000',3,'0') truncates to '100' and reuses an ID.
do $$
declare target regprocedure:=to_regprocedure('public.create_pallet_record(text,text,text,text,numeric,text,integer,text,date,boolean)');
  definition text; old_padding text:='lpad(next_number::text, 3, ''0'')';
  new_padding text:='lpad(next_number::text, greatest(3, length(next_number::text)), ''0'')';
begin
  if target is null then raise exception 'PALLET_CREATE_RPC_MISSING'; end if;
  definition:=pg_get_functiondef(target);
  if position(old_padding in definition)>0 then
    execute replace(definition,old_padding,new_padding);
  elsif position(new_padding in definition)=0 then
    raise exception 'PALLET_CREATE_RPC_DRIFT: inspect the production counter before applying';
  end if;
end $$;

create function public.check_new_pallet_wo(p_wo text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare code text:=btrim(p_wo);
begin
  if auth.uid() is null or not public.has_permission('pallet.create') then raise exception 'NOT_AUTHORIZED'; end if;
  if code is null or length(code) not between 1 and 120 or code='0' or code ~ '[[:cntrl:]]' then
    return jsonb_build_object('wo',coalesce(code,''),'valid',false,'reason','INVALID');
  end if;
  -- Includes all items, deleted pallets and expired versions. Also defend
  -- against a historical first-label ID with an inconsistent WO field.
  if exists(select 1 from public.pallet_data p where lower(btrim(p.wo))=lower(code)
    or lower(btrim(p.pallet_id))=lower(code||'-001')) then
    return jsonb_build_object('wo',code,'valid',false,'reason','EXISTS');
  end if;
  return jsonb_build_object('wo',code,'valid',true,'reason',null);
end $$;

create function public.create_pallet_from_new_wo(p_itemcode text,p_wo text,p_quanorder numeric,p_quantity integer,p_working_day date)
returns public.pallet_data language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare code text:=btrim(p_itemcode); work_order text:=btrim(p_wo); checked jsonb;
  catalog public.item_pallet_config%rowtype; title text; customer_name text; created public.pallet_data;
begin
  if auth.uid() is null or not public.has_permission('pallet.create') then raise exception 'NOT_AUTHORIZED'; end if;
  if code is null or code !~ '^[^[:space:]*]{1,200}$' or p_quantity is null or p_quantity<=0
    or p_working_day is null or p_quanorder is null or p_quanorder<=0
    or p_quanorder::text in ('NaN','Infinity','-Infinity') then raise exception 'PALLET_NEW_WO_INVALID'; end if;
  checked:=public.check_new_pallet_wo(work_order);
  if checked->>'reason'='INVALID' then raise exception 'PALLET_NEW_WO_INVALID'; end if;
  -- The two-int namespace serializes case variants of new WOs. The legacy
  -- one-key lock is shared with ordinary label printing. Always use this order.
  perform pg_advisory_xact_lock(19111926,hashtext(lower(work_order)));
  perform pg_advisory_xact_lock(hashtext(work_order));
  checked:=public.check_new_pallet_wo(work_order);
  if not (checked->>'valid')::boolean then raise exception 'PALLET_NEW_WO_EXISTS'; end if;
  select * into catalog from public.item_pallet_config c where c.itemcode=code;
  if not found then raise exception 'PALLET_NEW_WO_ITEM_MISSING'; end if;
  title:=coalesce(nullif(btrim(catalog.product_name),''),nullif(btrim(catalog."ERP_name"),''));
  customer_name:=nullif(btrim(catalog.customer),'');
  if title is null then raise exception 'PALLET_NEW_WO_NAME_MISSING'; end if;
  if customer_name is null then raise exception 'PALLET_NEW_WO_CUSTOMER_MISSING'; end if;
  select * into created from public.create_pallet_record(code,title,customer_name,work_order,p_quanorder,null,p_quantity,
    null,p_working_day,coalesce(p_quantity=catalog.quantity_per_pallet,false));
  return created;
exception when lock_not_available then raise exception using errcode='55P03',message='PALLET_NEW_WO_BUSY';
  when unique_violation then raise exception 'PALLET_NEW_WO_ID_CONFLICT';
end $$;

revoke all on function public.check_new_pallet_wo(text),public.create_pallet_from_new_wo(text,text,numeric,integer,date) from public,anon,authenticated,service_role;
grant execute on function public.check_new_pallet_wo(text),public.create_pallet_from_new_wo(text,text,numeric,integer,date) to authenticated;
notify pgrst,'reload schema';
commit;
