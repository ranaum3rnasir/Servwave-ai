-- Inventory P4 (plan §4 Phase 4 / D12): Asset + AssetEvent — company tools
-- assigned to technicians. No stock-quantity semantics; serials NOT unique
-- (duplicate-serial is a UI warn only, QA-38); photo_url stores the canonical
-- Storage path in the `attachments` bucket (Attachment pattern — no data-URIs).
--
-- IDEMPOTENT: IF NOT EXISTS everywhere; enums + FKs inside guarded DO blocks
--   (may run twice on the shared staging DB).
-- PORTABLE: vanilla postgres:16 — RLS policies are TO-public/current_setting
--   (core Postgres); the only Supabase-role objects are the anon/authenticated
--   REVOKEs, guarded behind pg_roles existence checks.

-- ─── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetStatus') THEN
    CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'RETIRED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetEventType') THEN
    CREATE TYPE "AssetEventType" AS ENUM ('ASSIGNED', 'RETURNED', 'TRANSFERRED', 'RETIRED', 'NOTE');
  END IF;
END $$;

-- ─── assets ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "assets" (
  "id"                 UUID NOT NULL,
  "name"               TEXT NOT NULL,
  "serial"             TEXT,
  "photo_url"          TEXT,
  "price_book_item_id" UUID,
  "status"             "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
  "assigned_user_id"   UUID,
  "notes"              TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  "organization_id"    UUID NOT NULL,
  CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "assets_organization_id_idx"    ON "assets"("organization_id");
CREATE INDEX IF NOT EXISTS "assets_assigned_user_id_idx"   ON "assets"("assigned_user_id");
CREATE INDEX IF NOT EXISTS "assets_price_book_item_id_idx" ON "assets"("price_book_item_id");
CREATE INDEX IF NOT EXISTS "assets_status_idx"             ON "assets"("status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_price_book_item_id_fkey') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_price_book_item_id_fkey"
      FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_assigned_user_id_fkey') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_user_id_fkey"
      FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_organization_id_fkey') THEN
    ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── asset_events (append-only history ledger) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "asset_events" (
  "id"              UUID NOT NULL,
  "asset_id"        UUID NOT NULL,
  "type"            "AssetEventType" NOT NULL,
  "user_id"         UUID,
  "by_user_id"      UUID,
  "note"            TEXT,
  "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "asset_events_asset_id_at_idx"      ON "asset_events"("asset_id", "at");
CREATE INDEX IF NOT EXISTS "asset_events_organization_id_idx"  ON "asset_events"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_events_asset_id_fkey') THEN
    ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_fkey"
      FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_events_user_id_fkey') THEN
    ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_events_by_user_id_fkey') THEN
    ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_by_user_id_fkey"
      FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_events_organization_id_fkey') THEN
    ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern;
--     fail-closed; INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "assets";
CREATE POLICY "tenant_isolation" ON "assets"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "asset_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "asset_events";
CREATE POLICY "tenant_isolation" ON "asset_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new
--     tables (gmail precedent 20260716210000; the dynamic sweep in
--     20260708140000 only covered tables existing at its run time).
--     pg_roles guards keep this valid on CI's vanilla postgres. ───────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.assets FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.asset_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.assets FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.asset_events FROM authenticated';
  END IF;
END $$;
