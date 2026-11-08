-- Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S3, decisions
-- D6 (crew lives on the visit; "the job's crew" becomes a derived union), D21 (double-booking
-- warns, never blocks) and D5 (one visits table, exactly one parent).
--
-- Lets a JOB visit carry crew at all. `visit_assignees.lead_id` is NOT NULL today, so a crew row
-- on a job-parented visit fails at INSERT against real Postgres while typechecking clean and
-- passing every mocked-Prisma test - the entire backend suite can be green with this broken. Both
-- S2 comments say so in as many words (job.controller.ts's createJobVisitSchema block and
-- walkthrough.service.ts's listJobVisits docstring). Without this file, S3's controller code
-- compiles, tests green, and every attempt to put a technician on a job visit 500s in production.
--
-- Portable: no Supabase-only roles, no auth.* - vanilla postgres:16 in CI runs it unchanged.
-- Idempotent: every step is guarded on the state it is about to change, so a second application
-- on the shared staging DB is a no-op.
--
-- RLS: the table's tenant_isolation policy and its grants were created by 20260703000100_tenant_rls
-- under the table's old name (`lead_walkthrough_performers`) and rode through S1's ALTER TABLE ...
-- RENAME. ALTER COLUMN disturbs neither, so nothing is re-granted or re-policied here -
-- authoring a duplicate GRANT/POLICY would risk a non-idempotent re-run against staging.
--
-- NO JSONB REWRITE, deliberately, and this is the one class CLAUDE.md says has bitten this project
-- three times. `role_permissions.conditions` persists OWN_JOB per org as the literal
-- {"assignees":{"some":{"user_id":"{{userId}}"}}}, and S3 does NOT repoint it: `job_assignees`
-- stays exactly where it is, dual-written as the union its readers read. The precedent files
-- 20260817140000_repoint_own_walkthrough_to_visits and 20260817120000 exist because an ALTER TABLE
-- ... RENAME cannot reach inside a JSONB value; nothing here renames a relation or a table, so
-- `check-role-permission-drift --strict` has nothing to catch. Repointing OWN_JOB to
-- {"visits":{"some":{"assignees":{"some":...}}}} is the correct END state and belongs with S8's
-- table drop, as its own guarded UPDATE matched on the exact historical value and UNFILTERED by
-- role - staging holds custom roles cloned from TECHNICIAN carrying the byte-identical path, which
-- the drift checker does not compare. `user_table_preferences.config` names no assignee table and
-- needs nothing.

-- ─── 1. A crew row on a job visit has no lead ─────────────────────────────────
--
-- REJECTED ALTERNATIVE: DROP the column outright, to match the spec's target shape (lines 266-269
-- list only id / organization_id / visit_id / user_id). It breaks SEVEN readers of Lead's
-- `visit_assignees` back-relation, two of which - attachment.controller.ts's read and write
-- ownership checks - are AUTHORIZATION decisions, not rendering. That is a permission hole traded
-- for zero behavioural gain. The drop goes with S8, as the schema comment already says.
--
-- The FK to `leads` stays valid under NULL: a nullable FK column simply does not constrain a NULL
-- row, so no constraint work is needed here.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'visit_assignees' AND column_name = 'lead_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "visit_assignees" ALTER COLUMN "lead_id" DROP NOT NULL;
  END IF;
END $$;

-- ─── 2. Fold today's job crew onto its job's FIRST visit ──────────────────────
--
-- The union has to be coherent for the data that already exists, not only for rows written from
-- now on. Without this every historical job opens on a Visits tab whose cards are blank of crew
-- while the Team card beside them lists the same people - the two representations of one fact
-- disagreeing on the page, which is the failure D14's mirror backfill was written to avoid on the
-- schedule side.
--
-- Staging today: 537 job_assignees rows, 531 of which sit on a job that already has at least one
-- visit (S2's backfill gave 9,437 jobs their visit 1). The remaining 6 belong to jobs with no
-- visit row at all; they contribute nothing here and keep their job-level-only rows, which is
-- correct under the union rule - it is ADD-ONLY from the visit side, and a job-level row with no
-- visit behind it is exactly what the four self-assign-on-create paths and the service-plan
-- visit-job writer produce.
--
-- BOTH guards below are load-bearing, and each names a different way a second run corrupts data:
--
--   * NOT EXISTS is what makes the INSERT idempotent against the (visit_id, user_id) unique
--     index. Without it a second application does not merely duplicate - it ABORTS on the
--     constraint and takes the whole migration down with it, mid-file.
--
--   * JOIN LATERAL ... LIMIT 1 is what keeps ONE job-level assignee from fanning out across
--     EVERY visit S2's backfill created. A plain join to `visits` would multiply 531 rows by that
--     job's visit count and put a technician on trips they were never on - and because
--     job_assignees is dual-written as the union, over-crewing a visit is not cosmetic: it is
--     read access to that job's notes and money for someone who should not have it.
--
-- Ordered by visit_seq then created_at: the same [{scheduled_at},{created_at}] stability rule
-- D13 applies to numbering, so a re-run picks the identical row rather than a different one.

INSERT INTO "visit_assignees" ("id", "organization_id", "visit_id", "user_id", "lead_id", "created_at")
SELECT gen_random_uuid(), ja."organization_id", v."id", ja."user_id", NULL, ja."created_at"
FROM "job_assignees" ja
JOIN LATERAL (
  SELECT vv."id"
  FROM "visits" vv
  WHERE vv."job_id" = ja."job_id"
  ORDER BY vv."visit_seq" ASC, vv."created_at" ASC
  LIMIT 1
) v ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM "visit_assignees" va
  WHERE va."visit_id" = v."id" AND va."user_id" = ja."user_id"
);
