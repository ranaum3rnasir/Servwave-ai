-- Card service fee, slice 1 of
-- md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
--
-- Adds the two columns the customer-paid card service fee needs. The RATE is deliberately NOT a
-- column: it is the CARD_SERVICE_FEE_BPS constant in backend/src/lib/stripe.ts (D4), because orgs
-- do not choose it. What an org gets is a support-only kill switch, so a single org can be turned
-- off without a deploy.
--
-- organizations.card_service_fee_enabled defaults TRUE, which turns the feature on for every
-- existing org the moment slices 2 and 3 ship. That is intended: this is a platform pricing
-- mechanic, not an opt-in. Nothing changes on the strength of this migration alone - no code
-- reads either column until slice 2.
--
-- payments.service_fee_amount stays NULL on every non-card payment and on every payment taken
-- before this feature. It is recorded ALONGSIDE payments.amount, never inside it: the fee is not
-- revenue to the org and must never settle an invoice or reach invoice totals (D1).
--
-- IDEMPOTENT: both ADD COLUMN statements are guarded with IF NOT EXISTS, so a second application
--   against the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects here (no roles,
--   no auth.uid(), no RLS policy edits), so no pg_roles guard is needed.

-- 1. Support-only kill switch. No admin-facing UI writes this in slice 1.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "card_service_fee_enabled" BOOLEAN NOT NULL DEFAULT true;

-- 2. What the customer actually paid on top. Nullable by design (see header).
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "service_fee_amount" DECIMAL(12,2);
