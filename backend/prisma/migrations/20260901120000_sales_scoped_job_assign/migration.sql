-- Sales-Role QA row 020 - a salesperson may first-book and crew the job their OWN lead's estimate
-- produced. Ran's ruling, 2026-09-01: "a salesperson doing their own walkthrough is not a
-- one-person crew."
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts (which seeds NEW orgs);
-- backend/src/__tests__/permissions-sales-job-assign-backfill.test.ts pins the two together, so
-- editing one without the other is a red test rather than silent drift.
--
-- ── PART 1: THE GRANT ──────────────────────────────────────────────────────────────────────────
-- ONE verb. The booking dialog posts to POST /:id/assign, route-gated `assign Job`, and that door
-- first-books the schedule AND sets the crew in one call - so `assign` alone is the whole
-- capability. `update Job` was in an earlier draft of this migration and was removed on purpose:
-- `manage_lines Job` is pinned to mirror `update Job` role-for-role and condition-for-condition
-- (permissions-job-manage-lines.test.ts), so granting it would have handed a rep the job's LINE
-- ITEMS, and POST /:id/notes rides the same gate. Neither was decided; neither is needed.
--
-- WHY THE GATE IS A SHAPE, NOT A ROLE NAME. Same reasoning as
-- 20260831120000_assign_others_grant_backfill: SRVW-138/139 custom roles write their `key` into
-- role_permissions.role, so a role cloned from SALES is invisible to a hardcoded 'SALES'. The honest
-- proxy for "is row-scoped to the leads they own" is the OWN_JOB_VIA_ESTIMATE read row itself, and
-- its condition is copied across verbatim so the new verb can never out-scope the read it rides on.
--
-- WHAT THIS ROW DOES NOT SAY. It says WHICH JOBS. Whose NAMES may go on the crew is `assign User`
-- (slice 1), which SALES pointedly does not hold - so the intersection is exactly the ruling: a rep
-- may put themselves, and only themselves, on their own job. Note that slice 1's own backfill
-- DERIVES `assign User` from `assign Job`, which this migration is about to give SALES. Ordering
-- saves us on a fresh DB (20260831120000 < 20260901120000, so slice 1 runs while SALES still has no
-- `assign Job`), and the test file pins the exception so a re-derivation cannot widen it silently.
--
-- ── PART 2: THE CORRECTION ─────────────────────────────────────────────────────────────────────
-- Read-only pre-flight, 2026-09-01, both DBs. Staging is clean: 9 orgs, `read` only. PRODUCTION is
-- not - the 11111111-... tenant holds SALES rows for `create`, `update` and `delete` on Job, all
-- UNCONDITIONAL (org-wide, every job), all written within 18ms of each other on 2026-08-12 by a
-- single Roles-editor save. None of the three is in defaultGrants.ts.
--
-- Ran's call, 2026-09-01: bring that tenant in line rather than document a permanent divergence.
-- All three are removed. `update` is DELETED rather than re-scoped because the final shape of this
-- change grants SALES no `update Job` at all (see Part 1) - re-scoping it would have left one org
-- holding a verb the defaults do not give, which is the divergence this is meant to end. This
-- NARROWS what 4 active users can do, and that is intended.
--
-- The delete is gated on the same derived role set as the insert, not on the name 'SALES'. Verified
-- read-only on both DBs: no role other than SALES holds the OWN_JOB_VIA_ESTIMATE read shape, so the
-- derived set is exactly SALES in 5 production and 9 staging orgs.
--
-- EXPECTED EFFECT, measured read-only 2026-09-01 (count these after deploying, per-org, not on the
-- totals - a partial apply shows up nowhere else):
--   production: +5 assign rows across 5 orgs; -3 rows (11111111-... create/update/delete)
--   staging:    +9 assign rows across 9 orgs; -0 rows
--
-- IDEMPOTENT: the insert has ON CONFLICT DO NOTHING; the delete is a no-op once the rows are gone.
-- Safe to re-run, safe on the shared staging DB, safe if `prisma migrate deploy` replays it.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase roles, policies or auth.*.
-- gen_random_uuid()/NOW() are supplied explicitly: `id @default(uuid())` is a PRISMA-side default
-- and `updated_at @updatedAt` has no DB default at all, so raw SQL must fill both in.

-- Part 1 - grant `assign`, carrying the read row's own condition.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  'assign',
  'Job',
  rp.conditions,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.subject = 'Job'
  AND rp.action  = 'read'
  AND rp.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

-- Part 2 - remove the create/update/delete over-grant from that same derived set. None of the three
-- is in defaultGrants.ts, and `delete` unconditional is the widest of them.
DELETE FROM role_permissions target
USING role_permissions src
WHERE src.organization_id = target.organization_id
  AND src.role            = target.role
  AND src.subject         = 'Job'
  AND src.action          = 'read'
  AND src.conditions      = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
  AND target.subject      = 'Job'
  AND target.action       IN ('create', 'update', 'delete');
