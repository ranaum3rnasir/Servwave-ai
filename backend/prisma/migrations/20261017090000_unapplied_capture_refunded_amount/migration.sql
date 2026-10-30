-- V7-09b: a partial refund of unapplied money. The item stays OPEN with what is left, so the dollars already sent back
-- are kept on the row (refunded_amount), and the refunds already counted are kept by id (counted_refund_ids) so a
-- replayed event, or the staff door and the event both reporting the same refund, count it once.
-- refund_started_at marks a refund on its way to the processor, so attaching the same money to an invoice cannot slip in
-- between the refund being sent and the record learning of it (it expires; nothing has to clear it).
-- Additive and idempotent; the old code ignores the three columns (they default to "nothing refunded yet").
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "counted_refund_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "refund_started_at" TIMESTAMPTZ(6);
