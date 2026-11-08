-- Backfill DISPATCHER ServicePlan grants for every existing organization.
--
-- The dedicated `ServicePlan` CASL subject ships with PR A; ADMIN reaches it via the code-level
-- "manage all", but DISPATCHER needs explicit role_permissions rows. Those rows were added to
-- DEFAULT_GRANTS (backend/src/lib/permissions/defaultGrants.ts) AFTER the prior backfills were
-- authored, so without this migration existing orgs' dispatchers would be Service-Plans-blind.
--
-- Mirrors the 20260602000000 INSERT skeleton. The canonical grant set lives in defaultGrants.ts;
-- this SQL must match it (pinned by backend/src/__tests__/permissions-service-plan-backfill.test.ts).
--
-- Grants (per defaultGrants.ts):
--   DISPATCHER -> read/create/update/delete ServicePlan
-- ADMIN has no rows (code-level "manage all"); SALES + TECHNICIAN get none (contracts are
-- managed by admin/dispatch only). conditions are NULL (no own-scope on ServicePlan).
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
  ('DISPATCHER','read','ServicePlan',NULL),
  ('DISPATCHER','create','ServicePlan',NULL),
  ('DISPATCHER','update','ServicePlan',NULL),
  ('DISPATCHER','delete','ServicePlan',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
