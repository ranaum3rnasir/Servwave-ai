-- Payments go-live, slice 37: the nightly reconcile's per-org summary row
-- (md_files/plans/payments/2026-10-05-payments-go-live/03-slices/37-nightly-reconcile.md).
--
-- One row per org per run: the window compared, a status (CLEAN / DRIFT / ERROR), the count of each
-- drift kind found and of each self-repair made. "Zero drift for seven nights" is read from it.
--
-- PURE EXPAND: one new table, its index and foreign key, and the tenant RLS backstop. Nothing
-- existing is touched. IDEMPOTENT + portable (CI's vanilla postgres:16, the Render deploy, a second
-- run on the shared staging DB): IF NOT EXISTS everywhere, the policy dropped before it is created,
-- the Supabase-only roles behind a pg_roles guard. NEVER run `prisma migrate` from a worktree.

CREATE TABLE IF NOT EXISTS "payment_reconcile_runs" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "started_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "window_start"    TIMESTAMP(3) NOT NULL,
  "window_end"      TIMESTAMP(3) NOT NULL,
  "status"          TEXT NOT NULL,
  "drift_count"     INTEGER NOT NULL DEFAULT 0,
  "counts"          JSONB NOT NULL DEFAULT '{}',
  "repaired"        JSONB NOT NULL DEFAULT '{}',
  "error"           TEXT,
  CONSTRAINT "payment_reconcile_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payment_reconcile_runs_organization_id_started_at_idx" ON "payment_reconcile_runs"("organization_id", "started_at");

DO $$ BEGIN
  ALTER TABLE "payment_reconcile_runs" ADD CONSTRAINT "payment_reconcile_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls); rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "payment_reconcile_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_reconcile_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payment_reconcile_runs";
CREATE POLICY "tenant_isolation" ON "payment_reconcile_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants (anon/authenticated exist only on Supabase).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payment_reconcile_runs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payment_reconcile_runs FROM authenticated';
  END IF;
END $$;
