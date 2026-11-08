-- Pending click-to-call attribution stash (comm slice E1). POST /calls on a
-- CTM-connected org places a REAL bridge and writes NO CallSession row — the
-- 'starts'/'end' webhooks create it later — so the job/lead/customer context
-- picked in the dialer is stashed here and consumed by ingestCall (30-min
-- window, atomic claim on consumed_at). Rows are ephemeral: plain UUID columns
-- validated at insert, deliberately NO FKs to jobs/leads/customers/users.
--
-- Idempotent + portable on purpose: this runs on CI's vanilla postgres:16, on
-- Render deploy, and possibly twice against the SHARED staging Supabase DB.
-- NEVER run `prisma migrate` from a worktree. Supabase-only roles are
-- existence-guarded so the SQL stays valid on core Postgres.

CREATE TABLE IF NOT EXISTS "pending_call_attributions" (
  "id"              UUID NOT NULL,
  "to_number"       TEXT NOT NULL,
  "job_id"          UUID,
  "job_label"       TEXT,
  "lead_id"         UUID,
  "customer_id"     UUID,
  "requested_by"    UUID,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at"     TIMESTAMP(3),
  "organization_id" UUID NOT NULL,
  CONSTRAINT "pending_call_attributions_pkey" PRIMARY KEY ("id")
);

-- Webhook consume path: lookup by (org, destination, recency).
CREATE INDEX IF NOT EXISTS "pending_call_attributions_organization_id_to_number_created_idx"
  ON "pending_call_attributions"("organization_id", "to_number", "created_at");

DO $$ BEGIN
  ALTER TABLE "pending_call_attributions" ADD CONSTRAINT "pending_call_attributions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop for the new org-scoped table (same fail-closed pattern
-- as phone_numbers in 20260709220000_ctm_phone_system: INERT until the app
-- connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on).
ALTER TABLE "pending_call_attributions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_call_attributions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "pending_call_attributions";
CREATE POLICY "tenant_isolation" ON "pending_call_attributions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants from the new table.
-- The dynamic sweep in 20260708140000_revoke_api_roles_on_tenant_tables ran
-- before this table existed, so it needs its own revoke. Guarded:
-- anon/authenticated exist only on Supabase, not CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.pending_call_attributions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.pending_call_attributions FROM authenticated';
  END IF;
END $$;
