-- Web-form lead intake, slice 1 (plan:
-- md_files/plans/communication/2026-09-18-web-form-lead-intake.md).
--
-- A customer takes leads through website forms. The form plugin POSTs each submission to a
-- per-org URL token here; the receiver acks immediately and records the submission. Slice 2
-- turns a recorded submission into a Customer + Lead.
--
-- EXPAND. Two new tables and one new enum. No column, table or type is dropped or renamed, so the
-- old instance during the deploy overlap never names something that has gone (see
-- 20260908120000_manual_comm_customer_anchor's header for the hazard). The single exception is one
-- DROP INDEX in §3, which is invisible to a running instance and is there because this file was
-- edited in place - its own comment says why.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS / guarded, plain DDL, no Supabase-only
-- objects. Runs on CI's vanilla postgres:16, on Render deploy, and possibly twice against the
-- shared staging DB. NEVER run `prisma migrate` from a worktree.

-- ─── 1. Provider enum ─────────────────────────────────────────────────────────
--
-- One value today. The enum exists so a second form vendor is a migration rather than a redesign.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebFormProvider') THEN
    CREATE TYPE "WebFormProvider" AS ENUM ('forminator');
  END IF;
END $$;

-- ─── 2. Integration rows: one per (org, provider) ─────────────────────────────
--
-- DELIBERATELY NO `signing_key` column. This vendor offers no signature of any kind - no secret,
-- no HMAC, no bearer, no custom header. The 32-byte URL token is the only gate, and a nullable
-- column nothing could ever fill would invite the next reader to assume otherwise.

CREATE TABLE IF NOT EXISTS "web_form_integrations" (
  "id"                  UUID NOT NULL,
  "provider"            "WebFormProvider" NOT NULL,
  "url_token"           TEXT NOT NULL,
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "field_map"           JSONB,
  "default_lead_source" TEXT,
  "last_event_at"       TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  "organization_id"     UUID NOT NULL,
  CONSTRAINT "web_form_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "web_form_integrations_url_token_key"
  ON "web_form_integrations"("url_token");
CREATE UNIQUE INDEX IF NOT EXISTS "web_form_integrations_organization_id_provider_key"
  ON "web_form_integrations"("organization_id", "provider");

DO $$ BEGIN
  ALTER TABLE "web_form_integrations" ADD CONSTRAINT "web_form_integrations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── 3. Submission ledger ─────────────────────────────────────────────────────
--
-- Claim-first idempotency on (organization_id, provider, submission_key). `lead_id` and
-- `customer_id` carry NO foreign key on purpose: the row is written from an unauthenticated
-- webhook before either record exists, and slice 2 fills them (same shape as
-- pending_call_attributions).
--
-- THE ORG IS IN THE KEY, and that is where this DIFFERS from ctm_events, whose ctm_event_id is
-- globally unique and correctly so: that id is minted by ONE vendor account every org shares.
-- A form plugin's entry id is minted PER SITE - it is that site's sequential entry counter, so
-- every site's second submission is `2` - and the derived fallback key hashes (form title,
-- contact handle, minute), none of which is org-specific either. Under a two-column key one
-- org's ordinary submission raises a duplicate-key error on another org's row, and the receiver
-- reads that as "somebody else got there first": no ledger row, no Customer, no Lead, and a log
-- line that reads like healthy de-duplication. Same-looking shape, opposite tenancy.

CREATE TABLE IF NOT EXISTS "web_form_submissions" (
  "id"              UUID NOT NULL,
  "provider"        "WebFormProvider" NOT NULL,
  "submission_key"  TEXT NOT NULL,
  "form_title"      TEXT,
  "payload"         JSONB NOT NULL,
  "lead_id"         UUID,
  "customer_id"     UUID,
  "received_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "web_form_submissions_pkey" PRIMARY KEY ("id")
);

-- THIS FILE WAS EDITED IN PLACE. An earlier version created the ledger's unique index on
-- ("provider", "submission_key") - under the DIFFERENT name dropped just below - before the org
-- was added to the key. Every statement here is IF NOT EXISTS, so a database that ran that earlier
-- version would keep the old global index and go on enforcing a cross-tenant key for ever: one
-- org's ordinary submission raising a duplicate-key error on another org's row, which the receiver
-- reads as healthy de-duplication and stores nothing for. The DROP is what makes this file
-- converge on the same schema whichever version the database has already seen.
--
-- Staging and production both top out at 20260915170000 and never ran either version, so there it
-- is latent. A developer database, a CI run or a branch checkout that applied the earlier version
-- is not.
--
-- Dropping an INDEX is not the hazard the "pure expand" note at the top is about: the old instance
-- during a deploy overlap names no column that has gone, so it cannot break on this.
DROP INDEX IF EXISTS "web_form_submissions_provider_submission_key_key";

-- The name is Prisma's own generated name for this @@unique, TRUNCATED: the untruncated
-- `..._organization_id_provider_submission_key_key` is 64 characters and Postgres's identifier
-- limit is 63, so Prisma emits `..._submission_ke_key` (exactly 63). Spelling it out in full here
-- would create an index Prisma does not believe in, i.e. permanent drift. Measured, not assumed -
-- `prisma migrate diff --from-empty --to-schema-datamodel` prints this name.
CREATE UNIQUE INDEX IF NOT EXISTS "web_form_submissions_organization_id_provider_submission_ke_key"
  ON "web_form_submissions"("organization_id", "provider", "submission_key");
CREATE INDEX IF NOT EXISTS "web_form_submissions_organization_id_received_at_idx"
  ON "web_form_submissions"("organization_id", "received_at");

DO $$ BEGIN
  ALTER TABLE "web_form_submissions" ADD CONSTRAINT "web_form_submissions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── 4. Tenant RLS backstop on both new org-scoped tables ─────────────────────
--
-- Same fail-closed pattern as call_tracking_integrations (20260910120000): inert until the app
-- connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on. The receiver runs under
-- unscopedRequest and resolves the org from the URL token itself.

ALTER TABLE "web_form_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "web_form_integrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "web_form_integrations";
CREATE POLICY "tenant_isolation" ON "web_form_integrations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "web_form_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "web_form_submissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "web_form_submissions";
CREATE POLICY "tenant_isolation" ON "web_form_submissions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── 5. Strip PostgREST role grants ───────────────────────────────────────────
--
-- The dynamic sweep in 20260708140000 ran before these tables existed. Guarded: anon/authenticated
-- exist only on Supabase, so CI's vanilla Postgres skips the block.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.web_form_integrations FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.web_form_submissions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.web_form_integrations FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.web_form_submissions FROM authenticated';
  END IF;
END $$;
