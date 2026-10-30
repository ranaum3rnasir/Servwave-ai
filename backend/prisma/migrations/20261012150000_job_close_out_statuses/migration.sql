-- Job close-out (Roles & Permissions, PRD 6, S06.1): three new job statuses and the office review round table.
--
-- 1. "JobStatus" gains OFFICE_REVIEW, READY_TO_CLOSE and DONE, placed between COMPLETED and CANCELLED. A new enum value
--    cannot be used in the transaction that adds it, so nothing in this file writes or compares one of them: no job is
--    moved here (the one-time move of jobs already Completed is its own, later migration, S06.32).
-- 2. "job_reviews": one row per office review round on a job. The job-level complete opens a round in the same write
--    that moves the job to Office review. State is plain text with a CHECK (OPEN | FINISHED), like record_contact_entries,
--    so the file adds no Prisma enum.
--
-- Safe while the PREVIOUS backend is still serving for the few minutes after Render applies this file: that backend
-- never reads or writes a status it does not know, and the new table and values are only added, never changed.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs and CHECKs in
-- duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards.

ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'OFFICE_REVIEW' AFTER 'COMPLETED';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'READY_TO_CLOSE' AFTER 'OFFICE_REVIEW';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'DONE' AFTER 'READY_TO_CLOSE';

CREATE TABLE IF NOT EXISTS "job_reviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_start" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "finished_by_id" UUID,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "job_reviews_organization_id_idx" ON "job_reviews"("organization_id");
CREATE INDEX IF NOT EXISTS "job_reviews_job_id_state_idx" ON "job_reviews"("job_id", "state");

DO $$ BEGIN
  ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_state_check" CHECK ("state" IN ('OPEN', 'FINISHED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_reviews" ADD CONSTRAINT "job_reviews_finished_by_id_fkey"
    FOREIGN KEY ("finished_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "job_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_reviews" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_reviews";
CREATE POLICY "tenant_isolation" ON "job_reviews"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_reviews FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_reviews FROM authenticated';
  END IF;
END $$;
