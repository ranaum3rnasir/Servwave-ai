-- SERV10X-38: job-owned items — JobLineItem table (the job's own item store) + a source
-- pointer / markup on InvoiceLineItem, with a backfill for existing STANDARD-invoice jobs.
-- Idempotent + portable: safe to re-run, and runs on vanilla postgres:16 (no Supabase-only objects).

CREATE TABLE IF NOT EXISTS "job_line_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "sequence" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(10,2) NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "unit_cost" DECIMAL(12,2),
  "markup_percent" DECIMAL(5,2),
  "is_taxable" BOOLEAN NOT NULL DEFAULT true,
  "line_total" DECIMAL(12,2) NOT NULL,
  "discount_type" "DiscountType",
  "discount_value" DECIMAL(12,2),
  "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "item_type" "PriceBookItemType" NOT NULL DEFAULT 'SERVICE',
  "price_book_item_id" UUID REFERENCES "price_book_items"("id"),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id")
);
CREATE INDEX IF NOT EXISTS "job_line_items_job_id_idx" ON "job_line_items"("job_id");
CREATE INDEX IF NOT EXISTS "job_line_items_organization_id_idx" ON "job_line_items"("organization_id");
CREATE INDEX IF NOT EXISTS "job_line_items_price_book_item_id_idx" ON "job_line_items"("price_book_item_id");

ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "job_line_item_id" UUID;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "markup_percent" DECIMAL(5,2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_line_items_job_line_item_id_fkey') THEN
    ALTER TABLE "invoice_line_items"
      ADD CONSTRAINT "invoice_line_items_job_line_item_id_fkey"
      FOREIGN KEY ("job_line_item_id") REFERENCES "job_line_items"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill: seed job_line_items from each job's existing STANDARD invoice lines so the Items tab
-- keeps showing them (only for jobs that have none yet — idempotent on re-run).
INSERT INTO "job_line_items" (id, job_id, sequence, description, quantity, unit_price, unit_cost,
  markup_percent, is_taxable, line_total, discount_type, discount_value, discount_amount, item_type,
  price_book_item_id, organization_id)
SELECT gen_random_uuid(), i.job_id, ili.sequence, ili.description, ili.quantity, ili.unit_price,
  ili.unit_cost, NULL, ili.is_taxable, ili.line_total, ili.discount_type, ili.discount_value,
  ili.discount_amount, ili.item_type, ili.price_book_item_id, i.organization_id
FROM "invoice_line_items" ili
JOIN "invoices" i ON i.id = ili.invoice_id
WHERE i.kind = 'STANDARD' AND i.job_id IS NOT NULL AND i.voided_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM "job_line_items" jli WHERE jli.job_id = i.job_id);

-- Estimate-fallback backfill: jobs linked to an estimate but with no STANDARD invoice lines
-- (so the first backfill found nothing) and no job lines yet get their items from the estimate.
INSERT INTO "job_line_items" (id, job_id, sequence, description, quantity, unit_price, unit_cost,
  markup_percent, is_taxable, line_total, discount_type, discount_value, discount_amount, item_type,
  price_book_item_id, organization_id)
SELECT gen_random_uuid(), j.id, eli.sequence, eli.description, eli.quantity, eli.unit_price,
  eli.unit_cost, NULL, eli.is_taxable, eli.line_total, eli.discount_type, eli.discount_value,
  eli.discount_amount, eli.item_type, eli.price_book_item_id, j.organization_id
FROM "jobs" j
JOIN "estimate_line_items" eli ON eli.estimate_id = j.estimate_id
WHERE j.estimate_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "job_line_items" jli WHERE jli.job_id = j.id);
