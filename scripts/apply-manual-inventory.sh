#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_migration="$task_root/supabase/migrations/20261026100000_post_manual_inventory.sql"

if ! command -v psql >/dev/null 2>&1; then
  printf '%s\n' 'Cần cài psql: sudo apt-get update && sudo apt-get install -y postgresql-client' >&2
  exit 1
fi

if [[ -z "${SVN_DATABASE_URL:-}" ]]; then
  read -r -s -p 'Dán Supabase Postgres connection string (Session pooler, port 5432): ' SVN_DATABASE_URL
  printf '\n'
fi
if [[ -z "$SVN_DATABASE_URL" ]]; then
  printf '%s\n' 'Chưa có connection string.' >&2
  exit 1
fi
trap 'unset SVN_DATABASE_URL' EXIT

# Run only the new migration. Existing SQL Editor migrations are prerequisites;
# do not reset, backfill, or modify Supabase migration history automatically.
PGDATABASE="$SVN_DATABASE_URL" PGSSLMODE=require psql -X -v ON_ERROR_STOP=1 \
  --file="$task_migration" \
  --command="select to_regprocedure('public.post_manual_inventory(uuid,jsonb)') as posting_rpc;"
