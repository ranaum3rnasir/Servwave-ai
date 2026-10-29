-- SRVW-112 (Workiz parity): per-org job sub-status catalog under the FIXED JobStatus parents,
-- plus a nullable Job.sub_status_id pointing at it.
--
-- IDEMPOTENT: IF NOT EXISTS on every CREATE / ADD COLUMN; every FK inside a pg_constraint DO-block
--   guard; DROP POLICY IF EXISTS before CREATE POLICY. A second run on the shared staging DB is a
--   no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job) - the RLS policy has no TO clause
--   (core Postgres), and the only Supabase-role objects are the anon/authenticated REVOKEs, which
--   are guarded by pg_roles checks.
-- ADDITIVE ONLY: no CREATE TYPE (enum "JobStatus" already exists and is deliberately NOT widened)
--   and no backfill. The ADD COLUMN is nullable with no default, so it is metadata-only on the
--   existing jobs rows - no table rewrite, no lock risk.

-- ─── job_sub_statuses ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "job_sub_statuses" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "parent"          "JobStatus" NOT NULL,
  "label"           TEXT NOT NULL,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_sub_statuses_pkey" PRIMARY KEY ("id")
);

-- One label per (org, parent). The controller pre-checks this before inserting so the user gets a
-- 409 rather than a raw unique violation; the constraint is the backstop, never an upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS "job_sub_statuses_organization_id_parent_label_key"
  ON "job_sub_statuses"("organization_id", "parent", "label");
-- The list/picker query: this org's labels for one parent, in display order.
CREATE INDEX IF NOT EXISTS "job_sub_statuses_organization_id_parent_sort_order_idx"
  ON "job_sub_statuses"("organization_id", "parent", "sort_order");

-- organization_id RESTRICT (the tenant row must outlive its children), matching walkthroughs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sub_statuses_organization_id_fkey') THEN
    ALTER TABLE "job_sub_statuses" ADD CONSTRAINT "job_sub_statuses_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── jobs.sub_status_id ──────────────────────────────────────────────────────
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "sub_status_id" UUID;

CREATE INDEX IF NOT EXISTS "jobs_sub_status_id_idx" ON "jobs"("sub_status_id");

-- SET NULL, not RESTRICT: deleting a label from the settings editor must not be blocked by
-- historical jobs still holding it - that would make a settings mistake unfixable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_sub_status_id_fkey') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sub_status_id_fkey"
      FOREIGN KEY ("sub_status_id") REFERENCES "job_sub_statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed; INERT until
--     a non-BYPASSRLS role + DB_TENANT_GUARD=on) ────────────────────────────────
ALTER TABLE "job_sub_statuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_sub_statuses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_sub_statuses";
CREATE POLICY "tenant_isolation" ON "job_sub_statuses"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants (the global sweep in 20260708140000 only
-- covered tables existing at its run time; a new table must repeat this). pg_roles guards keep this
-- valid on CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_sub_statuses FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_sub_statuses FROM authenticated';
  END IF;
END $$;
