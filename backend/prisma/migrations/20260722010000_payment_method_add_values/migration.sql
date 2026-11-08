-- R5b (2026-07-22) -- D3: PaymentMethod +4 (ZELLE, VENMO, CASH_APP, OTHER).
--
-- ADD VALUE, not RENAME VALUE -- a new value cannot be used in the same transaction that adds it
-- (unlike RENAME VALUE, which has no such restriction -- see the estimate-status-rename migration
-- for that precedent). This migration only adds values; no SQL here references them, so there is
-- no same-transaction conflict and no need to split into two migrations the way
-- 20260526102118_add_external_card_and_accepted_methods did for its EXTERNAL_CARD backfill.
--
-- IF NOT EXISTS on each value (PG 12+) so this is safe to run twice on the shared staging DB.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ZELLE';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'VENMO';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CASH_APP';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'OTHER';
