#!/usr/bin/env bash
# =============================================================================================
# record-contact-entries-migration-check.sh - post-deploy check for 20261012130000_record_contact_entries
#
# WHAT IT CHECKS
#   The migration must have BUILT the table, not just recorded a ledger entry: record_contact_entries
#   exists with its 20 columns, its three indexes, its six foreign keys and three CHECK constraints
#   (exactly one of job or lead; kind; intent), row-level security is enabled AND forced with the
#   tenant_isolation policy, and the table can be read (a count runs).
#
#   Why the ledger is not enough: a row-level-security setting can no-op a migration under a green
#   `_prisma_migrations` row. This counts the objects themselves.
#
# HOW TO RUN IT (read-only, after the deploy has applied the migration)
#   cd backend
#   ./scripts/checks/record-contact-entries-migration-check.sh "$DATABASE_URL"
#
#   - Pass the database URL as the only argument; it is never printed. Needs `psql` on the PATH.
#   - Everything runs inside `BEGIN READ ONLY`; the only setting touched is the transaction-local
#     `app.bypass_rls`, so a reader that does not bypass RLS can count across every organization.
#   - Exit 0 and "PASS" when everything is in place; exit 1 and "FAIL" otherwise.
# =============================================================================================
set -euo pipefail
DB_URL="${1:?usage: record-contact-entries-migration-check.sh <DATABASE_URL>}"
out=$(psql "$DB_URL" -X -v ON_ERROR_STOP=1 -tA -F '|' <<'SQL'
BEGIN READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true) \g /dev/null
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='record_contact_entries'),
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='record_contact_entries'
     AND indexname IN ('record_contact_entries_organization_id_idx','record_contact_entries_job_id_idx','record_contact_entries_lead_id_idx')),
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.record_contact_entries'::regclass AND contype = 'f'),
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.record_contact_entries'::regclass AND contype = 'c'),
  (SELECT count(*) FROM pg_class WHERE oid = 'public.record_contact_entries'::regclass AND relrowsecurity AND relforcerowsecurity),
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='record_contact_entries' AND policyname='tenant_isolation'),
  (SELECT count(*) FROM record_contact_entries);
COMMIT;
SQL
) || { echo "psql error (table missing, schema not migrated?)"; echo FAIL; exit 1; }
row=$(printf '%s\n' "$out" | grep '|' | tail -1)
IFS='|' read -r cols idx fks checks rls policy rows <<<"$row"
echo "columns=$cols/20 indexes=$idx/3 foreign_keys=$fks/6 checks=$checks/3 rls_enabled_and_forced=$rls policy=$policy rows=$rows"
if [ "$cols" -eq 20 ] && [ "$idx" -eq 3 ] && [ "$fks" -eq 6 ] && [ "$checks" -eq 3 ] && [ "$rls" -eq 1 ] && [ "$policy" -eq 1 ]; then
  echo PASS; exit 0
fi
echo FAIL; exit 1
