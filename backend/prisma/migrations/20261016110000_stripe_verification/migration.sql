-- V7-02a: the four verification rows of the payout account page, written by the account sync.
-- One additive nullable column; null means "not synced since this shipped". No backfill, no new table (no RLS block).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_verification" JSONB;
