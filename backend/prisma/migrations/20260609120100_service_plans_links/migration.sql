-- Link columns + InvoiceKind PLAN. Idempotent + additive.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "source_plan_id" UUID;
CREATE INDEX IF NOT EXISTS "jobs_source_plan_id_idx" ON "jobs"("source_plan_id");
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_plan_id_fkey" FOREIGN KEY ("source_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "service_plan_id" UUID;
CREATE INDEX IF NOT EXISTS "invoices_service_plan_id_idx" ON "invoices"("service_plan_id");
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_plan_id_fkey" FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Enum value add is idempotent via IF NOT EXISTS (Postgres 12+).
ALTER TYPE "InvoiceKind" ADD VALUE IF NOT EXISTS 'PLAN';
