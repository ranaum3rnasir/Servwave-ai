#!/usr/bin/env bash
# =============================================================================================
# visits-task-categories-migration-check.sh - post-deploy check for the task categories migration
#
# WHAT IT CHECKS
#   20260928080000_task_categories (plus the three ADD VALUE migrations that ship with it) must have
#   WRITTEN rows, not just recorded a ledger entry: every organization holds the three starter task
#   categories (Follow-up, Part order, Internal), every organization's SALES, DISPATCHER and
#   TECHNICIAN roles hold `read TaskCategory`, the AttachmentEntity TASK and the TASK_COMPLETED /
#   TASK_CANCELLED automation trigger values exist, and tasks.category_id exists.
#
#   Why the ledger is not enough: task_categories and role_permissions carry FORCE ROW LEVEL
#   SECURITY, so a role that does not bypass RLS applying the migration gets "INSERT 0 0" and a
#   green `_prisma_migrations` row. This counts the rows instead.
#
# HOW TO RUN IT (read-only, after the deploy has applied the migrations)
#   cd backend
#   ./scripts/checks/visits-task-categories-migration-check.sh "$DATABASE_URL"
#
#   - Pass the database URL as the only argument; take it from your environment or secret store.
#     Nothing here hard-codes a host, and the URL is never printed.
#   - Needs `psql` on the PATH. Everything runs inside `BEGIN READ ONLY`, so it cannot write; the
#     only setting it touches is the transaction-local `app.bypass_rls`, which lets a reader that
#     does not bypass RLS count across every organization through the tenant_isolation policies.
#   - Output names organizations by id only, never by name.
#   - Exit 0 and "PASS" when everything is in place; exit 1 and "FAIL", plus the ids of any
#     organization missing starters or grants, otherwise. A psql error (for example the schema is
#     not migrated yet) is also a FAIL.
#   - Run it right after the deploy. Later, an admin may rename or delete a starter category,
#     which this would then report as missing: that is the admin's choice, not a failed migration.
# =============================================================================================
set -euo pipefail
DB_URL="${1:?usage: visits-task-categories-migration-check.sh <DATABASE_URL>}"
out=$(psql "$DB_URL" -X -v ON_ERROR_STOP=1 -tA -F '|' <<'SQL'
BEGIN READ ONLY;
-- transaction-local: lets a NOBYPASSRLS reader see every org through tenant_isolation
SELECT set_config('app.bypass_rls', 'on', true) \g /dev/null
WITH orgs AS (SELECT id FROM organizations),
cats AS (
  SELECT o.id AS org, count(DISTINCT lower(tc.name)) FILTER (
           WHERE lower(tc.name) IN ('follow-up','part order','internal')) AS starter
  FROM orgs o LEFT JOIN task_categories tc ON tc.organization_id = o.id GROUP BY o.id),
grants AS (
  SELECT o.id AS org, count(DISTINCT rp.role) AS roles
  FROM orgs o LEFT JOIN role_permissions rp
    ON rp.organization_id = o.id AND rp.action = 'read' AND rp.subject = 'TaskCategory'
   AND rp.role IN ('SALES','DISPATCHER','TECHNICIAN')
  GROUP BY o.id)
SELECT
  (SELECT count(*) FROM orgs),
  (SELECT count(*) FROM task_categories),
  (SELECT count(*) FROM role_permissions WHERE action='read' AND subject='TaskCategory'
     AND role IN ('SALES','DISPATCHER','TECHNICIAN')),
  (SELECT count(*) FROM cats WHERE starter < 3),
  (SELECT count(*) FROM grants WHERE roles < 3),
  (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE (t.typname = 'AttachmentEntity' AND e.enumlabel = 'TASK')
        OR (t.typname = 'AutomationTriggerType' AND e.enumlabel IN ('TASK_COMPLETED','TASK_CANCELLED'))),
  (SELECT count(*) FROM information_schema.columns WHERE table_name='tasks' AND column_name='category_id'),
  (SELECT coalesce(string_agg(org::text, ',' ORDER BY org), '') FROM cats WHERE starter < 3),
  (SELECT coalesce(string_agg(org::text, ',' ORDER BY org), '') FROM grants WHERE roles < 3);
COMMIT;
SQL
) || { echo "psql error (schema not migrated?)"; echo FAIL; exit 1; }
row=$(printf '%s\n' "$out" | grep '|' | tail -1)
IFS='|' read -r orgs cats grants orgs_missing_cats orgs_missing_grants enum_vals col bad_cat_orgs bad_grant_orgs <<<"$row"
echo "orgs=$orgs task_categories=$cats read_TaskCategory_rows=$grants orgs_missing_starters=$orgs_missing_cats orgs_missing_grants=$orgs_missing_grants enum_values=$enum_vals/3 tasks.category_id=$col"
if [ "$orgs" -gt 0 ] && [ "$cats" -gt 0 ] && [ "$grants" -gt 0 ] && [ "$orgs_missing_cats" -eq 0 ] \
   && [ "$orgs_missing_grants" -eq 0 ] && [ "$enum_vals" -eq 3 ] && [ "$col" -eq 1 ]; then
  echo PASS; exit 0
fi
[ -n "$bad_cat_orgs" ] && echo "orgs missing starter categories: $bad_cat_orgs"
[ -n "$bad_grant_orgs" ] && echo "orgs missing read TaskCategory grants: $bad_grant_orgs"
echo FAIL; exit 1
