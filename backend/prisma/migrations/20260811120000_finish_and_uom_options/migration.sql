-- Finish entity + UoM option list for the inventory Add/Edit Item dialog.
--
-- Finish is a real per-org entity mirroring `brands`, with an FK on the item.
-- The column is brand new, so there is no data to backfill.
--
-- uom_options deliberately does NOT get an FK from price_book_items. The item's
-- `uom` column stays a string because the same value is already carried on PO
-- lines, stock movements, job stage lines and reservation lines; normalizing it
-- would be a cross-table backfill and is a separate project. This table supplies
-- the dropdown's options only.
--
-- Portable (vanilla Postgres only - gen_random_uuid is core since 13) and
-- idempotent (IF NOT EXISTS throughout; the seed is ON CONFLICT DO NOTHING, so a
-- re-run cannot duplicate rows).

CREATE TABLE IF NOT EXISTS "finishes" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "name"            TEXT         NOT NULL,
  "code"            TEXT,
  "is_active"       BOOLEAN      NOT NULL DEFAULT true,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID         NOT NULL,
  CONSTRAINT "finishes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "uom_options" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "code"            TEXT         NOT NULL,
  "label"           TEXT,
  "is_active"       BOOLEAN      NOT NULL DEFAULT true,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID         NOT NULL,
  CONSTRAINT "uom_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "finishes_organization_id_name_key"    ON "finishes" ("organization_id", "name");
CREATE        INDEX IF NOT EXISTS "finishes_organization_id_idx"         ON "finishes" ("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uom_options_organization_id_code_key" ON "uom_options" ("organization_id", "code");
CREATE        INDEX IF NOT EXISTS "uom_options_organization_id_idx"      ON "uom_options" ("organization_id");

-- FKs are added under a guard because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finishes_organization_id_fkey') THEN
    ALTER TABLE "finishes" ADD CONSTRAINT "finishes_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uom_options_organization_id_fkey') THEN
    ALTER TABLE "uom_options" ADD CONSTRAINT "uom_options_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── price_book_items.finish_id ──────────────────────────────────────────────

ALTER TABLE "price_book_items" ADD COLUMN IF NOT EXISTS "finish_id" UUID;
CREATE INDEX IF NOT EXISTS "price_book_items_finish_id_idx" ON "price_book_items" ("finish_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_book_items_finish_id_fkey') THEN
    ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_finish_id_fkey"
      FOREIGN KEY ("finish_id") REFERENCES "finishes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Seed today's hardcoded units per existing org ───────────────────────────
-- Until now the dropdown read a literal array in AddItemDialog.tsx. Seeding the
-- same seven per org means the dropdown looks identical on day one; without this
-- every existing org would open the dialog to an empty unit list.

INSERT INTO "uom_options" ("id", "code", "label", "organization_id", "updated_at")
SELECT gen_random_uuid(), u.code, u.label, o."id", CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES
  ('EA',   'Each'),
  ('FT',   'Feet'),
  ('HR',   'Hour'),
  ('ROLL', 'Roll'),
  ('KIT',  'Kit'),
  ('CYL',  'Cylinder'),
  ('BX',   'Box')
) AS u(code, label)
ON CONFLICT ("organization_id", "code") DO NOTHING;

-- ─── Tenant RLS backstop ─────────────────────────────────────────────────────
-- Same fail-closed pattern as every other org-scoped table (20260703000100_tenant_rls,
-- extended by 20260807160000_tenant_rls_coverage_gap), and inert for the same reason:
-- a BYPASSRLS connection role ignores RLS entirely. src/__tests__/rls-coverage.test.ts
-- fails any new org-scoped table that ships without this.

ALTER TABLE "finishes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finishes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "finishes";
CREATE POLICY "tenant_isolation" ON "finishes"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "uom_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "uom_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "uom_options";
CREATE POLICY "tenant_isolation" ON "uom_options"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense in depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables.
-- Each role is guarded separately: one REVOKE naming both fails outright when only
-- one of the two exists, and anon/authenticated exist on Supabase but not on the
-- vanilla Postgres image CI runs against.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finishes', 'uom_options'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
