-- Backfill Inventory + Communication grants for every existing organization (B1).
--
-- Root cause: the SALES (defaultGrants.ts:50-51) and DISPATCHER (defaultGrants.ts:102-109)
-- module grants were added to DEFAULT_GRANTS AFTER 20260528204625_add_role_permissions
-- was authored, so no migration ever wrote them. Non-admins were module-blind.
--
-- This mirrors 20260528204625's INSERT skeleton. The canonical grant set lives in
-- backend/src/lib/permissions/defaultGrants.ts; this SQL must match it (pinned by
-- backend/src/__tests__/permissions-emanuel-modules.test.ts).
--
-- Grants (per defaultGrants.ts, post-DEC7/D7):
--   SALES      -> read Inventory, read Communication
--   DISPATCHER -> read/create/update/delete Inventory, read/create/update/delete Communication
--   TECHNICIAN -> (none -- dropped per design decision DEC7/D7; techs use /tech/* only)
-- ADMIN has no rows (code-level "manage all").
-- NOTE: the TECHNICIAN on-site-payment grant (record_payment Invoice via job ownership)
-- is a CORE-pipeline grant from the original 20260528204625 backfill, unrelated to these
-- module subjects; it is untouched by this migration.
--
-- conditions are NULL for all rows (none of these grants are own-scoped).
-- Idempotent via ON CONFLICT DO NOTHING -- safe to re-run, and safe for any org whose
-- Inventory/Communication grants were already created by another path.
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
  -- SALES
  ('SALES','read','Inventory',NULL),
  ('SALES','read','Communication',NULL),
  -- DISPATCHER
  ('DISPATCHER','read','Inventory',NULL),
  ('DISPATCHER','create','Inventory',NULL),
  ('DISPATCHER','update','Inventory',NULL),
  ('DISPATCHER','delete','Inventory',NULL),
  ('DISPATCHER','read','Communication',NULL),
  ('DISPATCHER','create','Communication',NULL),
  ('DISPATCHER','update','Communication',NULL),
  ('DISPATCHER','delete','Communication',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
