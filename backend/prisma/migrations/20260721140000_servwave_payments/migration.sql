-- ServWave Payments (Stripe Connect) — capability flags + fee columns + payments-terms hardening.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS everywhere.
-- PORTABLE: vanilla postgres:16 — no auth.*, no TO authenticated/anon grants.
-- RLS: no new tables; altered tables keep their existing tenant_isolation policy.

-- ─── organizations: mirrored Stripe capability flags + per-org fee knob ───
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_charges_enabled"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_payouts_enabled"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_requirements_due"  JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_disabled_reason"   TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "platform_fee_bps"         INTEGER NOT NULL DEFAULT 50;

-- Cross-org claim guard: one connected account can belong to at most one org.
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_account_id_key"
  ON "organizations" ("stripe_account_id") WHERE "stripe_account_id" IS NOT NULL;

-- ─── payments: reconciliation columns ───
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_fee_amount"             DECIMAL(12,2);
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "platform_fee_amount"          DECIMAL(12,2);
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "net_amount"                   DECIMAL(12,2);
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_balance_transaction_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_account_id"            TEXT;

-- ─── terms_acceptances: payments-fee hardening ───
ALTER TABLE "terms_acceptances" ADD COLUMN IF NOT EXISTS "disclosed_fee_bps"  INTEGER;
ALTER TABLE "terms_acceptances" ADD COLUMN IF NOT EXISTS "authority_attested" BOOLEAN NOT NULL DEFAULT false;

-- Kill the non-atomic findFirst→create race for the payments clickwrap ONLY.
-- NOTE: must be PARTIAL (context='payments_onboarding'). A global unique on
-- (organization_id, context, terms_version) would collide with existing
-- invite_acceptance rows, which are legitimately per-user (many per org+version).
CREATE UNIQUE INDEX IF NOT EXISTS "terms_acceptances_payments_org_version_key"
  ON "terms_acceptances" ("organization_id", "terms_version")
  WHERE "context" = 'payments_onboarding';
