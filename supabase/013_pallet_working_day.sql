begin;

-- Working day follows Vietnam production time:
-- 06:00 of a calendar day through before 06:00 of the following day.
alter table public.pallet_data
  add column if not exists working_day date;

-- Backfill historical rows from created_at using Asia/Ho_Chi_Minh time.
update public.pallet_data
set working_day = (
  timezone('Asia/Ho_Chi_Minh', coalesce(created_at, now())) - interval '6 hours'
)::date
where working_day is null;

create or replace function public.set_pallet_working_day()
returns trigger
language plpgsql
set search_path = public
as $$
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
$$;

drop trigger if exists pallet_data_set_working_day on public.pallet_data;
create trigger pallet_data_set_working_day
before insert on public.pallet_data
for each row
execute function public.set_pallet_working_day();

alter table public.pallet_data
  alter column working_day set not null;

create index if not exists pallet_data_working_day_idx
  on public.pallet_data(working_day);

comment on column public.pallet_data.working_day is
  'Vietnam production working day: 06:00 local time to before 06:00 next day.';

commit;
