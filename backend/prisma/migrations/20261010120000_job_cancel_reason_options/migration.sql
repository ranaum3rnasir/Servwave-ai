-- Roles & Permissions Overhaul, PRD 6 (job close-out), slice S06.14: the per-org job cancel-reasons list.
--
-- The job twin of `lost_reason_options` (20260915130000_lost_reason_options) with the same mechanics: a per-org option
-- list keyed on a CODE STRING that the owning row will store verbatim (a cancelled job, slice S06.15), never by foreign
-- key. Editing it never touches the estimate decline reasons: separate table, separate routes.
--
-- PURE EXPAND, AND NOTHING ELSE. One new table, its indexes, its FK and the RLS backstop. Nothing is dropped, renamed or
-- backfilled, so the old instance running during the deploy overlap never names a column that has gone.
--
-- NO SEED ROWS, ON PURPOSE. An organisation with zero rows here resolves to the six built-in reasons in code; its FIRST
-- edit materialises all six at once.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS or guarded, plain DDL, no Supabase-only objects. Runs on CI's
-- vanilla postgres:16, on the Render deploy, and possibly twice against the shared staging DB.

CREATE TABLE IF NOT EXISTS "job_cancel_reason_options" (
  "id"              UUID NOT NULL,
  -- The stored value. Immutable after create: a cancelled job holds this string.
  "code"            TEXT NOT NULL,
  -- The words the cancel dialogs show. Renameable, and renaming rewrites no job.
  "label"           TEXT NOT NULL,
  -- Turned off, never deleted: a job that used the reason keeps showing it.
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "job_cancel_reason_options_pkey" PRIMARY KEY ("id")
);

-- One row per code per org. Also what makes materialisation safe under a race: two admins saving at once both try to
-- insert the six built-ins, and the second insert is skipped on the conflict instead of doubling the list.
CREATE UNIQUE INDEX IF NOT EXISTS "job_cancel_reason_options_organization_id_code_key"
  ON "job_cancel_reason_options"("organization_id", "code");

-- Every read of this table is "this org's list, in the admin's order".
CREATE INDEX IF NOT EXISTS "job_cancel_reason_options_organization_id_sort_order_idx"
  ON "job_cancel_reason_options"("organization_id", "sort_order");

DO $$ BEGIN
  ALTER TABLE "job_cancel_reason_options" ADD CONSTRAINT "job_cancel_reason_options_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries (rls-coverage.test.ts requires it of
-- every table with an organization_id column).
ALTER TABLE "job_cancel_reason_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_cancel_reason_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_cancel_reason_options";
CREATE POLICY "tenant_isolation" ON "job_cancel_reason_options"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_cancel_reason_options FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.job_cancel_reason_options FROM authenticated';
  END IF;
END $$;
