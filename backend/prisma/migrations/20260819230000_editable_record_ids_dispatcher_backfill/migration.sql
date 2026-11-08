-- Backfill the DISPATCHER `renumber` role default (Customer/Lead/Estimate/Job/Invoice) for every
-- existing organization.
--
-- Editable record IDs (2026-08-19 plan, decision #7): "Permission is a new sensitive role toggle.
-- ADMIN and DISPATCHER on by default." This PR only adds the permission plumbing for a
-- NOT-YET-BUILT capability - the PATCH .../:id/number endpoints ship in a later PR. ADMIN reaches
-- it automatically via the manage-all bypass (no row needed, no backfill needed). DISPATCHER
-- needs an explicit row, which was added to DEFAULT_GRANTS (backend/src/lib/permissions/
-- defaultGrants.ts) so NEW orgs seed it automatically; without this migration existing orgs'
-- dispatchers would not see the "Edit record ID numbers" sensitive toggle turned on until someone
-- manually re-saved the role.
--
-- Mirrors the 20260717120000_technician_pricebook_read_backfill skeleton (the canonical form for
-- a brand-new role default - no pre-split source rows to derive from). The canonical grant set
-- lives in defaultGrants.ts; this SQL must match it (pinned by
-- backend/src/__tests__/permissions-editable-record-ids-backfill.test.ts).
--
-- Portable (no Supabase-only objects) + idempotent via ON CONFLICT DO NOTHING - safe to re-run,
-- and safe on the shared staging DB.
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
  ('DISPATCHER','renumber','Customer',NULL),
  ('DISPATCHER','renumber','Lead',NULL),
  ('DISPATCHER','renumber','Estimate',NULL),
  ('DISPATCHER','renumber','Job',NULL),
  ('DISPATCHER','renumber','Invoice',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
