-- Technician `read Estimate` backfill for EXISTING organizations.
--
-- Found in live QA the same day as 20260805150000_technician_creator_control_grants: that
-- migration granted TECHNICIAN `create Estimate` but wrote no matching `read Estimate` of any
-- kind, so a technician who raised a standalone estimate could not see it afterwards - the
-- list/detail scope resolved to MATCH_NOTHING (no read grant at all).
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts; this SQL mirrors it, and
-- backend/src/__tests__/permissions-technician-estimate-read-backfill.test.ts pins the two
-- together so a future edit to one without the other is a red test rather than a silent drift.
--
-- SCOPE: gates on the org's TECHNICIAN `read Job` row already carrying the WIDENED
-- (assigned-OR-created) condition that 20260805150000's own last statement writes. That is a
-- precise proxy for "this org received the full 20260805150000 backfill" - an org it skipped
-- (Neon Services: no TECHNICIAN `read Job` row to match against) never got widened, so it is
-- skipped here too, with zero org ids hardcoded and matching the standing decision to leave that
-- org alone.
--
-- IDEMPOTENT: guarded on the (organization_id, role, action, subject) unique, so a second run
--   changes nothing. Safe to re-run against the shared staging DB and safe if `prisma migrate
--   deploy` replays it.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase roles, policies or auth.*.
--
-- gen_random_uuid()/NOW() are supplied explicitly because `id @default(uuid())` is a PRISMA-side
-- default and `updated_at @updatedAt` has no DB default at all - raw SQL must fill both in.

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  'TECHNICIAN',
  'read',
  'Estimate',
  '{"OR":[{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}},{"AND":[{"lead_id":null},{"created_by":"{{userId}}"}]}]}'::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.role = 'TECHNICIAN'
  AND rp.action = 'read'
  AND rp.subject = 'Job'
  AND rp.conditions = '{"OR":[{"assignees":{"some":{"user_id":"{{userId}}"}}},{"created_by_id":"{{userId}}"}]}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
