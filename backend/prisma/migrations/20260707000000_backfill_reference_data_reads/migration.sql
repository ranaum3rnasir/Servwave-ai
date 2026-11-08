-- Backfill drift fix: role_permissions is seeded per-org from DEFAULT_GRANTS
-- (backend/src/lib/permissions/defaultGrants.ts) only once, by the
-- 20260528204625_add_role_permissions migration. Grants added to
-- DEFAULT_GRANTS after that snapshot never reach orgs created before the
-- addition (a new grant only lands via the admin "Reset to defaults" action
-- in role.controller.ts, one role/org at a time).
--
-- `read StateTaxRate` (+ its `read Organization` / `read AppSetting`
-- fallback deps, used by EstimateFormPage to pre-populate "Tax Rate (by
-- State)") is one such drifted grant for SALES/DISPATCHER/TECHNICIAN —
-- reported as GitHub #527/#428 (dropdown present but nothing selectable).
-- This backfills just those three unconditioned reference-data reads for
-- every existing org. Idempotent via ON CONFLICT DO NOTHING; portable
-- (plain INSERT/SELECT, no Supabase-specific roles).
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  g.role,
  g.action,
  g.subject,
  NULL,
  NOW(),
  NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('SALES','read','StateTaxRate'),
  ('SALES','read','Organization'),
  ('SALES','read','AppSetting'),
  ('DISPATCHER','read','StateTaxRate'),
  ('DISPATCHER','read','Organization'),
  ('DISPATCHER','read','AppSetting'),
  ('TECHNICIAN','read','StateTaxRate'),
  ('TECHNICIAN','read','Organization'),
  ('TECHNICIAN','read','AppSetting')
) AS g(role, action, subject)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
