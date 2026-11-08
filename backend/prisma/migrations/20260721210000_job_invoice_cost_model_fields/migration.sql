-- R3b (2026-07-21) -- Job + Invoice adopt the cost model (D2/D8/D18), same shape as Estimate's
-- (2026-07-21_estimate_cost_model_fields). Reuses the existing DepositDefaultType enum -- no new
-- enum type. Idempotent (IF NOT EXISTS throughout) so it's safe to run twice on the shared
-- staging DB. Portable -- plain ALTER TABLE, no Supabase-only objects, no RLS/policy statements.

-- Job: labor hours + a per-job overhead override. Nullable -- null means "use the org default".
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "labor_hours" DECIMAL(8,2);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "overhead_mode" "DepositDefaultType";
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "overhead_value" DECIMAL(12,2);

-- Invoice: labor hours + a per-invoice overhead override. Nullable -- null means "use the org default".
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "labor_hours" DECIMAL(8,2);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "overhead_mode" "DepositDefaultType";
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "overhead_value" DECIMAL(12,2);
