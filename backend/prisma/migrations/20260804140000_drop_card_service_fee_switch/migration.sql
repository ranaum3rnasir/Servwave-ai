-- Drop the per-org card service fee kill switch.
--
-- Paying by credit card always carries the card service fee - there is no organization,
-- plan or support scenario that turns it off, so the column had no reason to exist. It
-- was never flipped false on any org (all 16 staging rows were the `true` default) and it
-- never reached production, so nothing is lost by removing it outright.
--
-- The RATE remains the CARD_SERVICE_FEE_BPS platform constant in backend/src/lib/stripe.ts,
-- never a column.
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "card_service_fee_enabled";
