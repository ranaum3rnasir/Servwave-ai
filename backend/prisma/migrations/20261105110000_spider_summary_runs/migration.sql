-- Spider writes a starting summary in small saved pieces that resume, and give up after 3 tries (#3108).
--
-- The whole summary was one interactive transaction (a line held for its whole length), it deleted the company's older
-- summary first (which rewrote every alert row of it, because spider_alerts.summary_id is ON DELETE SET NULL), and a run
-- killed halfway never reached the code that gives up, so after a restart it tried again for ever. Now:
--
--   spider_summary_runs: one go at making a summary. summary_id (the summary being built), status (RUNNING | DONE |
--     ABANDONED), attempts (counted and saved BEFORE the attempt does any work), cursor (the last lead whose claim is saved),
--     last_error (an error class only), next_attempt_at (when the next attempt may start: 2, 8, then 30 minutes after an
--     attempt began) and timestamps. At most one RUNNING run per company (partial unique index).
--   spider_summaries.status: BUILDING | READY | SUPERSEDED. Staff and History read READY summaries only, so a half-written
--     one is never seen; an older summary is marked SUPERSEDED, never deleted (nothing is rewritten).
--   spider_summaries.organization_id stops being unique: the one-per-company rule becomes a partial unique index on
--     organization_id for the summaries that are not SUPERSEDED (the current one). This is the one approved replacement.
--
-- Additive, no data moves: status is nullable with the constant default READY, so every summary that exists comes out READY
-- (adding a column with a constant default rewrites no row); a row with no status is read as READY. Prisma cannot express a partial index, so both partial indexes
-- live only here, as leads_open_org_idx does (20261103100000); `prisma migrate diff` lists them as drift.
-- A backend from before this, during a rolling deploy, inserts summaries without a status and gets READY, as it always
-- behaved; it does not know the partial index and replaces a summary with the delete it always did.
--
-- Row-level security on the new table: the standard company policy, forced, no Supabase client-role grants (as the other
-- Spider tables).
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, constraints in
-- duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards. No CONCURRENTLY. No secrets.

ALTER TABLE "spider_summaries" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'READY';

DO $$ BEGIN
  ALTER TABLE "spider_summaries" ADD CONSTRAINT "spider_summaries_status_check" CHECK ("status" IN ('BUILDING', 'READY', 'SUPERSEDED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- One current summary per company: the unique rule the table had, now for the summaries that are not SUPERSEDED.
-- Created before the old rule goes, so the company is never without the guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "spider_summaries_current_org_key" ON "spider_summaries"("organization_id") WHERE "status" IS DISTINCT FROM 'SUPERSEDED';
DROP INDEX IF EXISTS "spider_summaries_organization_id_key";

CREATE TABLE IF NOT EXISTS "spider_summary_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "summary_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cursor" UUID,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "spider_summary_runs_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "spider_summary_runs" ADD CONSTRAINT "spider_summary_runs_status_check" CHECK ("status" IN ('RUNNING', 'DONE', 'ABANDONED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "spider_summary_runs_summary_id_key" ON "spider_summary_runs"("summary_id");
-- At most one run in progress per company (a second would double-write its claims).
CREATE UNIQUE INDEX IF NOT EXISTS "spider_summary_runs_one_running_per_org" ON "spider_summary_runs"("organization_id") WHERE "status" = 'RUNNING';

DO $$ BEGIN
  ALTER TABLE "spider_summary_runs" ADD CONSTRAINT "spider_summary_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "spider_summary_runs" ADD CONSTRAINT "spider_summary_runs_summary_id_fkey"
    FOREIGN KEY ("summary_id") REFERENCES "spider_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "spider_summary_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_summary_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spider_summary_runs";
CREATE POLICY "tenant_isolation" ON "spider_summary_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_summary_runs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_summary_runs FROM authenticated';
  END IF;
END $$;
