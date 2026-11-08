-- Technician creator-control grants for EXISTING organizations.
--
-- Technician-ownership spec, Part C (PR 3): creation confers control. A technician gets full control
-- over the jobs they CREATED - read them, price them, re-crew them, delete them - permanently, even
-- after a dispatcher hands the work to someone else. defaultGrants.ts only seeds NEW organizations,
-- so every existing org needs the same rows written here.
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts; this SQL mirrors it, and
-- backend/src/__tests__/permissions-technician-creator-backfill.test.ts pins the two together so a
-- future edit to one without the other is a red test rather than a silent drift.
--
-- ⚠️ ORDER MATTERS AND IS NOT COSMETIC. Every statement gates on the org's TECHNICIAN `read Job` row
-- still carrying the STOCK own-job condition, which is how "this org never touched the role" is
-- expressed without hardcoding a role list. Statement 3 REWRITES that condition, so it must run
-- last - moving it earlier makes statements 1 and 2 match nothing.
--
-- WHAT THE GATE ACTUALLY CHECKS, stated precisely because it is easy to over-read: it inspects the
-- TECHNICIAN `read Job` row and nothing else. In practice that is a faithful proxy for "an admin has
-- edited this role", because the Roles editor writes one data-scope chip across a subject's
-- read/update/delete together - so re-scoping Jobs, or unticking Jobs View, moves this row too. It is
-- NOT a general "has anything about this role changed" test, and it would not notice an edit confined
-- to some other subject. Good enough on purpose: the failure direction is "this org keeps the old
-- behaviour and an admin re-runs the change deliberately", never "this org silently gained access
-- nobody asked for".
--
-- IDEMPOTENT: every write is guarded on the (organization_id, role, action, subject) unique or on
--   the row's pre-state, so a second run changes nothing. Safe to re-run against the shared staging
--   DB and safe if `prisma migrate deploy` replays it.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase roles, policies or auth.*.
--
-- gen_random_uuid()/NOW() are supplied explicitly because `id @default(uuid())` is a PRISMA-side
-- default and `updated_at @updatedAt` has no DB default at all - raw SQL must fill both in.

-- ── 1. New TECHNICIAN grants, org-wide (no row condition) ────────────────────────────────────────
-- `read Pricing`   - prices, totals, job cost and margin. A technician who can price the lines on a
--                    job they created has to be able to see what those lines cost and sell for, and
--                    all of it rides this one grant (canSeePricing, lib/permissions/enforce.ts).
-- `create Job`     - was a per-user toggle, now a role default. The creator is auto-assigned by
--                    job.controller.create, so a technician's own new job is workable immediately.
-- `create Estimate`- standalone estimates only. Attaching one to an existing job is not a route
--                    (estimates carry no job_id); it lands on PATCH /api/jobs/:id's field-level
--                    manage_lines check instead.
-- `create` is structurally unconditionable in CASL (there is no row yet), so NULL is correct there
-- rather than merely convenient.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT gen_random_uuid(), rp.organization_id, 'TECHNICIAN', v.action, v.subject, NULL, NOW(), NOW()
FROM role_permissions rp
CROSS JOIN (VALUES
  ('read',   'Pricing'),
  ('create', 'Job'),
  ('create', 'Estimate')
) AS v(action, subject)
WHERE rp.role = 'TECHNICIAN'
  AND rp.action = 'read'
  AND rp.subject = 'Job'
  AND rp.conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

-- ── 2. The control surface: assign / unassign / delete Job, scoped to the creator ────────────────
-- "They can take people off the job" (assign/unassign) and Ran's explicit call on delete. `delete`
-- stays bounded by the pre-existing integrity rule: a job carrying ANY invoice, voided included,
-- cannot be deleted at all. Enforced per-instance by canActOnRow, which intersects this condition
-- with the read scope - the subject-level route guard cannot tell these rows apart.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  'TECHNICIAN',
  v.action,
  'Job',
  '{"created_by_id":"{{userId}}"}'::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
CROSS JOIN (VALUES ('assign'), ('unassign'), ('delete')) AS v(action)
WHERE rp.role = 'TECHNICIAN'
  AND rp.action = 'read'
  AND rp.subject = 'Job'
  AND rp.conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

-- ── 3. Re-point `manage_lines Job` at the creator ────────────────────────────────────────────────
-- 20260805130000 wrote this row own-job-scoped, copied off `update Job`, purely so that PR's split
-- changed nobody's access. This is the re-point that split existed for: money follows CREATION, not
-- assignment.
--
-- UPSERT, not a bare UPDATE. 20260805130000 DERIVED its rows from each org's `update Job` rows, so an
-- org whose TECHNICIAN role had no `update Job` (an admin unticked Jobs Edit) received no
-- `manage_lines Job` row at all - and a plain UPDATE would find nothing to re-point, leaving that
-- org's technicians unable to manage lines on jobs they created themselves. Fail-closed, but silently
-- and for no reason anyone chose.
--
-- The ON CONFLICT arm carries the same honesty guard the UPDATE had: it only overwrites a row still
-- holding the stock own-job condition, so a row an admin has since re-scoped is left alone. Both arms
-- are no-ops on a replay (the row exists, and its condition is no longer the own-job one).
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  'TECHNICIAN',
  'manage_lines',
  'Job',
  '{"created_by_id":"{{userId}}"}'::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.role = 'TECHNICIAN'
  AND rp.action = 'read'
  AND rp.subject = 'Job'
  AND rp.conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO UPDATE
  SET conditions = EXCLUDED.conditions, updated_at = NOW()
  WHERE role_permissions.conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb;

-- ── 4. Widen `read Job` to assigned-OR-created (LAST - it is the gate every statement above uses) ─
-- Without this the creator surface is unreachable: canActOnRow intersects each verb's scope with the
-- read scope, so an unassigned creator who cannot SEE the job cannot act on it either.
UPDATE role_permissions
SET conditions = '{"OR":[{"assignees":{"some":{"user_id":"{{userId}}"}}},{"created_by_id":"{{userId}}"}]}'::jsonb,
    updated_at = NOW()
WHERE role = 'TECHNICIAN'
  AND action = 'read'
  AND subject = 'Job'
  AND conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb;
