-- Migration: org_deposit_default (#61)
-- Adds DepositDefaultType enum + 3 deposit-default columns to Organization.
-- Idempotent: safe to apply more than once.

DO $$ BEGIN
  CREATE TYPE "DepositDefaultType" AS ENUM ('PERCENTAGE', 'FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "deposit_default_type"         "DepositDefaultType" NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS "deposit_default_percentage"   DECIMAL(5,2)         NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "deposit_default_fixed_amount" DECIMAL(12,2)        NOT NULL DEFAULT 0;

-- Backfill the percentage from each org's legacy AppSetting 'deposit_percentage'
-- (best-effort; type stays PERCENTAGE). Clamped to [0,100]; non-numeric values skipped.
-- Idempotent: re-running just rewrites the same value.
UPDATE "organizations" o
SET "deposit_default_percentage" = LEAST(GREATEST(CAST(s."value" AS DECIMAL(5,2)), 0), 100)
FROM "app_settings" s
WHERE s."organization_id" = o."id"
  AND s."key" = 'deposit_percentage'
  AND s."value" ~ '^[0-9]+(\.[0-9]+)?$';
