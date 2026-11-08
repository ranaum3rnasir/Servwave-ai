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

-- 2. Insert the first demo organization (stub - text fields populated by
--    seed-organization.ts). Everything here is invented sample data.
INSERT INTO "organizations" (
    "id", "name", "address_line1", "city", "state", "postal_code",
    "email", "website", "brand_color", "estimate_template",
    "estimate_terms", "estimate_notes", "estimate_payment_terms",
    "created_at", "updated_at"
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'ServWave Demo One',
    '100 Example Street',
    'Springfield', 'NJ', '07081',
    'info@example.com',
    'https://example.com/',
    '#E11D2E',
    'alpha-classic',
    '', '', '',
    NOW(), NOW()
);

-- 3. Add organization_id columns (with DEFAULT pointing at Alpha UUID) to all six tables
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
