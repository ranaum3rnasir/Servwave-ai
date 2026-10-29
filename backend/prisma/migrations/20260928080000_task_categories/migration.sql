-- Task categories (visits-and-task-categories slice 08): one org-wide list of task categories,
-- and an optional category on every task.
--
-- PURE EXPAND. One new table, one new NULLABLE column on tasks, their indexes and FKs, the RLS
-- backstop, the starter rows and the read grant. Nothing is dropped or renamed, so the old
-- instance running during the deploy overlap never names anything that has gone; it simply does
-- not select the new column.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS, guarded, or ON CONFLICT / NOT EXISTS.
-- Plain DDL, no Supabase-only objects outside a pg_roles guard. Runs on CI's vanilla postgres:16,
-- on the Render deploy, and possibly twice against the shared staging DB.
--
-- RLS HAZARD, and why the first statement below exists. organizations, role_permissions and (from
-- this file on) task_categories all carry FORCE ROW LEVEL SECURITY, and FORCE binds the table OWNER
-- too. Applied by a role without BYPASSRLS, both backfills would read zero organizations and write
-- "INSERT 0 0" SILENTLY: a green _prisma_migrations ledger row, no starters in any org, and every
-- non-admin 403 on GET /api/task-categories. So the file turns on the tenant policy's own escape
-- hatch, app.bypass_rls (every tenant_isolation policy honours it, 20260703000100_tenant_rls),
-- TRANSACTION-LOCAL (set_config's third argument): it ends with this migration's transaction and
-- never reaches a pooled session. A green ledger row is still NOT evidence the rows landed; run
-- the verification query below after every apply.
--
-- LOCKS: ADD COLUMN on tasks takes ACCESS EXCLUSIVE on tasks and holds it to COMMIT, i.e. through
-- both backfills. lock_timeout (also transaction-local) makes the deploy fail fast and retryable
-- if a long-running query holds tasks, instead of queueing every task read behind it.
--
-- VERIFICATION QUERY (per org, never a global count; organization_id only, never an org name):
--
--   SELECT o.id AS organization_id,
--          (SELECT count(*) FROM task_categories t
--            WHERE t.organization_id = o.id
--              AND lower(t.name) IN ('follow-up', 'part order', 'internal')) AS starters,
--          (SELECT count(*) FROM role_permissions rt
--            WHERE rt.organization_id = o.id AND rt.action = 'read' AND rt.subject = 'Task'
--              AND rt.role <> 'ADMIN'
--              AND NOT EXISTS (SELECT 1 FROM role_permissions rc
--                               WHERE rc.organization_id = rt.organization_id AND rc.role = rt.role
--                                 AND rc.action = 'read' AND rc.subject = 'TaskCategory')) AS roles_missing_read
--   FROM organizations o
--   ORDER BY o.id;
--
-- Expected per org: starters = 3 (an org that already had a same-name category in another letter
-- case keeps its own row, still 3), roles_missing_read = 0.

SELECT set_config('app.bypass_rls', 'on', true);
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "task_categories" (
  "id"              UUID NOT NULL,
  "name"            TEXT NOT NULL,
  -- `#RRGGBB` from the Tags palette.
  "color"           TEXT NOT NULL,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "task_categories_pkey" PRIMARY KEY ("id")
);

-- Exact-match backstop. Names are unique per org CASE-INSENSITIVELY, which the API enforces (the
-- same split vendor_categories uses): an expression index on lower(name) is not something
-- schema.prisma can model, so `prisma migrate diff` would keep trying to drop it.
CREATE UNIQUE INDEX IF NOT EXISTS "task_categories_organization_id_name_key"
  ON "task_categories"("organization_id", "name");

-- Every read is "this org's list, in order".
CREATE INDEX IF NOT EXISTS "task_categories_organization_id_sort_order_idx"
  ON "task_categories"("organization_id", "sort_order");

DO $$ BEGIN
  ALTER TABLE "task_categories" ADD CONSTRAINT "task_categories_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- A task has at most one category and may have none. Removing a category CLEARS the reference; it
-- never cascades into the task.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "category_id" UUID;

CREATE INDEX IF NOT EXISTS "tasks_category_id_idx" ON "tasks"("category_id");

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "task_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls; 20260915130000_lost_reason_options for a table added after it).
-- rls-coverage.test.ts requires it of every table with an organization_id column.
ALTER TABLE "task_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "task_categories";
CREATE POLICY "tenant_isolation" ON "task_categories"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before this table
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.task_categories FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.task_categories FROM authenticated';
  END IF;
END $$;

-- The three starter categories, for every existing organization. New organizations get the same
-- three from STARTER_TASK_CATEGORIES in backend/src/lib/tasks/categories.ts, which this list must
-- match (pinned by task-categories-seed-db.test.ts). An existing category with the same name, in any
-- letter case, is left alone - so a re-run, or an org that already made its own "follow-up",
-- seeds nothing twice.
INSERT INTO "task_categories" ("id", "organization_id", "name", "color", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", s."name", s."color", s."sort_order", now(), now()
FROM "organizations" o
CROSS JOIN (VALUES
  ('Follow-up',  '#22C55E', 0),
  ('Part order', '#F97316', 1),
  ('Internal',   '#6B7280', 2)
) AS s("name", "color", "sort_order")
WHERE NOT EXISTS (
  SELECT 1 FROM "task_categories" t
  WHERE t."organization_id" = o."id" AND lower(t."name") = lower(s."name")
)
ON CONFLICT DO NOTHING;

-- `read TaskCategory` for every non-admin role in every existing organization. ADMIN reaches all
-- four actions through the manage-all bypass; create/update/delete have no default grant for any
-- other role (the Tag rename/delete precedent). Must match DEFAULT_GRANTS (defaultGrants.ts),
-- pinned by permissions-task-category.test.ts; the role_permissions drift gate checks the rest.
-- conditions stay NULL, as DEFAULT_GRANTS has them, so check-role-permission-drift --strict finds
-- no "changed" row. Two statements, both ON CONFLICT DO NOTHING (a row an admin already wrote is
-- kept as it is):
--   1. the three built-in roles, in every org, whatever else they hold;
--   2. every OTHER (organization_id, role) that already reads tasks. SRVW-138/139 custom roles
--      write their own key into role_permissions.role (the shape-not-name rule of
--      20260911120000_sales_purchasing_grants), so a literal role list would leave every custom
--      role that sees tasks unable to read the category list its tasks show. ADMIN is left out:
--      it reads through manage-all, and DEFAULT_GRANTS holds no ADMIN row to match.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT gen_random_uuid(), o.id, g.role, g.action, g.subject, g.conditions::jsonb, NOW(), NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('SALES','read','TaskCategory',NULL),
  ('DISPATCHER','read','TaskCategory',NULL),
  ('TECHNICIAN','read','TaskCategory',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT gen_random_uuid(), rp.organization_id, rp.role, 'read', 'TaskCategory', NULL, NOW(), NOW()
FROM (
  SELECT DISTINCT organization_id, role
  FROM role_permissions
  WHERE action = 'read' AND subject = 'Task' AND role <> 'ADMIN'
) AS rp
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
