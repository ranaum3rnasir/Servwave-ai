-- §4.5 (1 of 2): Add EXTERNAL_CARD enum value + accepted_payment_methods column.
--
-- Split from the backfill+drop migration because PostgreSQL forbids using a new
-- enum value (added via ALTER TYPE ... ADD VALUE) in the same transaction. The
-- backfill UPDATE statements in the follow-up migration reference 'EXTERNAL_CARD'
-- as a typed enum value, so the ADD VALUE must commit first.
--
-- After this migration applies, the schema accepts EXTERNAL_CARD as a
-- PaymentMethod and every organization has an accepted_payment_methods array
-- (defaulting to []). The next migration seeds per-org defaults and rewrites
-- Lakeside's existing CARD rows.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'EXTERNAL_CARD';

-- AlterTable
ALTER TABLE "organizations"
  ADD COLUMN "accepted_payment_methods" JSONB NOT NULL DEFAULT '[]'::jsonb;
