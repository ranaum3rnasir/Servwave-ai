-- Idempotent + portable. Applied by Render `prisma migrate deploy` on merge, and
-- (for pre-merge e2e) via Supabase MCP to STAGING first, then PROD. NEVER run
-- `prisma migrate` from a worktree (local .env points at staging). Safe to re-run.
--
-- Per-user acceptance of ServWave's Terms of Service + Privacy Policy (SERV10X-17).
-- Append-only legal record. Self-contained (no FKs) so a row outlives deletion of
-- the accepting user (mirrors audit_logs). Writes happen on POST /api/auth/accept-invite,
-- which runs unscoped (app.bypass_rls='on'), so the WITH CHECK passes via the bypass clause.

CREATE TABLE IF NOT EXISTS "terms_acceptances" (
  "id"              UUID        NOT NULL,
  "user_id"         UUID        NOT NULL,
  "user_email"      TEXT        NOT NULL,
  "organization_id" UUID        NOT NULL,
  "terms_version"   TEXT        NOT NULL,
  "terms_url"       TEXT        NOT NULL,
  "privacy_url"     TEXT        NOT NULL,
  "context"         TEXT        NOT NULL DEFAULT 'invite_acceptance',
  "ip_address"      TEXT,
  "user_agent"      TEXT,
  "accepted_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "terms_acceptances_organization_id_idx"
  ON "terms_acceptances" ("organization_id");
CREATE INDEX IF NOT EXISTS "terms_acceptances_user_id_idx"
  ON "terms_acceptances" ("user_id");

-- Tenant-isolation RLS backstop (matches every other org-scoped table). TO public
-- → portable to vanilla Postgres (CI migration-check). Keys off the transaction-local
-- session vars the app sets in lib/tenant-guard.ts. Idempotent.
ALTER TABLE "terms_acceptances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terms_acceptances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "terms_acceptances";
CREATE POLICY "tenant_isolation" ON "terms_acceptances"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: revoke default PostgREST grants (Supabase-only roles; guarded
-- for vanilla Postgres). Idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public."terms_acceptances" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public."terms_acceptances" FROM authenticated';
  END IF;
END $$;
