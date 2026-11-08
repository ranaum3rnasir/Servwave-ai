-- §4.5 (2 of 2): Seed accepted_payment_methods defaults, backfill Lakeside CARD rows
-- to EXTERNAL_CARD, drop the now-unused payment_provider column + enum.
--
-- Public-page routing is now driven by Organization.accepted_payment_methods:
--
--   'CARD'          ∈ accepted_payment_methods → Stripe checkout
--   'EXTERNAL_CARD' ∈ accepted_payment_methods → click-to-reveal call-us block
--   (if both)                                  → Stripe wins
--
-- Stripe capability gate: an org may have CARD in accepted_payment_methods only
-- if stripe_account_id IS NOT NULL. Enforced by the org-settings validator.

-- 1. Per-org defaults based on Stripe capability.
--    Stripe-enabled orgs (stripe_account_id IS NOT NULL) → CARD instead of EXTERNAL_CARD.
UPDATE "organizations"
  SET "accepted_payment_methods" = '["CARD", "BANK_TRANSFER", "CHECK", "CASH"]'::jsonb
  WHERE "stripe_account_id" IS NOT NULL;

UPDATE "organizations"
  SET "accepted_payment_methods" = '["EXTERNAL_CARD", "BANK_TRANSFER", "CHECK", "CASH"]'::jsonb
  WHERE "stripe_account_id" IS NULL;

-- 2. Lakeside backfill: rewrite any existing CARD payments/deposits in the Lakeside tenant
--    as EXTERNAL_CARD. Lakeside has no Stripe, so any CARD-typed row in their org was
--    actually an externally-processed card (e.g., Paystri). Scope is intentionally
--    limited to Lakeside's organization_id — other orgs' CARD rows reflect real Stripe
--    payments and must not be rewritten.
UPDATE "deposits"
  SET "payment_method" = 'EXTERNAL_CARD'
  WHERE "payment_method" = 'CARD'
    AND "estimate_id" IN (
      SELECT "id" FROM "estimates"
      WHERE "organization_id" = '00000000-0000-0000-0000-0000bcab0001'
    );

UPDATE "payments"
  SET "method" = 'EXTERNAL_CARD'
  WHERE "method" = 'CARD'
    AND "invoice_id" IN (
      SELECT "id" FROM "invoices"
      WHERE "organization_id" = '00000000-0000-0000-0000-0000bcab0001'
    );

-- Rewrite "CARD" → "EXTERNAL_CARD" inside the JSON arrays on Lakeside's send_configs
-- so already-sent estimate links still render the right Credit Card behavior
-- (call-us, not Stripe) when customers reopen them.
UPDATE "estimate_send_configs" esc
  SET "payment_methods" = (
    SELECT jsonb_agg(
      CASE WHEN m::text = '"CARD"' THEN '"EXTERNAL_CARD"'::jsonb ELSE m END
    )
    FROM jsonb_array_elements(esc."payment_methods") m
  )
  WHERE EXISTS (
    SELECT 1 FROM "estimates" e
    WHERE e."id" = esc."estimate_id"
      AND e."organization_id" = '00000000-0000-0000-0000-0000bcab0001'
  )
  AND esc."payment_methods" @> '["CARD"]'::jsonb;

-- 3. Drop the now-unused payment_provider column and enum.
ALTER TABLE "organizations" DROP COLUMN "payment_provider";
DROP TYPE "PaymentProvider";
