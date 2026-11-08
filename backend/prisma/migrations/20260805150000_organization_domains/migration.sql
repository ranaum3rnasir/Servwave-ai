-- Email slice 10 (guided domain verification) — an org's OWN verified
-- sending domain, as an opt-in, additive alternative to the shared
-- env.EMAIL_FROM_BUSINESS domain (decision 16 stays the default for every
-- org that never sets this up).
--
-- One row per org (organization_id UNIQUE — this slice does not support
-- multiple custom domains for one org). `status` mirrors Resend's own
-- DomainStatus vocabulary verbatim as a plain TEXT column (not an enum), so a
-- new value Resend adds later never needs a migration. `records` is the raw
-- DomainRecords[] array Resend returned on the last create/get/webhook.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; FK behind a pg_constraint
--   existence check.
-- PORTABLE: vanilla postgres:16 (CI migration-check) — the only Supabase-role
--   touches are the anon/authenticated REVOKEs, guarded behind pg_roles checks.

CREATE TABLE IF NOT EXISTS "organization_domains" (
  "id"                    UUID NOT NULL,
  "organization_id"       UUID NOT NULL,
  "domain_name"           TEXT NOT NULL,
  "resend_domain_id"      TEXT NOT NULL,
  "status"                TEXT NOT NULL,
  "records"               JSONB NOT NULL,
  "detected_dns_provider" TEXT,
  "verified_at"           TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_domains_organization_id_key" ON "organization_domains"("organization_id");
-- Correlates a live Resend event/response back to a row (mirrors emails.provider_message_id).
CREATE UNIQUE INDEX IF NOT EXISTS "organization_domains_resend_domain_id_key" ON "organization_domains"("resend_domain_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_domains_organization_id_fkey') THEN
    ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_domains" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_domains";
CREATE POLICY "tenant_isolation" ON "organization_domains"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new
--     table (email_threads/email_read_states precedent). pg_roles guards keep
--     this valid on CI's vanilla postgres. ─────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.organization_domains FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.organization_domains FROM authenticated';
  END IF;
END $$;
