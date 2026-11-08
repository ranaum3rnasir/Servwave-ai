-- Backfill `manage_lines Job` for EXISTING organizations and EXISTING per-user overrides.
--
-- Technician-ownership spec, Part C (PR 2): `manage_lines Job` is split out of `update Job`,
-- which until now was the single gate over job line items, scopes of work, notes, tags and the
-- job's own tax/discount fields. The route + controller changes that ship with this migration
-- move line items, scopes and the money fields onto the new action.
--
-- This PR must be BEHAVIOUR-NEUTRAL: nobody's effective access may change. defaultGrants.ts only
-- seeds NEW organizations, so every existing org needs its rows copied here, and the copy must be
-- DERIVED from the org's own `update Job` rows rather than from a hardcoded role list - an admin
-- may have edited the role in the Roles UI, and an org that deliberately took `update Job` away
-- from a role must NOT be handed line-item access by this migration.
--
-- Both grant paths are mirrored:
--   1. role_permissions        - the per-org role grants (conditions copied VERBATIM, so a
--                                TECHNICIAN's own-job scope stays own-job scoped; writing NULL
--                                here would hand every technician every job's line items).
--   2. user_permission_overrides - the per-user toggles. BOTH effects are copied, not just
--                                'allow': an admin who switched "Edit own jobs" OFF for one user
--                                is relying on that user not reaching line items, and mirroring
--                                only the allow rows would silently hand the gate back to them.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on each table's unique - safe to re-run against the shared
--   staging DB, and safe if a later `prisma migrate deploy` replays it.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only roles, policies or auth.*.
--
-- gen_random_uuid()/NOW() are supplied explicitly because `id @default(uuid())` is a PRISMA-side
-- default and `updated_at @updatedAt` has no DB default at all - raw SQL must fill both in.

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  'manage_lines',
  'Job',
  rp.conditions,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.action = 'update'
  AND rp.subject = 'Job'
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

INSERT INTO user_permission_overrides (id, organization_id, user_id, action, subject, effect, created_at, updated_at)
SELECT
  gen_random_uuid(),
  upo.organization_id,
  upo.user_id,
  'manage_lines',
  'Job',
  upo.effect,
  NOW(),
  NOW()
FROM user_permission_overrides upo
WHERE upo.action = 'update'
  AND upo.subject = 'Job'
ON CONFLICT (user_id, action, subject) DO NOTHING;
