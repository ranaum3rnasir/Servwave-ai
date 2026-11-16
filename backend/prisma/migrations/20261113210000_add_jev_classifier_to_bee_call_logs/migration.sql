-- Alter cost_estimate to numeric(10, 6)
ALTER TABLE "bee_call_logs" ALTER COLUMN "cost_estimate" TYPE numeric(10, 6);

-- Add stage 2 / Jev classifier columns
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "vapi_cost" numeric(10, 6);
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_cost" numeric(10, 6);
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "total_cost" numeric(10, 6);
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_primary_outcome" text;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_applicable_outcomes" jsonb;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_sentiment" text;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_confidence" numeric(3, 2);
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_latency_ms" integer;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_status" text DEFAULT 'pending';
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_error" text;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_classified_at" timestamp without time zone;
ALTER TABLE "bee_call_logs" ADD COLUMN IF NOT EXISTS "jev_metadata" jsonb;

-- Backfill historical records so total_cost and vapi_cost default to existing cost_estimate
UPDATE "bee_call_logs"
SET "vapi_cost" = "cost_estimate",
    "total_cost" = "cost_estimate",
    "jev_status" = 'skipped'
WHERE "vapi_cost" IS NULL AND "cost_estimate" IS NOT NULL;
