-- CreateEnum (idempotent — shared staging DB may already have it; see Shared-Staging-DB-Migration-Drift)
DO $$ BEGIN
  CREATE TYPE "LostReason" AS ENUM ('PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable (idempotent)
ALTER TABLE "estimates"
  ADD COLUMN IF NOT EXISTS "lead_source" TEXT,
  ADD COLUMN IF NOT EXISTS "job_type" TEXT,
  ADD COLUMN IF NOT EXISTS "lost_reason" "LostReason";
