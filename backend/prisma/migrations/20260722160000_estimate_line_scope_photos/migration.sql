-- Estimate line-item + scope-of-work photos (R5f, 2026-07-22): attach photos to an
-- EstimateLineItem and to a scope-of-work block. Mirrors the JobStageAttachment precedent
-- (Supabase Storage `attachments` bucket, storage_path canonical — no data-URI column here since
-- this is a fresh model, not a legacy-migrating one).
--
-- estimate_scope_photos carries BOTH estimate_id AND scope_id (never scope_id alone): Estimate.
-- scopes is a raw JSONB array with no relational ScopeOfWork row, and duplicate()/revise() copy
-- `scopes` verbatim INCLUDING each block's id, so the same scope id can legitimately exist in two
-- different estimates' scopes[] at once. Every lookup against this table must filter on the
-- compound (estimate_id, scope_id).
--
-- IDEMPOTENT: IF NOT EXISTS everywhere; FKs inside guarded DO blocks (may run twice on the shared
--   staging DB).
-- PORTABLE: vanilla postgres:16 — RLS policies are TO-public/current_setting (core Postgres); the
--   only Supabase-role objects are the anon/authenticated REVOKEs, guarded behind pg_roles
--   existence checks.

-- ─── estimate_line_item_photos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "estimate_line_item_photos" (
  "id"                    UUID NOT NULL,
  "estimate_line_item_id" UUID NOT NULL,
  "storage_path"          TEXT NOT NULL,
  "mime_type"             TEXT NOT NULL,
  "caption"               TEXT,
  "uploaded_at"           TIMESTAMP(3) NOT NULL,
  "uploaded_by"           TEXT NOT NULL,
  "size_bytes"            INTEGER,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  "organization_id"       UUID NOT NULL,
  CONSTRAINT "estimate_line_item_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "estimate_line_item_photos_estimate_line_item_id_idx" ON "estimate_line_item_photos"("estimate_line_item_id");
CREATE INDEX IF NOT EXISTS "estimate_line_item_photos_organization_id_idx"       ON "estimate_line_item_photos"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_line_item_photos_estimate_line_item_id_fkey') THEN
    ALTER TABLE "estimate_line_item_photos" ADD CONSTRAINT "estimate_line_item_photos_estimate_line_item_id_fkey"
      FOREIGN KEY ("estimate_line_item_id") REFERENCES "estimate_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_line_item_photos_organization_id_fkey') THEN
    ALTER TABLE "estimate_line_item_photos" ADD CONSTRAINT "estimate_line_item_photos_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── estimate_scope_photos ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "estimate_scope_photos" (
  "id"              UUID NOT NULL,
  "estimate_id"     UUID NOT NULL,
  "scope_id"        TEXT NOT NULL,
  "storage_path"    TEXT NOT NULL,
  "mime_type"       TEXT NOT NULL,
  "caption"         TEXT,
  "uploaded_at"     TIMESTAMP(3) NOT NULL,
  "uploaded_by"     TEXT NOT NULL,
  "size_bytes"      INTEGER,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "estimate_scope_photos_pkey" PRIMARY KEY ("id")
);

-- Compound (estimate_id, scope_id) — the only safe lookup key (see header note).
CREATE INDEX IF NOT EXISTS "estimate_scope_photos_estimate_id_scope_id_idx" ON "estimate_scope_photos"("estimate_id", "scope_id");
CREATE INDEX IF NOT EXISTS "estimate_scope_photos_organization_id_idx"      ON "estimate_scope_photos"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_scope_photos_estimate_id_fkey') THEN
    ALTER TABLE "estimate_scope_photos" ADD CONSTRAINT "estimate_scope_photos_estimate_id_fkey"
      FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_scope_photos_organization_id_fkey') THEN
    ALTER TABLE "estimate_scope_photos" ADD CONSTRAINT "estimate_scope_photos_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "estimate_line_item_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_line_item_photos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_line_item_photos";
CREATE POLICY "tenant_isolation" ON "estimate_line_item_photos"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "estimate_scope_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_scope_photos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_scope_photos";
CREATE POLICY "tenant_isolation" ON "estimate_scope_photos"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new
--     tables (gmail precedent 20260716210000; the dynamic sweep in
--     20260708140000 only covered tables existing at its run time).
--     pg_roles guards keep this valid on CI's vanilla postgres. ───────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.estimate_line_item_photos FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.estimate_scope_photos FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.estimate_line_item_photos FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.estimate_scope_photos FROM authenticated';
  END IF;
END $$;
