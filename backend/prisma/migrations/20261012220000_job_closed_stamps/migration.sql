-- Job close-out (Roles & Permissions, PRD 6, S06.13): when a job was marked Done, and by whom.
--
-- Two nullable columns on "jobs", beside completed_at. Null means the job has not been closed (no job is Done yet, so
-- nothing is backfilled; the one-time move of jobs already Completed is its own, later migration, S06.32). A reopen
-- (S06.16) clears both, the way it clears completed_at.
--
-- Safe while the PREVIOUS backend is still serving for the few minutes after Render applies this file: the columns are
-- only added, nullable, with no default, and that backend never reads or writes them.
--
-- Idempotent and portable per .claude/skills/writing-migrations: ADD COLUMN IF NOT EXISTS, the foreign key behind a
-- pg_constraint guard, the index IF NOT EXISTS. No Supabase-only object is touched.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "closed_by_id" UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_closed_by_id_fkey') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_closed_by_id_fkey"
      FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "jobs_closed_by_id_idx" ON "jobs"("closed_by_id");
