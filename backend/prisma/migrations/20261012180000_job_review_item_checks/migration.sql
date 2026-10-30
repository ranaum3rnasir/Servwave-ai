-- Office review item checks (Roles & Permissions, PRD 6, S06.10): one row per checked item per review round, the job
-- summary included. A row holds the item key, the history entry the check was made against, who checked and when. An
-- item is checked only while its latest history entry is the one recorded here, so a later change un-checks it with no
-- extra write. Re-checking an item overwrites its row (one row per item per round).
--
-- The history entry id is a plain UUID with no foreign key: it names a row of the job's timeline, and the check must
-- outlive nothing but its round (the review cascades to its checks, the company to its reviews).
--
-- Additive only (a new table), so the previous backend serving for the few minutes after Render applies this file never
-- reads or writes it.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs in duplicate_object
-- guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards.

CREATE TABLE IF NOT EXISTS "job_review_item_checks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "item_key" TEXT NOT NULL,
    "entry_id" UUID NOT NULL,
    "checked_by_id" UUID,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_review_item_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "job_review_item_checks_review_id_item_key_key" ON "job_review_item_checks"("review_id", "item_key");
CREATE INDEX IF NOT EXISTS "job_review_item_checks_organization_id_idx" ON "job_review_item_checks"("organization_id");

DO $$ BEGIN
  ALTER TABLE "job_review_item_checks" ADD CONSTRAINT "job_review_item_checks_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_review_item_checks" ADD CONSTRAINT "job_review_item_checks_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "job_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "job_review_item_checks" ADD CONSTRAINT "job_review_item_checks_checked_by_id_fkey"
    FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "job_review_item_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_review_item_checks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_review_item_checks";
CREATE POLICY "tenant_isolation" ON "job_review_item_checks"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_review_item_checks FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_review_item_checks FROM authenticated';
  END IF;
END $$;
