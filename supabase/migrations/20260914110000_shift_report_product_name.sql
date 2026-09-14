alter table public.shift_report_data
  add column if not exists product_name text;

