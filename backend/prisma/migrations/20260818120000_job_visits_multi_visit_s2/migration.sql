-- Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S2, decisions
-- D14 (the write-through mirror) and D5 (exactly one parent).
--
-- Widens `visits` so a JOB's schedule can actually live on a visit row. The spec's schema block
-- names scheduled_start / scheduled_end / is_all_day on visits; S1 shipped the walkthrough shape
-- it inherited (scheduled_at + duration_minutes) because a lead walkthrough never had an end or
-- an all-day flag. A job does: assign() is the ONLY writer of Job.is_all_day today and it derives
-- end = start + 24h from that flag, so storing job visits in the walkthrough shape would silently
-- collapse every all-day job to a 60-minute one on the first visit-driven write. The start column
-- keeps its S1 name (`scheduled_at`) - renaming it is a pure cross-tree sweep with no behaviour
-- change and belongs with S8's tidy, not here.
--
-- Portable: no Supabase-only roles, no auth.* - vanilla postgres:16 in CI runs it unchanged.
-- Idempotent: every step is guarded on the state it is about to change, so a second application
-- on the shared staging DB is a no-op.
--
-- No new table, so no new tenant_isolation policy is needed: `visits` already carries the policy
-- it inherited through S1's ALTER TABLE ... RENAME, and ADD COLUMN does not disturb it. The
-- job_id column, its FK (ON DELETE CASCADE), its index and the visits_exactly_one_parent CHECK
-- all landed in 20260817130000 and are deliberately NOT repeated here - authoring a duplicate
-- risks a non-idempotent re-run against the shared staging DB.

-- ─── 1. The job-shaped time columns ───────────────────────────────────────────

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "scheduled_end" TIMESTAMP(3);

-- A DEFAULT false is correct here even though S1 deliberately REFUSED a default on `purpose`.
-- The contrast is the point: `purpose` had a genuinely unknowable value for a future row, so
-- defaulting it would have silently mislabelled any job visit whose writer forgot to set it.
-- `is_all_day` does not - every row that exists at this moment is a lead walkthrough by
-- construction (job_id has been unwritten until this slice) and a lead has no all-day concept,
-- so `false` is the TRUE value for every existing row rather than a guess, and NOT NULL keeps
-- every reader off a tri-state boolean.
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "is_all_day" BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. Backfill the window on existing rows ──────────────────────────────────
--
-- Every pre-S2 row stores its span as duration_minutes only. Deriving the end once here means
-- the readers added in S2 do not have to branch on "old row or new row". 60 is the same default
-- the visit schedule dialog and detectPerformerConflicts already apply to a null duration.
--
-- Guarded on job_id IS NULL as well as on the IS NULL it is repairing, and BOTH guards are
-- load-bearing. Every row that exists before this file runs is a lead walkthrough, so job_id IS
-- NULL is a no-op on run 1 - but step 3 below inserts JOB rows in the same file, and this
-- statement runs FIRST on a second application. Without the parent guard, a re-run (by hand
-- through Supabase MCP, or on a restored database with no _prisma_migrations) would match those
-- job rows and stamp an invented end on them, which the next visit write then mirrors onto the
-- job. An open-ended job would silently become a 60-minute one purely because the file ran
-- twice, which is exactly what "a second application is a no-op" promises it cannot do.

UPDATE "visits"
SET "scheduled_end" = "scheduled_at" + (COALESCE("duration_minutes", 60) * interval '1 minute')
WHERE "job_id" IS NULL AND "scheduled_end" IS NULL AND "scheduled_at" IS NOT NULL;

-- ─── 3. One visit 1 per already-scheduled job (D13/D14) ───────────────────────
--
-- Every job that already holds a time gets the visit that time has always described. Without
-- this, an existing job would open on a page showing an EMPTY visit list beside a hero reading a
-- real time - D14's wrong-data window made visible on the page rather than only on the board -
-- and the mirror's first recompute would be the first row the job ever had.
--
-- REJECTED ALTERNATIVE: adopt Job.scheduled_start into visit 1 lazily, in the controller, on the
-- first visit create. It needs no migration, but it leaves exactly that empty-list-beside-a-real-
-- time state on every already-scheduled job until somebody happens to add a second trip, and it
-- hides a data repair inside a request handler where nobody can audit whether it ran.
--
-- The CASE is a straight NAME MAP of the JobStatus values onto VisitStatus, NOT D12's derivation
-- (which runs the other way - job status derived FROM its visits - and lands in S4).
--
-- UNSCHEDULED is spelled out rather than left to the ELSE, because it DOES reach here and the
-- mapping is a decision, not a formality: 133 jobs on staging are UNSCHEDULED and still hold a
-- scheduled_start - nothing has ever paired the status with the time, so a job can be moved back
-- to UNSCHEDULED while keeping the window it was booked for. Those jobs already show a time
-- everywhere the board and the filters read
-- Job.scheduled_start, so the honest visit for them is the SCHEDULED one that time describes -
-- and S4, which derives job status FROM its visits, will therefore promote them to SCHEDULED.
-- That promotion is a repair of an already-contradictory row, stated here so it is not a surprise
-- in S4. The ELSE now covers nothing but a future enum value.
--
-- scheduled_end is COALESCEd rather than copied: Job.scheduled_end is nullable and usually null
-- (9,055 of 9,435 timed jobs on staging), and a visit holding neither an end nor a
-- duration_minutes breaks the invariant every S2 write path maintains - createJobVisit and
-- rescheduleVisitRow always set the two together. A row with neither opens the reschedule dialog
-- with end == start (it seeds the end from `scheduled_end ?? scheduled_at`) and saving it
-- collapses the job to a one-minute window without the user touching the end field. 60 minutes is
-- the same default step 2, the schedule dialog and detectPerformerConflicts already apply.
-- NOTE this deliberately does NOT write the derived end back onto the job: Job.scheduled_end is
-- the mirror (D14), and the next visit write refreshes it from the visit.
--
-- visit_seq is 1 for every backfilled row by construction: this only fires for jobs that have no
-- visits at all, so there is no existing number to collide with (D13).
--
-- Idempotent by the NOT EXISTS guard - a second application matches no job.

WITH src AS (
  SELECT
    j."id",
    j."organization_id",
    j."status",
    j."scheduled_start",
    j."is_all_day",
    COALESCE(j."scheduled_end", j."scheduled_start" + interval '60 minutes') AS "visit_end"
  FROM "jobs" j
  WHERE j."scheduled_start" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "visits" v WHERE v."job_id" = j."id")
)
INSERT INTO "visits" (
  "id", "organization_id", "job_id", "purpose", "visit_seq", "status",
  "scheduled_at", "scheduled_end", "is_all_day", "duration_minutes", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  s."organization_id",
  s."id",
  'WORK'::"VisitPurpose",
  1,
  (CASE s."status"
    WHEN 'CANCELLED'   THEN 'CANCELLED'
    WHEN 'COMPLETED'   THEN 'COMPLETED'
    WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
    WHEN 'ON_SITE'     THEN 'ON_SITE'
    WHEN 'EN_ROUTE'    THEN 'EN_ROUTE'
    WHEN 'UNSCHEDULED' THEN 'SCHEDULED'
    ELSE 'SCHEDULED'
  END)::"VisitStatus",
  s."scheduled_start",
  s."visit_end",
  s."is_all_day",
  GREATEST(1, ROUND(EXTRACT(EPOCH FROM (s."visit_end" - s."scheduled_start")) / 60))::int,
  now(),
  now()
FROM src s;
