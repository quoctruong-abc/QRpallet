begin;

create table public.item_build_up (
  id bigint generated always as identity primary key,
  parent_itemcode text not null check (length(parent_itemcode) between 1 and 200 and parent_itemcode !~ '[[:space:]*]'),
  child_itemcode_1 text check (length(child_itemcode_1) between 1 and 200 and child_itemcode_1 !~ '[[:space:]*]'),
  child_itemcode_2 text check (length(child_itemcode_2) between 1 and 200 and child_itemcode_2 !~ '[[:space:]*]'),
  child_itemcode_3 text check (length(child_itemcode_3) between 1 and 200 and child_itemcode_3 !~ '[[:space:]*]'),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint item_build_up_has_child check (coalesce(child_itemcode_1,child_itemcode_2,child_itemcode_3) is not null),
  constraint item_build_up_unique_recipe unique nulls not distinct (parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3)
);

alter table public.item_build_up enable row level security;
revoke all on table public.item_build_up from public,anon,authenticated,service_role;
revoke all on sequence public.item_build_up_id_seq from public,anon,authenticated,service_role;
grant select on table public.item_build_up to service_role;

create function public.sync_warehouse_item_build_up(p_rows jsonb,p_preview boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  actor uuid := auth.uid();
  input_count integer;
  new_count integer;
begin
  if not exists(select 1 from public.profiles p where p.id=actor and p.is_active and p.role='superadmin') then
    raise exception 'ITEM_BUILD_UP_NOT_AUTHORIZED';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or p_preview is null then
    raise exception 'ITEM_BUILD_UP_INVALID_ROWS';
  end if;
  input_count := jsonb_array_length(p_rows);
  if input_count not between 1 and 20000 then raise exception 'ITEM_BUILD_UP_INVALID_ROWS'; end if;
  if exists (
    select from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'parent_itemcode') is distinct from 'string'
      or (r->>'parent_itemcode') !~ '^[^[:space:]*]{1,200}$'
      or coalesce(r->>'child_itemcode_1',r->>'child_itemcode_2',r->>'child_itemcode_3') is null
      or exists (
        select from (values (r->'child_itemcode_1'),(r->'child_itemcode_2'),(r->'child_itemcode_3')) child(code)
        where child.code is not null and child.code <> 'null'::jsonb and
          (jsonb_typeof(child.code)<>'string' or (child.code#>>'{}') !~ '^[^[:space:]*]{1,200}$')
      )
  ) then raise exception 'ITEM_BUILD_UP_INVALID_ROW'; end if;
  if (
    select count(*) from (
      select distinct * from jsonb_to_recordset(p_rows) as r(parent_itemcode text,child_itemcode_1 text,child_itemcode_2 text,child_itemcode_3 text)
    ) recipes
  ) <> input_count then raise exception 'ITEM_BUILD_UP_DUPLICATE_ROW'; end if;

  if p_preview then
    select count(*) into new_count
    from jsonb_to_recordset(p_rows) as r(parent_itemcode text,child_itemcode_1 text,child_itemcode_2 text,child_itemcode_3 text)
    where not exists (
      select 1 from public.item_build_up b
      where b.parent_itemcode=r.parent_itemcode
        and b.child_itemcode_1 is not distinct from r.child_itemcode_1
        and b.child_itemcode_2 is not distinct from r.child_itemcode_2
        and b.child_itemcode_3 is not distinct from r.child_itemcode_3
    );
  else
    with inserted as (
      insert into public.item_build_up(parent_itemcode,child_itemcode_1,child_itemcode_2,child_itemcode_3,created_by)
      select r.parent_itemcode,r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3,actor
      from jsonb_to_recordset(p_rows) as r(parent_itemcode text,child_itemcode_1 text,child_itemcode_2 text,child_itemcode_3 text)
      order by r.parent_itemcode,r.child_itemcode_1,r.child_itemcode_2,r.child_itemcode_3
      on conflict on constraint item_build_up_unique_recipe do nothing
      returning 1
    )
    select count(*) into new_count from inserted;
  end if;
  return jsonb_build_object('inserted',new_count,'unchanged',input_count-new_count);
end $$;

revoke all on function public.sync_warehouse_item_build_up(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.sync_warehouse_item_build_up(jsonb,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
