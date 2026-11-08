-- Gmail inbox mirror (Plan G / DEC5): per-org connected mailbox + real-provider
-- columns on emails. email_accounts holds ONE row per org v1 (unique org+provider);
-- refresh_token_enc is AES-256-GCM ciphertext (lib/gmail/crypto.ts) — never
-- plaintext. emails gains idempotent-upsert + threading + reply-header columns;
-- existing prototype/system rows keep NULLs everywhere.
--
-- Idempotent + portable on purpose: this runs on CI's vanilla postgres:16, on
-- Render deploy, and possibly twice against the SHARED staging Supabase DB.
-- NEVER run `prisma migrate` from a worktree. Supabase-only roles are
-- existence-guarded so the SQL stays valid on core Postgres.

CREATE TABLE IF NOT EXISTS "email_accounts" (
  "id"                UUID NOT NULL,
  "provider"          TEXT NOT NULL DEFAULT 'gmail',
  "email_address"     TEXT NOT NULL,
  "refresh_token_enc" TEXT NOT NULL,
  "history_id"        TEXT,
  "last_sync_at"      TIMESTAMP(3),
  "watch_expiration"  TIMESTAMP(3),
  "status"            TEXT NOT NULL DEFAULT 'active',
  "last_error"        TEXT,
  "sync_from"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  "user_id"           UUID,
  "organization_id"   UUID NOT NULL,
  CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_accounts_organization_id_provider_key"
  ON "email_accounts"("organization_id", "provider");
CREATE INDEX IF NOT EXISTS "email_accounts_status_idx" ON "email_accounts"("status");

DO $$ BEGIN
  ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── emails: Gmail-mirror columns (all nullable → zero impact on existing rows) ───
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "email_account_id"  UUID;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "direction"         TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "gmail_message_id"  TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "rfc822_message_id" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "in_reply_to"       TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "references_header" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "cc"                TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "bcc"               TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "body_html"         TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "emails_gmail_message_id_key" ON "emails"("gmail_message_id");
CREATE INDEX IF NOT EXISTS "emails_email_account_id_idx" ON "emails"("email_account_id");
CREATE INDEX IF NOT EXISTS "emails_organization_id_thread_id_idx" ON "emails"("organization_id", "thread_id");

DO $$ BEGIN
  ALTER TABLE "emails" ADD CONSTRAINT "emails_email_account_id_fkey"
    FOREIGN KEY ("email_account_id") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop for the new org-scoped table (same fail-closed pattern
-- as pending_call_attributions: INERT until the app connects as a
-- non-BYPASSRLS role AND DB_TENANT_GUARD=on).
ALTER TABLE "email_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_accounts";
CREATE POLICY "tenant_isolation" ON "email_accounts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants from the new table
-- (it stores encrypted OAuth refresh tokens — nothing client-side may touch it).
-- Guarded: anon/authenticated exist only on Supabase, not CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_accounts FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_accounts FROM authenticated';
  END IF;
END $$;
