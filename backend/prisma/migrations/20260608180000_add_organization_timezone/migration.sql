-- Add per-org timezone for server-side date rendering (emails/PDFs).
--
-- Idempotent + nullable on purpose. The ServWave test-env backend shares the
-- staging Supabase DB, where servwave migration 20260603120000_org_settings
-- already added organizations.timezone (nullable VARCHAR(64), no default). On
-- prod/main the column does not exist yet. These statements converge either
-- starting state to: VARCHAR(50) nullable, DEFAULT 'America/New_York', with
-- existing NULLs backfilled to Eastern. Left NULLABLE so the shared servwave
-- backend can still insert rows without setting this column; app code falls
-- back to DEFAULT_TIMEZONE (see backend/src/lib/timezone.ts).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(50);
ALTER TABLE "organizations" ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';
UPDATE "organizations" SET "timezone" = 'America/New_York' WHERE "timezone" IS NULL;
