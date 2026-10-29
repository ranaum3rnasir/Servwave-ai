-- Card service fee, slice 7 of
-- md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md
--
-- Adds the one column customer-facing tipping needs (D10). No percentage column and no
-- Organization column: the preset percentages (CARD_TIP_PRESET_BPS in backend/src/lib/stripe.ts)
-- exist only to render chips client-side, and are platform constants in v1 (D11) - nothing about
-- a percentage is ever persisted or displayed.
--
-- payments.tip_amount stays NULL when the customer leaves no tip, and rides on the payment row
-- rather than Invoice.tip: the tip is not owed and must never settle the invoice or reach invoice
-- totals (D10 - Jobber's "not included in the account balance calculation"). Nothing reads this
-- column until slice 7's checkout/webhook wiring lands.
--
-- IDEMPOTENT: ADD COLUMN is guarded with IF NOT EXISTS, so a second application against the
--   shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects here.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "tip_amount" DECIMAL(12,2);
