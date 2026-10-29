-- Backfill Task grants for every existing organization.
--
-- The dedicated `Task` CASL subject ships with the tasks-db-backed branch; ADMIN reaches it via
-- the code-level "manage all", but SALES / DISPATCHER / TECHNICIAN need explicit role_permissions
-- rows. Those rows were added to DEFAULT_GRANTS (backend/src/lib/permissions/defaultGrants.ts)
-- but without this migration existing orgs' non-admin users would receive 403 on task endpoints.
--
-- Mirrors the 20260609120300 INSERT skeleton (service_plan_grants backfill).
-- The canonical grant set lives in defaultGrants.ts; this SQL must match it
-- (pinned by backend/src/__tests__/permissions-task-grants-backfill.test.ts).
--
-- Grants (per defaultGrants.ts):
--   SALES      -> read / create / update / delete   Task
--   DISPATCHER -> read / create / update / delete   Task
--   TECHNICIAN -> read / create / update            Task  (NO delete -- by design)
-- ADMIN has no rows (code-level "manage all"). conditions are NULL (no own-scope on Task).
--
-- Idempotent via ON CONFLICT DO NOTHING -- safe to re-run, and safe on the shared staging DB.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  g.role,
  g.action,
  g.subject,
  g.conditions::jsonb,
  NOW(),
  NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('SALES','read','Task',NULL),
  ('SALES','create','Task',NULL),
  ('SALES','update','Task',NULL),
  ('SALES','delete','Task',NULL),
  ('DISPATCHER','read','Task',NULL),
  ('DISPATCHER','create','Task',NULL),
  ('DISPATCHER','update','Task',NULL),
  ('DISPATCHER','delete','Task',NULL),
  ('TECHNICIAN','read','Task',NULL),
  ('TECHNICIAN','create','Task',NULL),
  ('TECHNICIAN','update','Task',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
