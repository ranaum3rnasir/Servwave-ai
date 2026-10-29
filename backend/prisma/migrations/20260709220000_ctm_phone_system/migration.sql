-- CTM phone system: ctm_events idempotency ledger + phone_numbers + ctm columns
-- on organizations/call_sessions/messages + COMMUNICATION notification category
-- + CALL_MISSED automation trigger.
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB. NEVER run `prisma migrate` from a worktree. Applied by
-- CI (vanilla postgres:16) + Render deploy; portable: standard Postgres only —
-- Supabase-only role grants are existence-guarded. Safe to re-run.

-- New enum value. PG12+ allows ADD VALUE inside a transaction as long as the
-- new value is not used in the same transaction — it is not used below.
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'COMMUNICATION';

-- Global webhook-idempotency ledger (mirrors stripe_events: no org column; the
-- owning org is resolved per event via organizations.ctm_account_id).
CREATE TABLE IF NOT EXISTS "ctm_events" (
  "id"           UUID NOT NULL,
  "ctm_event_id" TEXT NOT NULL,
  "event_type"   TEXT NOT NULL,
  "payload"      JSONB,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ctm_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ctm_events_ctm_event_id_key" ON "ctm_events"("ctm_event_id");

CREATE TABLE IF NOT EXISTS "phone_numbers" (
  "id"              UUID NOT NULL,
  "e164"            TEXT NOT NULL,
  "formatted"       TEXT,
  "label"           TEXT,
  "source"          TEXT NOT NULL DEFAULT 'ctm',
  "type"            TEXT,
  "capabilities"    JSONB,
  "sms_enabled"     BOOLEAN NOT NULL DEFAULT false,
  "ctm_number_id"   TEXT,
  "route_to"        JSONB,
  "call_flow_id"    UUID,
  "status"          TEXT NOT NULL DEFAULT 'active',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_organization_id_e164_key" ON "phone_numbers"("organization_id","e164");
CREATE INDEX IF NOT EXISTS "phone_numbers_organization_id_idx" ON "phone_numbers"("organization_id");
CREATE INDEX IF NOT EXISTS "phone_numbers_ctm_number_id_idx" ON "phone_numbers"("ctm_number_id");

DO $$ BEGIN
  ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_call_flow_id_fkey"
    FOREIGN KEY ("call_flow_id") REFERENCES "call_flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- New columns on existing tables.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ctm_account_id" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "ctm_sms_ready" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_ctm_account_id_key" ON "organizations"("ctm_account_id");

ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "ctm_call_id" TEXT;
ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "recording_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "call_sessions_ctm_call_id_key" ON "call_sessions"("ctm_call_id");

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "ctm_sms_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "messages_ctm_sms_id_key" ON "messages"("ctm_sms_id");

-- Tenant RLS backstop for the new org-scoped table (same fail-closed pattern as
-- 20260707120000_estimate_workspace_rls_backstop: INERT until the app connects
-- as a non-BYPASSRLS role AND DB_TENANT_GUARD=on).
ALTER TABLE "phone_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "phone_numbers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "phone_numbers";
CREATE POLICY "tenant_isolation" ON "phone_numbers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants from both new tables.
-- The dynamic sweep in 20260708140000_revoke_api_roles_on_tenant_tables ran
-- before these tables existed, so they need their own revoke. Guarded:
-- anon/authenticated exist only on Supabase, not CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.ctm_events, public.phone_numbers FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.ctm_events, public.phone_numbers FROM authenticated';
  END IF;
END $$;
