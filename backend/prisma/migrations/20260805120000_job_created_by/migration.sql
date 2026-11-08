-- Job creator tracking (audit only).
--
-- WHY. "Who created this job" has no answer today - the jobs table records no actor at all, so the
-- question is unanswerable months later, which is exactly when it is asked. Six models already
-- carry a creator (Estimate, Task, Note, LogisticOrder, Credit, TimelineEvent); jobs did not.
-- -> md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md (Part A)
--
-- NOTHING READS THESE FOR AUTHORIZATION. This migration and its PR are pure audit: no grant, no
-- CASL condition and no route consults these columns. Reading created_by_id to decide access is a
-- later, separate change.
--
-- TWO COLUMNS PLUS A NAME SNAPSHOT.
--   created_by_source  answers "what kind of actor", which a bare nullable FK cannot: it separates
--                      "the customer did this themselves" from "we do not know".
--   created_by_id      the acting user, when there is one.
--   created_by_name    a denormalised snapshot written at creation time. DELETE /api/users/:id/permanent
--                      exists, and the FK below is ON DELETE SET NULL, so without this snapshot a
--                      permanent user delete would erase the audit answer precisely for the departed
--                      employee whose work is most likely to be queried. ON DELETE RESTRICT was the
--                      alternative and was rejected: it makes permanent deletion impossible for
--                      anyone who has ever created a job.
--
-- IDEMPOTENT: the enum creation swallows duplicate_object (matching
--   20260804180000_email_provider_message_id_and_delivery_state), every ADD COLUMN is
--   IF NOT EXISTS-guarded, and the foreign key is added only when pg_constraint lacks it. A second
--   application against the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job) - CREATE TYPE, ALTER TABLE ADD COLUMN
--   IF NOT EXISTS and ALTER TABLE ADD CONSTRAINT are all core Postgres. No Supabase-only objects,
--   no auth schema, and no role grants to guard: the new columns inherit the jobs table's existing
--   RLS policies and grants.
-- NO BACKFILL, NO TABLE REWRITE: created_by_source lands on its default for every existing row,
--   which is the literal truth about them (see below); the other two are nullable.

-- ─── Enum ────────────────────────────────────────────────────────────────────
-- The kind of actor behind a create. UNKNOWN is not a failure state - it is the honest answer for
-- every row written before this column existed.
DO $$ BEGIN
  CREATE TYPE "CreatedBySource" AS ENUM ('USER', 'CLIENT', 'SYSTEM', 'IMPORT', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── jobs columns ────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT 'UNKNOWN' is load-bearing: the default is the only thing that can answer for the
-- rows that predate this migration. A nullable column would leave them reading back null, which
-- says nothing at all.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

-- ─── Creator link ────────────────────────────────────────────────────────────
-- SET NULL (not RESTRICT, not CASCADE): a permanent user delete must neither fail nor take the job
-- with it. created_by_name above is what keeps the audit answer readable afterwards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_created_by_id_fkey') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Every "jobs this user created" lookup filters on this column; without the index each one is a
-- full scan of the org's jobs.
CREATE INDEX IF NOT EXISTS "jobs_created_by_id_idx" ON "jobs"("created_by_id");
