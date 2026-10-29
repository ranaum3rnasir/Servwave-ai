-- DE-BRANDED 2026-09-18. This file was edited AFTER it had been applied to staging, production
-- and every developer database. That is deliberate and it is safe; the reasoning is recorded
-- here so nobody "restores" the original values.
--
-- WHY IT WAS EDITED. Section 2 below seeded org 00000000-0000-0000-0000-000000000001 with a real
-- third party's legal name, support address and domain. That UUID is no longer the real tenant
-- (it moved to d40afcec-0ddf-471f-b99d-8e5f23cbdadf) and 20260619000000_org_is_demo_flag flags
-- this row `is_demo = true`. So every freshly migrated database - CI, a throwaway local DB, a new
-- environment - came up with a DEMO org wearing someone else's identity, and those columns render
-- unauthenticated on the public estimate and invoice pages and inside the public PDFs. CLAUDE.md
-- bans real customer names everywhere in the repo, comments included.
--
-- WHY EDITING AN APPLIED MIGRATION IS SAFE HERE. Measured against prisma 6.19.3, not assumed:
--   - `applyMigrations`, the engine RPC behind `migrate deploy`, selects work by migration NAME
--     absent from `_prisma_migrations`. Replayed against a database that had already recorded
--     this folder it returned `appliedMigrationNames: []` with a success result: it did not
--     re-run the file, did not rewrite the stored checksum, and did not error on the mismatch.
--   - `migrate status` reported "Database schema is up to date!" with the file already edited.
--   - `editedMigrationNames` is produced only by `diagnoseMigrationHistory`, and the 6.19.3 CLI
--     never reads that field (0 occurrences in prisma/build/index.js).
-- So this edit changes what a FRESH database gets, and nothing else. It cannot fix a database
-- that already ran the original - 20260918120000_debrand_demo_org_identity does that half, and
-- the two are meant to ship together.
--
-- WHAT WAS DELIBERATELY NOT CHANGED. The postal address is ServWave's own (Ran, 2026-09-18). The
-- org UUID is load-bearing for the column DEFAULTs in section 3. `alpha-classic` is a PDF
-- template key wired into the schema default, both Branding pages and the PDF dispatch, so
-- retiring it is a separate change.
--
-- Context: md_files/plans/branding/2026-09-18-demo-org-public-branding-remediation.md

-- 1. Create organizations table
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "address_line1" VARCHAR(200) NOT NULL,
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(50) NOT NULL,
    "postal_code" VARCHAR(20) NOT NULL,
    "country" VARCHAR(2) NOT NULL DEFAULT 'US',
    "email" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(50),
    "website" VARCHAR(200),
    "logo_url" TEXT,
    "brand_color" VARCHAR(7) NOT NULL DEFAULT '#242424',
    "estimate_template" VARCHAR(50) NOT NULL DEFAULT 'alpha-classic',
    "estimate_terms" TEXT NOT NULL,
    "estimate_notes" TEXT NOT NULL,
    "estimate_payment_terms" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- 2. Insert the seed org row (stub — text fields populated by seed-organization.ts).
--    This row is the DEMO org; its identity fields were de-branded 2026-09-18 (see the header).
INSERT INTO "organizations" (
    "id", "name", "address_line1", "city", "state", "postal_code",
    "email", "website", "brand_color", "estimate_template",
    "estimate_terms", "estimate_notes", "estimate_payment_terms",
    "created_at", "updated_at"
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Demo Organization',
    '1001 Willow Avenue',
    'Hoboken', 'NJ', '07030',
    'info@servwave.com',
    'https://www.servwave.com',
    '#0C2D3A',
    'alpha-classic',
    '', '', '',
    NOW(), NOW()
);

-- 3. Add organization_id columns (with DEFAULT pointing at the seed org UUID) to all six tables
ALTER TABLE "users"     ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "customers" ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "leads"     ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "estimates" ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "jobs"      ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "invoices"  ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

-- 4. Add FK constraints (all six tables)
ALTER TABLE "users"     ADD CONSTRAINT "users_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads"     ADD CONSTRAINT "leads_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs"      ADD CONSTRAINT "jobs_organization_id_fkey"      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices"  ADD CONSTRAINT "invoices_organization_id_fkey"  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Create indexes (all six tables)
CREATE INDEX "users_organization_id_idx"     ON "users"("organization_id");
CREATE INDEX "customers_organization_id_idx" ON "customers"("organization_id");
CREATE INDEX "leads_organization_id_idx"     ON "leads"("organization_id");
CREATE INDEX "estimates_organization_id_idx" ON "estimates"("organization_id");
CREATE INDEX "jobs_organization_id_idx"      ON "jobs"("organization_id");
CREATE INDEX "invoices_organization_id_idx"  ON "invoices"("organization_id");

-- 6. Add snapshot columns to estimates (nullable, no default)
ALTER TABLE "estimates"
  ADD COLUMN "snapshot_terms"         TEXT,
  ADD COLUMN "snapshot_notes"         TEXT,
  ADD COLUMN "snapshot_payment_terms" TEXT;
