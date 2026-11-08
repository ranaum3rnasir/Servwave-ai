-- Email slice 7 (Resend send path): real files attached to a human-composed
-- send. Mirrors the estimate_line_item_photos / estimate_scope_photos precedent
-- (20260722160000) exactly - a fresh model, Supabase Storage `attachments`
-- bucket, storage_path canonical, no data-URI column.
--
-- `position` fixes attachment order for both display and the download endpoint,
-- which indexes into the SAME [position asc, created_at asc] ordering - the two
-- must never drift out of sync (see comment on the Prisma model).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; FKs inside guarded DO blocks
--   (may run twice on the shared staging DB).
-- PORTABLE: vanilla postgres:16 - RLS policy is TO-public/current_setting (core
--   Postgres); the only Supabase-role objects are the anon/authenticated
--   REVOKEs, guarded behind pg_roles existence checks.

CREATE TABLE IF NOT EXISTS "email_attachments" (
  "id"              UUID NOT NULL,
  "email_id"        UUID NOT NULL,
  "file_name"       TEXT NOT NULL,
  "content_type"    TEXT NOT NULL,
  "file_size"       INTEGER NOT NULL,
  "storage_path"    TEXT NOT NULL,
  "position"        INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_attachments_email_id_idx"        ON "email_attachments"("email_id");
CREATE INDEX IF NOT EXISTS "email_attachments_organization_id_idx" ON "email_attachments"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_attachments_email_id_fkey') THEN
    ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_id_fkey"
      FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_attachments_organization_id_fkey') THEN
    ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "email_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_attachments";
CREATE POLICY "tenant_isolation" ON "email_attachments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new table
--     (gmail precedent 20260716210000; the dynamic sweep in 20260708140000 only
--     covered tables existing at its run time). pg_roles guards keep this valid
--     on CI's vanilla postgres. ─────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_attachments FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_attachments FROM authenticated';
  END IF;
END $$;
