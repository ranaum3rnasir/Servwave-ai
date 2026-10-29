-- Tighten customer_number: NOT NULL + per-org unique
-- Run AFTER the backfill has populated all existing rows.
ALTER TABLE "customers" ALTER COLUMN "customer_number" SET NOT NULL;

CREATE UNIQUE INDEX "customers_organization_id_customer_number_key" ON "customers"("organization_id", "customer_number");
