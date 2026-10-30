-- Record contact entries (Roles & Permissions, PRD 5, S05.7): a job's (or a lead's) own copy of a customer detail.
--
-- A person with the pencil adds a phone or email that belongs to ONE job or ONE lead; the customer row is never
-- written. Each entry is keyed to exactly one job or one lead (a CHECK enforces it), carries who made it and who last
-- changed it with name snapshots that outlive the user row, and is never hard-deleted (removed_at keeps the history
-- whole). The self-reference links a job entry carried over at lead conversion to the lead entry it came from.
-- kind and intent are plain text with a CHECK, not Prisma enums.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs and CHECKs in
-- duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards.

CREATE TABLE IF NOT EXISTS "record_contact_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID,
    "lead_id" UUID,
    "kind" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "extension" TEXT,
    "label" VARCHAR(50),
    "overridden_field" TEXT,
    "overridden_row_id" UUID,
    "customer_value_at_change" TEXT,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "source_entry_id" UUID,

    CONSTRAINT "record_contact_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "record_contact_entries_organization_id_idx" ON "record_contact_entries"("organization_id");
CREATE INDEX IF NOT EXISTS "record_contact_entries_job_id_idx" ON "record_contact_entries"("job_id");
CREATE INDEX IF NOT EXISTS "record_contact_entries_lead_id_idx" ON "record_contact_entries"("lead_id");

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_one_record_check"
    CHECK (("job_id" IS NOT NULL AND "lead_id" IS NULL) OR ("job_id" IS NULL AND "lead_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_kind_check"
    CHECK ("kind" IN ('PHONE', 'EMAIL', 'FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_intent_check"
    CHECK ("intent" IN ('ADDED', 'CHANGED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_updated_by_id_fkey"
    FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "record_contact_entries" ADD CONSTRAINT "record_contact_entries_source_entry_id_fkey"
    FOREIGN KEY ("source_entry_id") REFERENCES "record_contact_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "record_contact_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "record_contact_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "record_contact_entries";
CREATE POLICY "tenant_isolation" ON "record_contact_entries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.record_contact_entries FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.record_contact_entries FROM authenticated';
  END IF;
END $$;
