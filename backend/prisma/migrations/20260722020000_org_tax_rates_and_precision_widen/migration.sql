-- R5c (2026-07-22) -- org-level custom tax rates + precision widening (port-plan §3.3/§10.5).
--
-- Widen tax_rate from DECIMAL(5,4) to DECIMAL(6,5) on all three columns that carry a real
-- percentage rate: the global lookup table AND the two columns that actually PERSIST the applied
-- rate on a document. Widening precision+scale is always safe in Postgres (existing values are
-- unaffected -- more room, not reinterpretation) and is naturally idempotent: re-running an
-- ALTER COLUMN ... TYPE to the type it's already at is a harmless no-op, so this is safe to run
-- twice on the shared staging DB. MN/MO/NJ/NM's real rates (6.875%/4.225%/6.625%/5.125%) need the
-- 5th decimal place; (5,4) silently rounds them at the door.
ALTER TABLE "state_tax_rates" ALTER COLUMN "tax_rate" TYPE DECIMAL(6,5);
ALTER TABLE "estimates" ALTER COLUMN "tax_rate" TYPE DECIMAL(6,5);
ALTER TABLE "invoices" ALTER COLUMN "tax_rate" TYPE DECIMAL(6,5);

-- Correct the 4 rows that were only storable rounded to 4 decimals until now. A plain UPDATE to
-- the same value is always idempotent, so safe to run twice.
UPDATE "state_tax_rates" SET "tax_rate" = 0.06875 WHERE "state_code" = 'MN';
UPDATE "state_tax_rates" SET "tax_rate" = 0.04225 WHERE "state_code" = 'MO';
UPDATE "state_tax_rates" SET "tax_rate" = 0.06625 WHERE "state_code" = 'NJ';
UPDATE "state_tax_rates" SET "tax_rate" = 0.05125 WHERE "state_code" = 'NM';

-- Org-level custom tax rate entry -- free-standing named rates, not tied to a state_code (an
-- org's real combined rate, e.g. state + county/city, often has no single row in the global
-- state_tax_rates table). IF NOT EXISTS so this half is also safe to run twice.
CREATE TABLE IF NOT EXISTS "org_tax_rates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "rate" DECIMAL(6,5) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "org_tax_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "org_tax_rates_organization_id_idx" ON "org_tax_rates"("organization_id");

DO $$ BEGIN
  ALTER TABLE "org_tax_rates" ADD CONSTRAINT "org_tax_rates_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
