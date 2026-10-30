-- V7-03 (Lists backend), Migration A: the Job types and Lead/Customer sources lists become rows.
--
-- DDL ONLY. Two tables, their indexes, FK and RLS backstop, plus three indexes on the record columns that hold the same
-- text (they serve the used-by counts and the rename rewrite). Nothing is dropped, renamed or backfilled: the JSON columns
-- organizations.job_type_options / source_options stay for the deploy overlap. The data backfill is a separate migration.
-- Until it runs, the code treats "this org has no rows in the table" as "read the JSON column".
--
-- NO lower(name) INDEX, ON PURPOSE. Case-insensitive name uniqueness is enforced in code inside the write transaction
-- (the task_categories precedent, 20260928080000_task_categories), which keeps the schema-drift check green. The unique
-- index below is the exact-name backstop only.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS or guarded, no Supabase-only objects outside a pg_roles guard.

CREATE TABLE IF NOT EXISTS "job_types" (
  "id"              UUID NOT NULL,
  "name"            VARCHAR(50) NOT NULL,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "archived_at"     TIMESTAMPTZ(6),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "job_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_sources" (
  "id"              UUID NOT NULL,
  "name"            VARCHAR(50) NOT NULL,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "archived_at"     TIMESTAMPTZ(6),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "job_types_organization_id_name_key" ON "job_types"("organization_id", "name");
CREATE INDEX IF NOT EXISTS "job_types_organization_id_sort_order_idx" ON "job_types"("organization_id", "sort_order");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_sources_organization_id_name_key" ON "lead_sources"("organization_id", "name");
CREATE INDEX IF NOT EXISTS "lead_sources_organization_id_sort_order_idx" ON "lead_sources"("organization_id", "sort_order");

DO $$ BEGIN
  ALTER TABLE "job_types" ADD CONSTRAINT "job_types_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Record-column indexes. A plain CREATE INDEX holds a write lock on the table while it builds; the conductor checks the
-- row counts before this reaches prod.
CREATE INDEX IF NOT EXISTS "jobs_organization_id_job_type_idx" ON "jobs"("organization_id", "job_type");
CREATE INDEX IF NOT EXISTS "leads_organization_id_job_type_idx" ON "leads"("organization_id", "job_type");
CREATE INDEX IF NOT EXISTS "customers_organization_id_ad_source_idx" ON "customers"("organization_id", "ad_source");

-- Tenant RLS backstop (rls-coverage.test.ts requires it of every table with an organization_id column).
ALTER TABLE "job_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_types";
CREATE POLICY "tenant_isolation" ON "job_types"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "lead_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_sources" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lead_sources";
CREATE POLICY "tenant_isolation" ON "lead_sources"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_types FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lead_sources FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_types FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.lead_sources FROM authenticated';
  END IF;
END $$;
