-- Inventory P0 foundations (plan §3.1 minus Asset tables; §4 Phase 0).
--   * price_book_items.track_inventory (D8 opt-in flag, default off = rollout gate)
--   * organizations.block_negative_stock (D7) + purchase_order_* counter triplet
--     (server-side PO numbering; allocateNumber's trailing-digit MAX self-heals
--     existing client-generated "PO-2275"-style numbers — no counter backfill)
--   * stock_movements: item/job/job-line/invoice-line/actor FKs (all SET NULL —
--     the ledger survives deletion; item_sku/item_name/actor snapshots stay),
--     unit_cost, qty Int -> numeric(10,2)
--   * stock_balances: on_hand/reserved Int -> numeric(10,2) (Decimal line qtys)
--   * job_line_items + invoice_line_items: stock_status (StockSyncStatus enum,
--     default NOT_TRACKED = the backfill for existing rows) + stock_location_id
--   * purchase_orders.vendor_id FK + exact-name-per-org backfill (unambiguous only)
--   * estimate_reservations: status lifecycle + converted_purchase_order_id
--
-- IDEMPOTENT: IF NOT EXISTS everywhere; enum + FKs + type-widenings inside
--   guarded DO blocks; backfills are no-ops on re-run (may run twice on the
--   shared staging DB).
-- PORTABLE: vanilla postgres:16 — no Supabase-only objects (no auth.*, no
--   TO authenticated/anon grants), so no pg_roles guards are required.
-- RLS: no new tables; every altered table already has the tenant_isolation
--   policy from 20260703000100_tenant_rls.

-- ─── Enum ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StockSyncStatus') THEN
    CREATE TYPE "StockSyncStatus" AS ENUM ('NOT_TRACKED', 'UNSYNCED', 'SYNCED');
  END IF;
END $$;

-- ─── price_book_items ────────────────────────────────────────────────────────
ALTER TABLE "price_book_items" ADD COLUMN IF NOT EXISTS "track_inventory" BOOLEAN NOT NULL DEFAULT false;

-- ─── organizations ───────────────────────────────────────────────────────────
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "block_negative_stock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "purchase_order_prefix" VARCHAR(10) NOT NULL DEFAULT 'PO-';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "purchase_order_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "purchase_order_first_issued_at" TIMESTAMP(3);

-- ─── stock_movements: enrichment columns ─────────────────────────────────────
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "item_id" UUID;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "job_id" UUID;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "job_line_item_id" UUID;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "invoice_line_item_id" UUID;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "unit_cost" DECIMAL(12,2);
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "actor_user_id" UUID;

-- ─── Int -> numeric(10,2) widenings (guarded: skip the table rewrite on re-run) ─
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'stock_movements' AND column_name = 'qty'
               AND data_type = 'integer') THEN
    ALTER TABLE "stock_movements"
      ALTER COLUMN "qty" TYPE DECIMAL(10,2) USING "qty"::numeric(10,2);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'stock_balances' AND column_name = 'on_hand'
               AND data_type = 'integer') THEN
    ALTER TABLE "stock_balances"
      ALTER COLUMN "on_hand" TYPE DECIMAL(10,2) USING "on_hand"::numeric(10,2),
      ALTER COLUMN "on_hand" SET DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'stock_balances' AND column_name = 'reserved'
               AND data_type = 'integer') THEN
    ALTER TABLE "stock_balances"
      ALTER COLUMN "reserved" TYPE DECIMAL(10,2) USING "reserved"::numeric(10,2),
      ALTER COLUMN "reserved" SET DEFAULT 0;
  END IF;
END $$;

-- ─── stock_movements: FKs (all ON DELETE SET NULL — append-only ledger survives) ─
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_item_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey"
      FOREIGN KEY ("item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_job_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_job_line_item_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_job_line_item_id_fkey"
      FOREIGN KEY ("job_line_item_id") REFERENCES "job_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_invoice_line_item_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_invoice_line_item_id_fkey"
      FOREIGN KEY ("invoice_line_item_id") REFERENCES "invoice_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_actor_user_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_fkey"
      FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stock_movements_item_id_idx" ON "stock_movements"("item_id");
CREATE INDEX IF NOT EXISTS "stock_movements_job_id_idx" ON "stock_movements"("job_id");
CREATE INDEX IF NOT EXISTS "stock_movements_job_line_item_id_idx" ON "stock_movements"("job_line_item_id");
CREATE INDEX IF NOT EXISTS "stock_movements_invoice_line_item_id_idx" ON "stock_movements"("invoice_line_item_id");
CREATE INDEX IF NOT EXISTS "stock_movements_actor_user_id_idx" ON "stock_movements"("actor_user_id");

-- ─── job_line_items: sync state + source location ───────────────────────────
ALTER TABLE "job_line_items" ADD COLUMN IF NOT EXISTS "stock_status" "StockSyncStatus" NOT NULL DEFAULT 'NOT_TRACKED';
ALTER TABLE "job_line_items" ADD COLUMN IF NOT EXISTS "stock_location_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_line_items_stock_location_id_fkey') THEN
    ALTER TABLE "job_line_items" ADD CONSTRAINT "job_line_items_stock_location_id_fkey"
      FOREIGN KEY ("stock_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "job_line_items_stock_location_id_idx" ON "job_line_items"("stock_location_id");

-- ─── invoice_line_items: sync state + source location ───────────────────────
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "stock_status" "StockSyncStatus" NOT NULL DEFAULT 'NOT_TRACKED';
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "stock_location_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_line_items_stock_location_id_fkey') THEN
    ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_stock_location_id_fkey"
      FOREIGN KEY ("stock_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "invoice_line_items_stock_location_id_idx" ON "invoice_line_items"("stock_location_id");

-- ─── purchase_orders: vendor FK + backfill ───────────────────────────────────
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "vendor_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_vendor_id_fkey') THEN
    ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_fkey"
      FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "purchase_orders_vendor_id_idx" ON "purchase_orders"("vendor_id");

-- Backfill: exact vendor-name match within the same org, and ONLY when that name
-- is unambiguous in the org (vendors.name has no per-org unique constraint — a
-- duplicate name would otherwise link an arbitrary vendor). Ambiguous/unmatched
-- rows keep vendor_id NULL and fall back to the legacy `vendor` display string.
-- Idempotent: the vendor_id IS NULL guard makes re-runs no-ops.
UPDATE "purchase_orders" po
SET "vendor_id" = v."id"
FROM "vendors" v
WHERE po."vendor_id" IS NULL
  AND v."organization_id" = po."organization_id"
  AND v."name" = po."vendor"
  AND NOT EXISTS (
    SELECT 1 FROM "vendors" v2
    WHERE v2."organization_id" = po."organization_id"
      AND v2."name" = po."vendor"
      AND v2."id" <> v."id"
  );

-- ─── estimate_reservations: lifecycle ────────────────────────────────────────
-- NOT NULL DEFAULT 'open' backfills every existing row to 'open' at ADD COLUMN
-- time (the queue has no terminal state today, so open is correct for all).
ALTER TABLE "estimate_reservations" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "estimate_reservations" ADD COLUMN IF NOT EXISTS "converted_purchase_order_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_reservations_converted_purchase_order_id_fkey') THEN
    ALTER TABLE "estimate_reservations" ADD CONSTRAINT "estimate_reservations_converted_purchase_order_id_fkey"
      FOREIGN KEY ("converted_purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "estimate_reservations_converted_purchase_order_id_idx" ON "estimate_reservations"("converted_purchase_order_id");

-- Defensive re-run backfill (no-op when the column was born NOT NULL DEFAULT 'open').
UPDATE "estimate_reservations" SET "status" = 'open' WHERE "status" IS NULL;
