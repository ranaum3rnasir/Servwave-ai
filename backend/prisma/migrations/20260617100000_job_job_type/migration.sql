ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "job_type" TEXT;

-- Backfill existing standard jobs from their estimate's job_type (one-time, safe to replay).
UPDATE "jobs" j
SET "job_type" = e."job_type"
FROM "estimates" e
WHERE j."estimate_id" = e."id"
  AND j."job_type" IS NULL
  AND e."job_type" IS NOT NULL;
