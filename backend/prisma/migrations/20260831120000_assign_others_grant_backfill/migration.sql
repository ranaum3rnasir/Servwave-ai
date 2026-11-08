-- Backfill the `assign User` grant - "may name somebody other than themselves on a piece of work"
-- - for every role in every existing organization that can already crew a job today.
--
-- Scoped assignee pool, slice 1 (plan: md_files/plans/permissions/2026-08-31-assignee-pool/,
-- PRD: upstream #1938). This PR ships permission plumbing AHEAD of the capability that
-- reads it: NOTHING calls `can('assign','User')` yet (slice 2 adds the crew/performer validators).
-- Shipping it alone is the point - the backfill is the only part of this plan whose failure mode
-- is SILENT and INVERTED, so it gets to be the only thing in the diff and can be counted in
-- production before any behaviour hangs off it.
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts (which seeds NEW orgs);
-- backend/src/__tests__/permissions-assign-others-backfill.test.ts pins the two together so
-- editing one without the other is a red test rather than silent drift.
--
-- ── WHY THE GATE IS `assign Job` AND NOT A ROLE NAME ────────────────────────────────────────────
-- The calendar-entry backfill (20260824180000) could CROSS JOIN organizations and hardcode
-- 'DISPATCHER', because it shipped a capability nobody had. This one is the opposite: `assign User`
-- describes something DISPATCHER and TECHNICIAN can ALREADY do, and slice 2 turns the grant into
-- the thing that permits it. Any holder this misses is silently demoted the day slice 2 lands, and
-- the symptom - "the picker won't let me add my colleague" - is indistinguishable from the bug this
-- whole plan sets out to fix.
--
-- A hardcoded role list misses exactly one population, and it is not a hypothetical: SRVW-138/139
-- custom roles write their `key` into THIS column (see 20260806120000_custom_roles), and a custom
-- role cloned from DISPATCHER holds a full copy of its grants under that key. Gating on the grant
-- instead of the name covers them without enumerating anything.
--
-- `assign Job` is the honest proxy for "can put people on work today": it is what job.controller's
-- crew door checks, and it is OUTSIDE MANAGED_KEYS (role.controller.ts) - the Roles editor cannot
-- represent it, so it never strips it. A role holding it has it because someone meant to.
--
-- SALES is excluded by construction rather than by name: no SALES row anywhere holds `assign Job`
-- (defaultGrants.ts grants SALES only `read Job`, via OWN_JOB_VIA_ESTIMATE). That is Ran's ruling -
-- a salesperson is the performer on their own lead and does not name other people - and it stays
-- true for a custom role too: one cloned from SALES has no `assign Job` to match on.
--
-- The row's own condition is NOT copied across. `assign Job` is CREATED_BY_ME-scoped for
-- TECHNICIAN and unconditional for DISPATCHER; `assign User` is unconditional for BOTH, and that is
-- not a widening. `User` is not a ScopeResource (lib/permissions/scopeWhereFor.ts), so a condition
-- here would be inert AND misleading. The two grants compose per-instance: `assign Job` still says
-- WHICH jobs, this says WHOSE NAMES.
--
-- IDEMPOTENT via the (organization_id, role, action, subject) unique + ON CONFLICT DO NOTHING -
-- safe to re-run, safe on the shared staging DB, safe if `prisma migrate deploy` replays it.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase roles, policies or auth.*.
--
-- ROLE-LEVEL ONLY, and that is complete rather than a gap. This writes `role_permissions`, so it
-- structurally cannot carry over crewing that came from a PER-USER override - but nothing can have.
-- `USER_CAPABILITIES` (lib/permissions/userCapabilities.ts) carries no `assign Job` entry, so no
-- override can grant crewing in the first place; every crew door runs `canActOnRow(..., 'assign')`
-- against the role grant. Verified read-only on both DBs 2026-08-31.
--
-- gen_random_uuid()/NOW() are supplied explicitly because `id @default(uuid())` is a PRISMA-side
-- default and `updated_at @updatedAt` has no DB default at all - raw SQL must fill both in.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
-- No DISTINCT and none is needed: role_permissions is unique on
-- (organization_id, role, action, subject), so the WHERE below matches AT MOST ONE row per
-- (org, role) and the source set is already distinct. (A DISTINCT here would also be a lie -
-- gen_random_uuid() is volatile, so every projected row differs regardless.)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  'assign',
  'User',
  NULL::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.action = 'assign'
  AND rp.subject = 'Job'
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
