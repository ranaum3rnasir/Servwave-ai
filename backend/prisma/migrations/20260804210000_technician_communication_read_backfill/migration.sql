-- Grant TECHNICIAN `read Communication` in every existing organization.
--
-- Verified against the live staging DB before this slice: TECHNICIAN held
-- `create Communication` in 9 orgs and `read Communication` in ZERO. So the
-- product rule that a communication row is visible to whoever can see the entity
-- it hangs off was inert for the role it most exists for - a technician could
-- write to a conversation and never read one.
--
-- The grant is UNCONDITIONAL at the subject level, exactly as SALES holds it. A
-- condition here would be inert: `Communication` is not a member of the
-- ScopeResource union (backend/src/lib/permissions/scopeWhereFor.ts), so no
-- grant-driven row scope exists for comm rows and scopeWhereFor would never read
-- it. The row scope comes from lib/permissions/anchorVisibility.ts, which rides
-- the Job and Lead grants the technician already holds (both OWN-scoped).
--
-- ⚠️ THIS GRANT IS ONLY SAFE BECAUSE OF THAT ROW FILTER. Applied without it,
-- every technician sees every conversation in the org. Do not cherry-pick this
-- migration ahead of the code.
--
-- Canonical grant set lives in defaultGrants.ts; this SQL mirrors it (pinned by
-- backend/src/__tests__/permissions-technician-communication-backfill.test.ts).
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on the (organization_id, role, action,
--   subject) unique - safe to re-run against the shared staging DB.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'TECHNICIAN',
  'read',
  'Communication',
  NULL,
  NOW(),
  NOW()
FROM organizations o
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
