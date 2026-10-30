-- Office review customer decisions (Roles & Permissions, PRD 6, S06.11): one row per PRD 5 job contact entry per review
-- round, holding the reviewer's choice (ADD, UPDATE, THIS_JOB_ONLY, or NONE for an entry removed before the review), who
-- chose and when, and whether Finish review has applied it to the customer (S06.12; this slice only records it).
--
-- The contact entry id and the history entry id are plain UUIDs with no foreign key: a decision never changes PRD 5's
-- entries, and the tick must not follow an entry in or out of existence. The ticked item is checked only while the
-- history entry named here is still the item's latest, so a correction un-checks it with no extra write.
--
-- Additive only (a new table), so the previous backend serving for the few minutes after Render applies this file never
-- reads or writes it.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs in duplicate_object
-- guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards.

CREATE TABLE IF NOT EXISTS "job_review_customer_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "choice" TEXT NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "job_review_customer_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "job_review_customer_decisions_review_id_entry_id_key" ON "job_review_customer_decisions"("review_id", "entry_id");
CREATE INDEX IF NOT EXISTS "job_review_customer_decisions_organization_id_idx" ON "job_review_customer_decisions"("organization_id");

DO $$ BEGIN
  ALTER TABLE "job_review_customer_decisions" ADD CONSTRAINT "job_review_customer_decisions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_review_customer_decisions" ADD CONSTRAINT "job_review_customer_decisions_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "job_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_review_customer_decisions" ADD CONSTRAINT "job_review_customer_decisions_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "job_review_customer_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_review_customer_decisions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_review_customer_decisions";
CREATE POLICY "tenant_isolation" ON "job_review_customer_decisions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_review_customer_decisions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_review_customer_decisions FROM authenticated';
  END IF;
END $$;
