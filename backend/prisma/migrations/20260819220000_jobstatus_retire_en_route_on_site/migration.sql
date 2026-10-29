-- Retire EN_ROUTE and ON_SITE from JobStatus again, undoing 20260819190000.
--
-- WHY THIS EXISTS. 20260819190000_jobstatus_enum_repair added the two labels back because staging
-- was missing them while schema.prisma still declared seven. That was true when it was written and
-- false by the time it merged: 20260819120000_visit_lifecycle_multi_visit_s4 (D17) had landed two
-- hours earlier and deliberately retired both labels - they describe a TRIP, so they moved to
-- VisitStatus, and schema.prisma now declares five. The repair therefore re-added, at a LATER
-- migration timestamp, exactly what S4 had just removed.
--
-- The damage is not visible at runtime: no row and no job_sub_statuses.parent holds either label
-- (S4 migrated them to IN_PROGRESS, and Prisma cannot write a label its client does not know), and
-- nothing in backend/src or frontend/src names either as a JobStatus any more - every remaining
-- mention is a comment about the retirement. What it does break is the migration chain: on staging
-- the type carries seven labels against a schema declaring five, and on every environment built by
-- replaying migrations - a fresh dev database, and prod at the next promotion - S4 would swap the
-- type down to five and then this pair would be added straight back.
--
-- So the fix is a corrective migration, not a revert: staging has already applied the repair, and
-- deleting its directory would leave an orphan ledger row behind while fixing nothing.
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so this rebuilds the type. The shape below is S4's own
-- swap block, reused deliberately rather than reinvented, including its guards.
--
-- BOTH dependent columns move: jobs.status and job_sub_statuses.parent. Confirmed against staging
-- that these are the only two - missing the second leaves the old type undroppable.
--
-- RLS: no table is created or renamed, so the tenant_isolation policies stay attached untouched.
-- ALTER COLUMN ... TYPE does not disturb a policy or a grant.
--
-- IDEMPOTENCE: every block is guarded on state the first application consumes. The create is
-- guarded on the retired label still being PRESENT (not merely on the temp type being absent -
-- the rename at the end frees that name again, so that guard alone would re-run the whole rewrite).
-- On an environment that never applied the repair, or on a second pass here, every guard is false
-- and the file is a no-op.

-- 1. Any job left at a retired label moves to IN_PROGRESS, matching what S4 decided. None exist on
--    staging today; this is here so the file is correct on an environment where one does.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE') THEN
    UPDATE "jobs" SET "status" = 'IN_PROGRESS' WHERE "status" IN ('EN_ROUTE', 'ON_SITE');
  END IF;
END $$;

-- 2. Same for the sub-status parents. @@unique([organization_id, parent, label]) means re-parenting
--    onto IN_PROGRESS can collide with a row that is already there, so the colliding ones are
--    dropped first and only then is the survivor re-parented.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE') THEN
    DELETE FROM "job_sub_statuses" doomed
    WHERE doomed."parent" IN ('EN_ROUTE', 'ON_SITE')
      AND EXISTS (
        SELECT 1 FROM "job_sub_statuses" keeper
        WHERE keeper."organization_id" = doomed."organization_id"
          AND keeper."label" = doomed."label"
          AND keeper."parent" IN ('EN_ROUTE', 'ON_SITE', 'IN_PROGRESS')
          AND keeper."id" <> doomed."id"
          AND (keeper."parent" = 'IN_PROGRESS' OR keeper."id" < doomed."id")
      );

    UPDATE "job_sub_statuses" SET "parent" = 'IN_PROGRESS' WHERE "parent" IN ('EN_ROUTE', 'ON_SITE');
  END IF;
END $$;

-- 3. The swap itself.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new') THEN
    CREATE TYPE "JobStatus_new" AS ENUM
      ('UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new')
     AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'status' AND udt_name = 'JobStatus'
  ) THEN
    ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "jobs" ALTER COLUMN "status" TYPE "JobStatus_new" USING "status"::text::"JobStatus_new";
    ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'UNSCHEDULED';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new')
     AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'job_sub_statuses' AND column_name = 'parent' AND udt_name = 'JobStatus'
  ) THEN
    ALTER TABLE "job_sub_statuses" ALTER COLUMN "parent" DROP DEFAULT;
    ALTER TABLE "job_sub_statuses" ALTER COLUMN "parent" TYPE "JobStatus_new" USING "parent"::text::"JobStatus_new";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus')
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new') THEN
    DROP TYPE "JobStatus";
    ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
  END IF;
END $$;
