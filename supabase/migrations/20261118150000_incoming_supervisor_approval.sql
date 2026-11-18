begin;

-- Shared proposals are separate from posted stock. The header preserves the
-- original submission for retries; supervisors edit/cancel individual lines.
create table public.inv_incoming_proposals (
  id uuid primary key,
  proposed_by uuid references public.profiles(id) on delete set null,
  proposed_by_name text not null,
  payload jsonb not null,
  row_count integer not null check(row_count between 1 and 500),
  total_quantity bigint not null check(total_quantity>0),
  created_at timestamptz not null default now()
);
create table public.inv_incoming_proposal_lines (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.inv_incoming_proposals(id) on delete restrict,
  line_no integer not null check(line_no>0),
  itemcode text not null,
  product_name text not null,
  customer text,
  received_date date not null,
  production_date date not null,
  wo text,
  quantity integer not null check(quantity>0),
  note text not null default '',
  version integer not null default 1,
  status text not null default 'pending' check(status in ('pending','posted','cancelled')),
  modified_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  approved_batch_id uuid references public.inv_incoming_batches(id) on delete restrict,
  approved_line_no integer,
  approved_version integer,
  unique(proposal_id,line_no),
  check((status='posted')=(approved_batch_id is not null)),
  check((approved_batch_id is null)=(approved_line_no is null)),
  check((approved_batch_id is null)=(approved_version is null))
);
create index inv_incoming_proposals_created_idx on public.inv_incoming_proposals(created_at,id);
create index inv_incoming_proposal_pending_idx on public.inv_incoming_proposal_lines(proposal_id,line_no) where status='pending';
create index inv_incoming_proposal_approval_idx on public.inv_incoming_proposal_lines(approved_batch_id) where approved_batch_id is not null;

alter table public.inv_incoming_proposals enable row level security;
alter table public.inv_incoming_proposal_lines enable row level security;
revoke all on public.inv_incoming_proposals,public.inv_incoming_proposal_lines from public,anon,authenticated,service_role;
grant select on public.inv_incoming_proposals,public.inv_incoming_proposal_lines to authenticated;
create policy incoming_proposals_read on public.inv_incoming_proposals for select to authenticated using(public.warehouse_access(false));
create policy incoming_proposal_lines_read on public.inv_incoming_proposal_lines for select to authenticated using(public.warehouse_access(false));

create function public.validate_incoming_proposal_row(p_row jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare code text; qty numeric; identity record; received date; produced date;
begin
  if jsonb_typeof(p_row) is distinct from 'object'
    or jsonb_typeof(p_row->'itemcode') is distinct from 'string'
    or btrim(p_row->>'itemcode') !~ '^[^[:space:]*]{1,200}$'
    or jsonb_typeof(p_row->'quantity') is distinct from 'number'
    or coalesce(p_row->>'received_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(p_row->>'production_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(jsonb_typeof(p_row->'wo'),'null') not in ('null','string')
    or coalesce(jsonb_typeof(p_row->'note'),'null') not in ('null','string')
    or length(coalesce(p_row->>'wo',''))>200 or length(coalesce(p_row->>'note',''))>2000 then
    raise exception 'INV_INVALID_ROW';
  end if;
  code:=btrim(p_row->>'itemcode'); qty:=(p_row->>'quantity')::numeric;
  if qty not between 1 and 2147483647 or qty<>trunc(qty) then raise exception 'INV_INVALID_QUANTITY'; end if;
  received:=(p_row->>'received_date')::date; produced:=(p_row->>'production_date')::date;
  select * into identity from public.warehouse_item_identity(code);
  if identity.lookup_error is not null then raise exception 'INV_ITEM_NOT_FOUND:%',code; end if;
  return jsonb_build_object('itemcode',code,'product_name',identity.product_name,'customer',identity.customer,
    'received_date',received,'production_date',produced,'wo',nullif(btrim(p_row->>'wo'),''),
    'quantity',qty::integer,'note',coalesce(btrim(p_row->>'note'),''));
end $$;
revoke all on function public.validate_incoming_proposal_row(jsonb) from public,anon,authenticated,service_role;

create function public.propose_manual_inventory(p_request_id uuid,p_rows jsonb)
returns table(batch_id uuid,row_count integer,total_quantity bigint)
language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); existing public.inv_incoming_proposals%rowtype; normalized jsonb:='[]'; x jsonb;
  operator_name text; total bigint:=0; count_rows integer;
begin
  if not public.warehouse_access(false) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_request_id is null or jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'INV_INVALID_ROWS'; end if;
  count_rows:=jsonb_array_length(p_rows);
  if count_rows not between 1 and 500 then raise exception 'INV_INVALID_ROWS'; end if;
  perform pg_advisory_xact_lock(hashtextextended('INV_PROPOSAL:'||p_request_id::text,0));
  select * into existing from public.inv_incoming_proposals where id=p_request_id;
  if found then
    if existing.proposed_by is distinct from actor or existing.payload is distinct from p_rows then raise exception 'INV_REQUEST_CONFLICT'; end if;
    return query select existing.id,existing.row_count,existing.total_quantity;
    return;
  end if;
  for x in select value from jsonb_array_elements(p_rows) loop
    x:=public.validate_incoming_proposal_row(x); total:=total+(x->>'quantity')::integer;
    normalized:=normalized||jsonb_build_array(x);
  end loop;
  select coalesce(nullif(btrim(full_name),''),username) into operator_name from public.profiles where id=actor;
  insert into public.inv_incoming_proposals(id,proposed_by,proposed_by_name,payload,row_count,total_quantity)
    values(p_request_id,actor,operator_name,p_rows,count_rows,total);
  insert into public.inv_incoming_proposal_lines(proposal_id,line_no,itemcode,product_name,customer,received_date,production_date,wo,quantity,note)
    select p_request_id,t.n::integer,t.rowdata->>'itemcode',t.rowdata->>'product_name',t.rowdata->>'customer',(t.rowdata->>'received_date')::date,
      (t.rowdata->>'production_date')::date,t.rowdata->>'wo',(t.rowdata->>'quantity')::integer,t.rowdata->>'note'
    from jsonb_array_elements(normalized) with ordinality t(rowdata,n);
  return query select p_request_id,count_rows,total;
end $$;

create function public.list_incoming_proposals(p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.warehouse_access(false) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_offset is null or p_offset<0 then raise exception 'INV_INVALID_PAGE'; end if;
  with pending as materialized (
    select l.*,p.proposed_by,p.proposed_by_name,p.created_at
    from public.inv_incoming_proposal_lines l join public.inv_incoming_proposals p on p.id=l.proposal_id
    where l.status='pending'
  ), page as (select * from pending order by created_at,proposal_id,line_no limit 100 offset p_offset)
  select jsonb_build_object('total',(select count(*) from pending),
    'rows',coalesce((select jsonb_agg(to_jsonb(p) order by created_at,proposal_id,line_no) from page p),'[]')) into result;
  return result;
end $$;

create function public.edit_incoming_proposal(p_id uuid,p_version integer,p_row jsonb,p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare current_row public.inv_incoming_proposal_lines%rowtype; x jsonb;
begin
  if not public.warehouse_access(true) then raise exception 'NOT_AUTHORIZED'; end if;
  select * into current_row from public.inv_incoming_proposal_lines where id=p_id for update;
  if not found or current_row.status<>'pending' or current_row.version is distinct from p_version then raise exception 'INV_PROPOSAL_STALE'; end if;
  if p_delete then
    update public.inv_incoming_proposal_lines set status='cancelled',version=version+1,modified_by=auth.uid(),updated_at=now() where id=p_id;
  else
    x:=public.validate_incoming_proposal_row(p_row);
    update public.inv_incoming_proposal_lines set itemcode=x->>'itemcode',product_name=x->>'product_name',customer=x->>'customer',
      received_date=(x->>'received_date')::date,production_date=(x->>'production_date')::date,wo=x->>'wo',
      quantity=(x->>'quantity')::integer,note=x->>'note',version=version+1,modified_by=auth.uid(),updated_at=now()
    where id=p_id;
  end if;
  return jsonb_build_object('id',p_id);
end $$;

create function public.approve_incoming_proposals(p_request_id uuid,p_rows jsonb)
returns table(batch_id uuid,row_count integer,total_quantity bigint)
language plpgsql security definer set search_path=public as $$
declare ids uuid[]; selected jsonb; recorded jsonb; stock_rows jsonb; existing public.inv_incoming_batches%rowtype; result record;
begin
  if not public.warehouse_access(true) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_request_id is null or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 500 then raise exception 'INV_INVALID_ROWS'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x->'id') is distinct from 'string'
    or jsonb_typeof(x->'version') is distinct from 'number'
    or (x->>'version')::numeric<1 or (x->>'version')::numeric<>trunc((x->>'version')::numeric)) then raise exception 'INV_INVALID_SELECTION'; end if;
  select array_agg((x->>'id')::uuid order by (x->>'id')::uuid),
    jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'version',(x->>'version')::integer) order by (x->>'id')::uuid)
  into ids,selected from jsonb_array_elements(p_rows) x;
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) t(id)) then raise exception 'INV_INVALID_SELECTION'; end if;
  -- Same lock as inventory posting: replay must validate the selected proposal
  -- identities as well as the existing batch's payload and approving actor.
  perform pg_advisory_xact_lock(hashtextextended('INV_MANUAL:'||p_request_id::text,0));
  select * into existing from public.inv_incoming_batches where id=p_request_id;
  if found then
    select jsonb_agg(jsonb_build_object('id',id,'version',approved_version) order by id) into recorded
      from public.inv_incoming_proposal_lines where approved_batch_id=p_request_id;
    if existing.entered_by is distinct from auth.uid() or selected is distinct from recorded then raise exception 'INV_REQUEST_CONFLICT'; end if;
    return query select existing.id,existing.row_count,existing.total_quantity;
    return;
  end if;
  perform 1 from public.inv_incoming_proposal_lines where id=any(ids) order by id for update;
  if (select count(*) from public.inv_incoming_proposal_lines where id=any(ids))<>cardinality(ids)
    or exists(select 1 from jsonb_array_elements(selected) x join public.inv_incoming_proposal_lines l on l.id=(x->>'id')::uuid
      where l.status<>'pending' or l.version<>(x->>'version')::integer) then raise exception 'INV_PROPOSAL_STALE'; end if;
  select jsonb_agg(jsonb_build_object('itemcode',itemcode,'received_date',received_date,'production_date',production_date,
    'wo',wo,'quantity',quantity,'note',note) order by id) into stock_rows
    from public.inv_incoming_proposal_lines where id=any(ids);
  select * into result from public.post_manual_inventory(p_request_id,stock_rows);
  update public.inv_incoming_proposal_lines l set status='posted',approved_batch_id=p_request_id,
    approved_line_no=n.line_no,approved_version=l.version,version=l.version+1,modified_by=auth.uid(),updated_at=now()
  from (select id,row_number() over(order by id)::integer as line_no from public.inv_incoming_proposal_lines where id=any(ids)) n where l.id=n.id;
  return query select result.batch_id,result.row_count,result.total_quantity;
end $$;

revoke all on function public.propose_manual_inventory(uuid,jsonb),public.list_incoming_proposals(integer),
  public.edit_incoming_proposal(uuid,integer,jsonb,boolean),public.approve_incoming_proposals(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.propose_manual_inventory(uuid,jsonb),public.list_incoming_proposals(integer),
  public.edit_incoming_proposal(uuid,integer,jsonb,boolean),public.approve_incoming_proposals(uuid,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
