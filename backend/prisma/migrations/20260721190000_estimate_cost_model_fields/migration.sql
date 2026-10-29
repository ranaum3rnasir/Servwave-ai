-- R3 (2026-07-21) -- estimate cost model (D2/D8/D18).
-- Reuses the existing DepositDefaultType enum (PERCENTAGE | FIXED) for overhead_mode -- no new
-- enum type. Idempotent (IF NOT EXISTS throughout) so it's safe to run twice on the shared
-- staging DB. Portable -- plain ALTER TABLE, no Supabase-only objects, no RLS/policy statements.

-- Organization: org-level cost defaults. STAFF-ONLY -- organization.controller.ts's
-- organizationScalarSelect (every role reads GET /api/organization) must NEVER include these;
-- they are gated behind canSeePricing in a separate, conditional select.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "labor_rate" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "overhead_mode" "DepositDefaultType" NOT NULL DEFAULT 'PERCENTAGE';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "overhead_value" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Estimate: labor hours + a per-estimate overhead override. Nullable -- null means "use the org
-- default" (mirrors the existing deposit_type/deposit_value override pattern).
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "labor_hours" DECIMAL(8,2);
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "overhead_mode" "DepositDefaultType";
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "overhead_value" DECIMAL(12,2);
