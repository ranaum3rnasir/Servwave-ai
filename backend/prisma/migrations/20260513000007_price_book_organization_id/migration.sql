-- Price book multi-tenancy (categories + items)
-- Pre-migration the price book was globally shared. Backfill all existing rows to ALPHA org
-- (the only org pre-migration), then enforce NOT NULL + FK.

-- ── Categories ──────────────────────────────────────────
ALTER TABLE "price_book_categories" ADD COLUMN "organization_id" UUID;
UPDATE price_book_categories SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE organization_id IS NULL;
ALTER TABLE "price_book_categories" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "price_book_categories_organization_id_idx"
  ON "price_book_categories"("organization_id");
ALTER TABLE "price_book_categories" ADD CONSTRAINT "price_book_categories_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Items ───────────────────────────────────────────────
ALTER TABLE "price_book_items" ADD COLUMN "organization_id" UUID;
UPDATE price_book_items SET organization_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE organization_id IS NULL;
ALTER TABLE "price_book_items" ALTER COLUMN "organization_id" SET NOT NULL;
CREATE INDEX "price_book_items_organization_id_idx"
  ON "price_book_items"("organization_id");
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
