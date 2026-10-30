-- Payments go-live, slice 04: the ledger can describe bank debits and refunds tracked by id
-- (md_files/plans/payments/2026-10-05-payments-go-live/02-prd.md, Module 5).
--
-- PURE EXPAND. New enums, new columns on payments and refunds, two unique indexes. Nothing is dropped,
-- renamed or narrowed, and no invoice status is added, so the old instance during the deploy
-- overlap never names something that has gone.
--
-- EVERY EXISTING ROW KEEPS ITS MEANING. The state columns are NOT NULL DEFAULT 'SUCCEEDED': adding
-- a column with a constant default fills every existing row with that default, which is the
-- backfill. Every payment and refund recorded before this ran reads SUCCEEDED.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS / guarded, plain DDL, no Supabase-only
-- objects. Runs on CI's vanilla postgres:16, on Render deploy, and possibly twice against the
-- shared staging DB. NEVER run `prisma migrate` from a worktree.

-- ─── 1. Payment state ────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentState') THEN
    CREATE TYPE "PaymentState" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "state" "PaymentState" NOT NULL DEFAULT 'SUCCEEDED';

-- ─── 2. Refund state ─────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundState') THEN
    CREATE TYPE "RefundState" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "state" "RefundState" NOT NULL DEFAULT 'SUCCEEDED';

-- ─── 3. ACH: an online bank debit ────────────────────────────────────────────
-- BANK_TRANSFER keeps meaning a transfer staff recorded by hand. Bare ADD VALUE IF NOT EXISTS,
-- following 20260928140000_automation_task_completed_trigger: idempotent, portable, and NOTHING in
-- this file uses 'ACH', so it is safe inside the transaction the deploy step wraps it in (a value
-- added by ADD VALUE cannot be used until that transaction commits).

ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ACH';

-- ─── 4. How the customer paid, and the processor ids every later event resolves by ──
-- All nullable: a manual payment has none of them, and no existing row is given a value.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentWallet') THEN
    CREATE TYPE "PaymentWallet" AS ENUM ('APPLE_PAY', 'GOOGLE_PAY', 'LINK');
  END IF;
END $$;

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "wallet" "PaymentWallet";
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "card_brand" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "card_last4" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "bank_name" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "bank_last4" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_charge_id" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" TEXT;

-- UNIQUE, not just indexed: one checkout session and one charge can only ever be one payment. A bank
-- debit sends several DIFFERENT events for the same money (session completed unpaid, then async
-- succeeded/failed, plus charge events), possibly out of order and concurrently. Each has its own
-- event id, so the webhook's event claim cannot stop two handlers from each booking a payment; this
-- constraint turns the second insert into a unique violation an upsert can absorb. Postgres allows
-- any number of NULLs, so manual and deposit-credit payments (no processor ids) are unaffected. It
-- costs nothing now: both columns are new, so every existing row is NULL and the build cannot fail.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_charge_id_key" ON "payments"("stripe_charge_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_checkout_session_id_key" ON "payments"("stripe_checkout_session_id");
