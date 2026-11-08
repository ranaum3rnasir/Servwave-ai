-- External call-tracking webhook receiver (plan:
-- md_files/plans/communication/2026-09-10-external-call-tracking-webhook-receiver.md).
--
-- A customer keeps its tracking numbers with an outside call-tracking vendor and forwards them to
-- ServWave numbers. The vendor pushes the marketing session (source, landing page, gclid) to us on
-- pre-call and post-call; the inbound ingest joins it to the call row by caller + time window.
--
-- PURE EXPAND. One new table, one new enum, nullable columns on two existing tables, indexes.
-- Nothing is dropped or renamed, so the old instance during the deploy overlap never names a
-- column that has gone (see 20260908120000_manual_comm_customer_anchor's header for the hazard).
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS / guarded, plain DDL, no Supabase-only
-- objects. Runs on CI's vanilla postgres:16, on Render deploy, and possibly twice against the
-- shared staging DB. NEVER run `prisma migrate` from a worktree.

-- ─── 1. Provider enum ─────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CallTrackingProvider') THEN
    CREATE TYPE "CallTrackingProvider" AS ENUM ('callrail', 'whatconverts');
  END IF;
END $$;

-- ─── 2. Integration rows: one per (org, provider) ─────────────────────────────

CREATE TABLE IF NOT EXISTS "call_tracking_integrations" (
  "id"              UUID NOT NULL,
  "provider"        "CallTrackingProvider" NOT NULL,
  "url_token"       TEXT NOT NULL,
  "signing_key"     TEXT,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "last_event_at"   TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "call_tracking_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_tracking_integrations_url_token_key"
  ON "call_tracking_integrations"("url_token");
CREATE UNIQUE INDEX IF NOT EXISTS "call_tracking_integrations_organization_id_provider_key"
  ON "call_tracking_integrations"("organization_id", "provider");

DO $$ BEGIN
  ALTER TABLE "call_tracking_integrations" ADD CONSTRAINT "call_tracking_integrations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, same fail-closed pattern as pending_call_attributions
-- (20260714020000): inert until the app connects as a non-BYPASSRLS role AND
-- DB_TENANT_GUARD=on. The receiver runs under unscopedRequest and resolves the
-- org from the URL token itself.
ALTER TABLE "call_tracking_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_tracking_integrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "call_tracking_integrations";
CREATE POLICY "tenant_isolation" ON "call_tracking_integrations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants (the dynamic sweep in 20260708140000 ran before
-- this table existed). Guarded: anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.call_tracking_integrations FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.call_tracking_integrations FROM authenticated';
  END IF;
END $$;

-- ─── 3. Inbound half of the pending-attribution stash ─────────────────────────
--
-- The stash was click-to-call only (keyed on to_number). A vendor pre-call event
-- is keyed on the CALLER instead, and carries the marketing session to write
-- onto the call row when the inbound ingest claims it.

ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "from_number" TEXT;
ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "provider" "CallTrackingProvider";
ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "vendor_call_id" TEXT;
ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "tracking_source" TEXT;
ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "attribution" JSONB;

-- Idempotent pre-call: a re-delivered event updates the same stash row. NULLs
-- are distinct, so the click-to-call rows (both columns null) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "pending_call_attributions_provider_vendor_call_id_key"
  ON "pending_call_attributions"("provider", "vendor_call_id");

-- Inbound claim path: lookup by (org, caller, recency).
CREATE INDEX IF NOT EXISTS "pending_call_attributions_organization_id_from_number_created_idx"
  ON "pending_call_attributions"("organization_id", "from_number", "created_at");

-- ─── 4. The vendor handle on the call row ─────────────────────────────────────
--
-- Post-call enrichment (duration, recording link, up to 20 minutes after
-- hangup) finds the row by this pair instead of re-running the caller join.

ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "call_tracking_provider" "CallTrackingProvider";
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "vendor_call_id" TEXT;

CREATE INDEX IF NOT EXISTS "call_sessions_call_tracking_provider_vendor_call_id_idx"
  ON "call_sessions"("call_tracking_provider", "vendor_call_id");
