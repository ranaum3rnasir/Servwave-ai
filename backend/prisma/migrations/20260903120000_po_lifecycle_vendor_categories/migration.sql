-- Purchasing Audit Verdict, PR 2 (slice S2.1) - the ONE migration for the whole verdict.
--
-- Covers every schema change the verdict asks for, including PR 4's vendor_categories table and
-- vendors.category_id (PR 4 only consumes them). Four concerns, in dependency order:
--
--   1. purchase_orders gains an honest lifecycle: notes to the vendor, who ordered it and when
--      (ordered_at becomes NULLABLE - a draft has no order date; "Ordered" never means "created"),
--      a real received_at behind the History grid's "Received on", and a persisted buyer signature.
--      The retired `sent` status is folded into `ordered` (prod has none; staging has three).
--   2. vendor_categories: one row per (org, name), seeded from every distinct non-empty
--      vendors.category per org, so PR 4's picker starts with the categories the org already uses.
--   3. vendors.category_id: nullable FK to that table, back-filled by exact name within the org.
--      The legacy `category` string column stays as the display snapshot for now.
--   4. vendors.payment_terms / lead_time_days / transmit_method: DROP NOT NULL so the vendor
--      controller can stop writing them (PR 1 removed them from the contract). Dropping the
--      columns is a later migration - the old instance still selects them during the deploy overlap.
--
-- Deploy-overlap safe: everything here is additive or loosens a constraint. A `select`-less Prisma
-- query on the OLD instance enumerates its build-time column list, which this migration keeps
-- intact (nothing is dropped or renamed).
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards / WHERE NOT EXISTS / DROP POLICY IF EXISTS)
-- and portable: the anon/authenticated REVOKEs are guarded behind a role-existence check so this
-- applies cleanly to CI's vanilla postgres:16 as well as to Supabase. NEVER run `prisma migrate`
-- from a worktree - this file is applied by CI, by the Render deploy, or by hand through the
-- Supabase MCP.

-- ─── 1. purchase_orders lifecycle columns ────────────────────────────────────

ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "notes"          TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "ordered_by_id"  UUID;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "received_at"    TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "signature_data" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "signature_name" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "signature_at"   TIMESTAMP(3);

-- A draft has no order date. New POs are created with ordered_at NULL; only "Mark as ordered"
-- (or an import that says `status: 'ordered'`) stamps it.
ALTER TABLE "purchase_orders" ALTER COLUMN "ordered_at" DROP NOT NULL;

-- Who marked it ordered. SET NULL on user deletion: the PO outlives the buyer's account.
DO $$ BEGIN
  ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_ordered_by_id_fkey"
    FOREIGN KEY ("ordered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- `sent` is retired everywhere (ServWave never sends a PO). Every existing `sent` row was an
-- order the buyer had placed their own way, which is exactly what `ordered` now means.
UPDATE "purchase_orders" SET "status" = 'ordered' WHERE "status" = 'sent';
-- Until this migration, ordered_at was stamped at creation, so on every draft it meant "created".
-- A draft has not been ordered: clear the date (and the actor) so "Ordered" only ever appears once
-- "Mark as ordered" sets it. Idempotent.
UPDATE "purchase_orders" SET "ordered_at" = NULL, "ordered_by_id" = NULL WHERE "status" = 'draft' AND "ordered_at" IS NOT NULL;

-- ─── 2. vendor_categories ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "vendor_categories" (
  "id"              UUID         NOT NULL,
  "organization_id" UUID         NOT NULL,
  "name"            TEXT         NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vendor_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_categories_organization_id_name_key"
  ON "vendor_categories"("organization_id", "name");
CREATE INDEX IF NOT EXISTS "vendor_categories_organization_id_idx"
  ON "vendor_categories"("organization_id");

-- CASCADE from the organization: a category is meaningless without its tenant (same as the
-- org-owned lookup tables that ship with the inventory module).
DO $$ BEGIN
  ALTER TABLE "vendor_categories" ADD CONSTRAINT "vendor_categories_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Seed: one row per distinct non-empty category string each org already uses. The raw string
-- is kept verbatim (no trimming/case-folding) so the name back-fill below is an exact match;
-- an org that spelled a category two ways simply gets two rows, which PR 4's Manage list can
-- merge by hand. gen_random_uuid() is core Postgres since 13 - no extension needed.
INSERT INTO "vendor_categories" ("id", "organization_id", "name")
SELECT gen_random_uuid(), v."organization_id", v."category"
FROM (
  SELECT DISTINCT "organization_id", "category"
  FROM "vendors"
  WHERE "category" IS NOT NULL AND btrim("category") <> ''
) v
WHERE NOT EXISTS (
  SELECT 1 FROM "vendor_categories" vc
  WHERE vc."organization_id" = v."organization_id" AND vc."name" = v."category"
);

-- Tenant RLS backstop (20260827160000_manual_communication_log shape): ENABLE + FORCE + the
-- canonical tenant_isolation predicate, verbatim - rls-coverage.test.ts compares the normalized
-- qual AND with_check strings against a constant, so this pair must not be paraphrased.
ALTER TABLE "vendor_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_categories";
CREATE POLICY "tenant_isolation" ON "vendor_categories"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense in depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables. Each role is
-- guarded SEPARATELY: a single statement naming two roles fails outright if only one exists,
-- and vanilla postgres:16 has neither. Revoking an absent privilege is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.vendor_categories FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.vendor_categories FROM authenticated';
  END IF;
END $$;

-- ─── 3. vendors.category_id ───────────────────────────────────────────────────

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "category_id" UUID;

CREATE INDEX IF NOT EXISTS "vendors_category_id_idx" ON "vendors"("category_id");

-- SET NULL: deleting a category (PR 4 refuses while in use, but belt and braces) leaves the
-- vendor Uncategorized rather than deleting it.
DO $$ BEGIN
  ALTER TABLE "vendors" ADD CONSTRAINT "vendors_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "vendor_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Back-fill by exact name within the org. Only rows still unlinked are touched, so a re-run
-- (or a later PR 4 re-point) is never overwritten.
UPDATE "vendors" v
SET "category_id" = vc."id"
FROM "vendor_categories" vc
WHERE v."category_id" IS NULL
  AND vc."organization_id" = v."organization_id"
  AND vc."name" = v."category";

-- ─── 4. vendors legacy columns become nullable ────────────────────────────────

ALTER TABLE "vendors" ALTER COLUMN "payment_terms"   DROP NOT NULL;
ALTER TABLE "vendors" ALTER COLUMN "lead_time_days"  DROP NOT NULL;
ALTER TABLE "vendors" ALTER COLUMN "transmit_method" DROP NOT NULL;
