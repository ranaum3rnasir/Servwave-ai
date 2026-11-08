-- Multi-visit spec slice S8 §4 (D14(i), decision A2+) - the BACKWARD-LOOKING duration span.
-- Spec: md_files/specs/scheduling/2026-08-17-multi-visit.md.
--
-- THIS MIGRATION ADDS COLUMNS ONLY. It does not touch Job.scheduled_start / scheduled_end /
-- is_all_day (the FORWARD-looking mirror) or en_route_at / on_site_at (the two dead milestone
-- stamps) - those three drops are S8's own later slice, and 20260820120000_visit_teardown_
-- multi_visit_s8's header explains why a migration that drops a column live code still selects
-- takes the app down at deploy. That migration also numbered its sections 1, 5 and 6 and left a
-- visible gap at 2-4 for exactly this file. This is that gap, minus the drops - see "WHAT THIS
-- FILE DOES NOT CARRY" below.
--
-- PORTABLE: vanilla postgres:16 runs this unchanged. No Supabase-only roles, no auth.*, no
-- extensions, no SECURITY DEFINER.
--
-- IDEMPOTENT: every ADD COLUMN is guarded with IF NOT EXISTS, the index with IF NOT EXISTS, and
-- the backfill's UPDATE only touches rows where all three new columns are still NULL - a row the
-- backfill already repaired stops matching, so a second application (the shared staging DB, or a
-- CI run) is a no-op. See the backfill's own comment for why "all three NULL" is the right guard
-- rather than "any one NULL".
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE CARRIES, AND WHAT IT DOES NOT.
--
-- Carries: three new nullable columns on `jobs`, an index on the one that becomes a sort key, and
-- a one-time backfill computed from the existing `visits` table.
--
-- Does NOT carry: the DROP of the forward-looking mirror or the two dead milestone stamps. Their
-- readers (JOB_SORT_FIELDS in this same PR is one; the dashboard date windows, search's schedule
-- range, and the two automation sweeps are NOT repointed by this PR) still read
-- Job.scheduled_start directly, so dropping it here would break them before their own PRs land.
-- That DROP is a separate, later migration - tracked as its own slice, not this one.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SEMANTICS (A2+, RATIFIED) - restated here because a migration file outlives the decision doc
-- that argued for it, and the three names alone invite the wrong reading.
--
--   first_visit_start       = MIN(visits.scheduled_at)   over NON-CANCELLED visits   [PLANNED]
--   last_visit_end          = MAX(visits.scheduled_end)  over NON-CANCELLED visits   [PLANNED]
--   last_visit_completed_at = MAX(visits.completed_at)   over NON-CANCELLED visits   [ACTUAL]
--
-- The ACTUAL start already exists under a different name: syncJobFromVisits' mirrorMilestone
-- ('started_at') (walkthrough.service.ts) already writes jobs.started_at = the earliest ACTUAL
-- visit start over non-cancelled visits. So the two spans this slice makes readable are:
--     ACTUAL  span = jobs.started_at        -> jobs.last_visit_completed_at
--     PLANNED span = jobs.first_visit_start -> jobs.last_visit_end
-- last_visit_end is a PLANNED-window bound (set the moment a visit is booked, whatever its
-- status) and must not be confused with last_visit_completed_at, the only ACTUAL stamp of the
-- three - see the column comments in schema.prisma, which say the same thing for the reader who
-- never opens this file.
--
-- CANCELLED visits are excluded from all three aggregates on the same D19 grounds
-- deriveJobStatusFromVisits and the S8 teardown migration exclude them elsewhere in this spec: a
-- called-off trip is kept as history and must not be read as evidence of planned or actual work.
-- A job with zero qualifying (non-cancelled) visits gets NULL in all three columns.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- RLS. No policy or grant work is needed here and none is done. `jobs` already carries its
-- tenant_isolation policy from 20260703000100_tenant_rls and later coverage migrations; adding a
-- COLUMN does not touch a policy. Nothing below issues a GRANT or a CREATE POLICY.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ORDER IS A CORRECTNESS PROPERTY: the columns must exist before the index that names them, and
-- the index must exist before the backfill scans by it (the planner otherwise seq-scans `jobs`
-- for the UPDATE's target rows, which is correct but slower on a 7,000+ row table - not a
-- correctness issue on today's staging volume, but there is no reason to invite it).

-- ─── 1. Add the three columns ───────────────────────────────────────────────────────────────
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "first_visit_start" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "last_visit_end" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "last_visit_completed_at" TIMESTAMP(3);

-- ─── 2. Index the sort key ───────────────────────────────────────────────────────────────────
-- A1 (RATIFIED): JOB_SORT_FIELDS.scheduled moves from scheduled_start to first_visit_start in
-- this same PR (backend/src/lib/sortFields.ts), so every "sort the Jobs list by Scheduled"
-- request now orders by this column. Mirrors the existing jobs_scheduled_start_idx.
CREATE INDEX IF NOT EXISTS "jobs_first_visit_start_idx" ON "jobs"("first_visit_start");

-- ─── 3. One-time backfill from the existing visit set ───────────────────────────────────────
-- Guarded on "all three still NULL" rather than "any one NULL": a job whose true, correct state
-- is all-three-NULL (no non-cancelled visit ever existed) must never be treated as unbackfilled
-- and re-scanned forever, and a job partially populated by the real application code (impossible
-- before this PR ships, but not a safe thing to assume of a shared, re-run staging migration)
-- must not have a correct NULL overwritten by a stale re-aggregation. "All three NULL" is the
-- honest proxy for "the backfill has not touched this row yet", because every column this
-- migration adds starts NULL and nothing else writes them until the application code deploys.
UPDATE "jobs" j
SET
  "first_visit_start" = v.min_start,
  "last_visit_end" = v.max_end,
  "last_visit_completed_at" = v.max_completed
FROM (
  SELECT
    "job_id",
    MIN("scheduled_at") AS min_start,
    MAX("scheduled_end") AS max_end,
    MAX("completed_at") AS max_completed
  FROM "visits"
  WHERE "job_id" IS NOT NULL
    AND "status" <> 'CANCELLED'
  GROUP BY "job_id"
) v
WHERE j."id" = v."job_id"
  AND j."first_visit_start" IS NULL
  AND j."last_visit_end" IS NULL
  AND j."last_visit_completed_at" IS NULL;
