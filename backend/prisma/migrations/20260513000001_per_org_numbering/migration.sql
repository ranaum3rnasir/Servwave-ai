-- Per-org numbering (industry standard: Xero/Zoho/QBO pattern)
-- 1. Drop global unique indexes on number fields
DROP INDEX IF EXISTS "leads_lead_number_key";
DROP INDEX IF EXISTS "estimates_estimate_number_key";
DROP INDEX IF EXISTS "jobs_job_number_key";
DROP INDEX IF EXISTS "invoices_invoice_number_key";

-- 2. Add Estimate void tracking (audit symmetry with Invoice)
ALTER TABLE "estimates" ADD COLUMN "voided_at" TIMESTAMP(3);
ALTER TABLE "estimates" ADD COLUMN "voided_reason" TEXT;

-- 3. Add per-org numbering configuration to organizations
ALTER TABLE "organizations" ADD COLUMN "lead_prefix" VARCHAR(10) NOT NULL DEFAULT 'L';
ALTER TABLE "organizations" ADD COLUMN "estimate_prefix" VARCHAR(10) NOT NULL DEFAULT 'E';
ALTER TABLE "organizations" ADD COLUMN "job_prefix" VARCHAR(10) NOT NULL DEFAULT 'J';
ALTER TABLE "organizations" ADD COLUMN "invoice_prefix" VARCHAR(10) NOT NULL DEFAULT 'I';
ALTER TABLE "organizations" ADD COLUMN "number_padding" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "organizations" ADD COLUMN "lead_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "estimate_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "job_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "invoice_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN "lead_first_issued_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "estimate_first_issued_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "job_first_issued_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "invoice_first_issued_at" TIMESTAMP(3);

-- 4. Add composite unique indexes (per-org numbering)
CREATE UNIQUE INDEX "leads_organization_id_lead_number_key" ON "leads"("organization_id", "lead_number");
CREATE UNIQUE INDEX "estimates_organization_id_estimate_number_key" ON "estimates"("organization_id", "estimate_number");
CREATE UNIQUE INDEX "jobs_organization_id_job_number_key" ON "jobs"("organization_id", "job_number");
CREATE UNIQUE INDEX "invoices_organization_id_invoice_number_key" ON "invoices"("organization_id", "invoice_number");

-- 5. Backfill *_next_number AND *_first_issued_at on existing orgs (only Alpha exists)
-- Strips 1-char prefix (L/E/J/I); future multi-org seeding uses defaults (next=1, first_issued_at=NULL)
UPDATE organizations SET
  lead_next_number     = COALESCE((SELECT MAX(CAST(SUBSTRING(lead_number, 2) AS INTEGER)) FROM leads     WHERE organization_id = organizations.id), 0) + 1,
  estimate_next_number = COALESCE((SELECT MAX(CAST(SUBSTRING(estimate_number, 2) AS INTEGER)) FROM estimates WHERE organization_id = organizations.id), 0) + 1,
  job_next_number      = COALESCE((SELECT MAX(CAST(SUBSTRING(job_number, 2) AS INTEGER)) FROM jobs       WHERE organization_id = organizations.id), 0) + 1,
  invoice_next_number  = COALESCE((SELECT MAX(CAST(SUBSTRING(invoice_number, 2) AS INTEGER)) FROM invoices   WHERE organization_id = organizations.id), 0) + 1;

UPDATE organizations SET
  lead_first_issued_at     = (SELECT MIN(created_at) FROM leads     WHERE organization_id = organizations.id),
  estimate_first_issued_at = (SELECT MIN(created_at) FROM estimates WHERE organization_id = organizations.id),
  job_first_issued_at      = (SELECT MIN(created_at) FROM jobs      WHERE organization_id = organizations.id),
  invoice_first_issued_at  = (SELECT MIN(created_at) FROM invoices  WHERE organization_id = organizations.id);
