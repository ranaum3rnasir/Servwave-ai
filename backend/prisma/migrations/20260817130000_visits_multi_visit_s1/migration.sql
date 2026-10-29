-- Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S1.
--
-- Renames and widens `walkthroughs` into the unified `visits` table: a visit belongs to exactly
-- one parent (a Lead or a Job) and is the single concept behind both a lead walkthrough and a
-- job's work trip (D3/D5). S1 populates the lead side only; job_id lands now, unwritten until S2,
-- so the unified table is real from day one rather than a promise.
--
-- Portable: no Supabase-only roles, no auth.* - vanilla postgres:16 in CI runs it unchanged.
-- Idempotent: every step is guarded on the state it is about to change, so a second application
-- on the shared staging DB is a no-op.
--
-- Note on RLS: ALTER TABLE ... RENAME carries row-level-security policies and grants with the
-- table, so the tenant_isolation policies created in 20260703000100_tenant_rls stay attached and
-- keep enforcing. Their policy names still read "walkthroughs"; renaming a policy changes nothing
-- functionally and is left for a follow-up so this migration stays reviewable.

-- ─── 1. Tables and columns ────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'walkthroughs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'visits') THEN
    ALTER TABLE "walkthroughs" RENAME TO "visits";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_walkthrough_performers')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'visit_assignees') THEN
    ALTER TABLE "lead_walkthrough_performers" RENAME TO "visit_assignees";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'visit_assignees' AND column_name = 'walkthrough_id') THEN
    ALTER TABLE "visit_assignees" RENAME COLUMN "walkthrough_id" TO "visit_id";
  END IF;
END $$;

-- D5: a visit hangs off a Job OR a Lead, so lead_id stops being mandatory.
ALTER TABLE "visits" ALTER COLUMN "lead_id" DROP NOT NULL;

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "job_id" UUID;

-- ─── 2. Purpose ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitPurpose') THEN
    CREATE TYPE "VisitPurpose" AS ENUM ('WORK', 'WALKTHROUGH');
  END IF;
END $$;

-- Added nullable + backfilled + set NOT NULL, rather than NOT NULL DEFAULT: every existing row is
-- a lead walkthrough by construction (job_id did not exist until this migration), but defaulting
-- the column would silently mislabel any future job visit whose writer forgot to set it.
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "purpose" "VisitPurpose";
UPDATE "visits" SET "purpose" = 'WALKTHROUGH' WHERE "purpose" IS NULL;
ALTER TABLE "visits" ALTER COLUMN "purpose" SET NOT NULL;

-- ─── 3. Stable per-parent sequence (D13) ──────────────────────────────────────

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "visit_seq" INTEGER NOT NULL DEFAULT 1;

-- Backfill in CREATION order, not scheduled order - the number is a stable label that appears in
-- customer email, so it must never be recomputed from a time that can change.
-- Guarded so a re-run does not renumber rows created since.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "visits" WHERE "visit_seq" = 1 GROUP BY "lead_id" HAVING COUNT(*) > 1) THEN
    WITH seq AS (
      SELECT "id", ROW_NUMBER() OVER (PARTITION BY "lead_id" ORDER BY "created_at", "id") AS n
      FROM "visits"
      WHERE "lead_id" IS NOT NULL
    )
    UPDATE "visits" v SET "visit_seq" = seq.n FROM seq WHERE v."id" = seq."id";
  END IF;
END $$;

-- ─── 4. Status: rebuild the enum to RETIRE REQUESTED (D22/D22a) ───────────────
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so the type is recreated rather than renamed.
--
-- REQUESTED never described a visit - it described a lead that NEEDS one, which under multi-visit
-- is the ABSENCE of a live visit, not a row. Those placeholder rows carry no schedule and no
-- outcome, so they are deleted; the three "needs scheduling" queries flip to "has no live visit"
-- in the same PR. A REQUESTED row that somehow DOES carry data is preserved as CANCELLED rather
-- than deleted - losing a real trip to a refactor is not an acceptable trade.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitStatus') THEN
    CREATE TYPE "VisitStatus" AS ENUM
      ('SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;

DO $$
BEGIN
  -- Only run the cutover while the column still carries the OLD type.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'visits' AND column_name = 'status' AND udt_name = 'WalkthroughStatus'
  ) THEN
    -- Preserve any REQUESTED row that actually holds data...
    UPDATE "visits"
    SET "status" = 'CANCELLED',
        "cancelled_at" = COALESCE("cancelled_at", NOW()),
        "cancelled_reason" = COALESCE("cancelled_reason", 'Retired REQUESTED placeholder (multi-visit S1)')
    WHERE "status" = 'REQUESTED'
      AND ("scheduled_at" IS NOT NULL OR "completed_at" IS NOT NULL);

    -- ...and drop the genuine placeholders.
    DELETE FROM "visits" WHERE "status" = 'REQUESTED';

    ALTER TABLE "visits" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "visits" ALTER COLUMN "status" TYPE "VisitStatus" USING "status"::text::"VisitStatus";
    ALTER TABLE "visits" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WalkthroughStatus') THEN
    DROP TYPE "WalkthroughStatus";
  END IF;
END $$;

-- ─── 5. Exactly-one-parent CHECK (D5) ─────────────────────────────────────────
--
-- The invariant Prisma cannot express. num_nonnulls is a Postgres builtin, so this stays a single
-- expression rather than a pair of OR'd null tests.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_exactly_one_parent') THEN
    ALTER TABLE "visits"
      ADD CONSTRAINT "visits_exactly_one_parent"
      CHECK (num_nonnulls("lead_id", "job_id") = 1);
  END IF;
END $$;

-- ─── 6. FK + indexes for the new parent ───────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_job_id_fkey') THEN
    ALTER TABLE "visits"
      ADD CONSTRAINT "visits_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "visits_job_id_idx" ON "visits"("job_id");
