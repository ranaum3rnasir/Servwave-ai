-- Payments go-live, slice 11: the "Payments needing attention" record
-- (md_files/plans/payments/2026-10-05-payments-go-live/03-slices/11-payments-needing-attention.md;
-- PRD Module 4 "record an unapplied capture", call 4: refunded by a person, never automatically).
--
-- One row per piece of money the processor captured that ServWave could not apply to an invoice
-- (voided or already-paid invoice, no invoice of the org, amount mismatch, deposit on hold, ...), and
-- per refund that went out for a payment ServWave never recorded. Until now these lived only as
-- timeline rows, which cannot back a list with a refund action. status: OPEN -> REFUNDED (a person
-- sent it back) or RESOLVED.
--
-- PURE EXPAND. One new enum, one new table (and its failed-refund column), one new defaulted column on
-- refunds (from_unapplied_capture), the indexes and foreign keys, and the tenant RLS
-- backstop. Nothing existing is dropped, renamed or narrowed, so the old instance running during the
-- deploy overlap never names anything that has gone.
--
-- IDEMPOTENT + portable: the type is guarded, every CREATE is IF NOT EXISTS, every constraint
-- tolerates a re-run, every policy is dropped before it is created, and the Supabase-only roles sit
-- behind a pg_roles guard. Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice
-- against the shared staging DB. NEVER run `prisma migrate` from a worktree.
--
-- Foreign keys: the org CASCADEs (an org purge takes its records with it); the invoice is SET NULL
-- (the record of money in limbo outlives a deleted invoice, and no wipe order has to change).
--
-- No backfill: captures written down before this deploy stay timeline rows only.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UnappliedCaptureStatus') THEN
    CREATE TYPE "UnappliedCaptureStatus" AS ENUM ('OPEN', 'REFUNDED', 'RESOLVED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "unapplied_captures" (
  "id"                         UUID NOT NULL,
  "organization_id"            UUID NOT NULL,
  "invoice_id"                 UUID,
  "reason"                     TEXT NOT NULL,
  "amount"                     DECIMAL(12,2),
  "stripe_payment_intent_id"   TEXT,
  "stripe_checkout_session_id" TEXT,
  "stripe_account_id"          TEXT,
  "stripe_refund_id"           TEXT,
  "source_key"                 TEXT NOT NULL,
  "status"                     "UnappliedCaptureStatus" NOT NULL DEFAULT 'OPEN',
  "refunded_at"                TIMESTAMP(3),
  "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                 TIMESTAMP(3) NOT NULL,
  CONSTRAINT "unapplied_captures_pkey" PRIMARY KEY ("id")
);

-- Refunds sent for the record that the processor reported failed. The processor does not promise
-- event order: a late created/updated event for a refund that already failed (or the list's own
-- commit after a failure landed first) must never mark the record REFUNDED. Added on its own line
-- so a re-run on a table that already exists still gains it.
ALTER TABLE "unapplied_captures" ADD COLUMN IF NOT EXISTS "failed_refund_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A refund row for money sent back from the list that sat on a payment row (the excess of an
-- overpayment, or a payment that cleared onto an invoice that could not take it). It was never the
-- invoice's money, so the refund maths leaves it out of the invoice's refund status. A marker, not
-- the reason text: staff type their own reasons on the invoice refund door. Constant default, so
-- the add is metadata-only on Postgres 11+ and the old instance's inserts read false.
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "from_unapplied_capture" BOOLEAN NOT NULL DEFAULT false;

-- One captured money is one row, however many events (and concurrent deliveries) it sends.
CREATE UNIQUE INDEX IF NOT EXISTS "unapplied_captures_organization_id_source_key_key" ON "unapplied_captures"("organization_id", "source_key");
-- One refund id is one row: the refund ServWave sent never writes the money down a second time.
CREATE UNIQUE INDEX IF NOT EXISTS "unapplied_captures_stripe_refund_id_key" ON "unapplied_captures"("stripe_refund_id");
CREATE INDEX IF NOT EXISTS "unapplied_captures_organization_id_status_idx" ON "unapplied_captures"("organization_id", "status");
CREATE INDEX IF NOT EXISTS "unapplied_captures_invoice_id_idx" ON "unapplied_captures"("invoice_id");

DO $$ BEGIN
  ALTER TABLE "unapplied_captures" ADD CONSTRAINT "unapplied_captures_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "unapplied_captures" ADD CONSTRAINT "unapplied_captures_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "unapplied_captures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unapplied_captures" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "unapplied_captures";
CREATE POLICY "tenant_isolation" ON "unapplied_captures"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before this table
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.unapplied_captures FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.unapplied_captures FROM authenticated';
  END IF;
END $$;
