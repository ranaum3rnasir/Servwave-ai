-- AddColumn: customer numbering fields on organizations
ALTER TABLE "organizations" ADD COLUMN "customer_prefix" VARCHAR(10) NOT NULL DEFAULT 'C';
ALTER TABLE "organizations" ADD COLUMN "customer_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "customer_first_issued_at" TIMESTAMP(3);

-- AddColumn: customer_number on customers (nullable for now — backfill before tightening)
ALTER TABLE "customers" ADD COLUMN "customer_number" VARCHAR(20);
