-- Per-org SP##### numbering config. Idempotent + additive.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "service_plan_prefix" VARCHAR(10) NOT NULL DEFAULT 'SP';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "service_plan_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "service_plan_first_issued_at" TIMESTAMP(3);
