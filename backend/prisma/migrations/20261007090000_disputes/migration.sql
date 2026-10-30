-- Payments go-live, slice 09: the dispute record
-- (md_files/plans/payments/2026-10-05-payments-go-live/02-prd.md, Module 4 "open, update or close a
-- dispute"; Module 10's nightly "dispute state mismatch" check reads it).
--
-- One row per processor dispute id: the payment and invoice it is on, its status, reason, amount and
-- evidence due date. A late bank return (a bank debit returned after it cleared) arrives as a dispute
-- too and is marked is_bank_return. Until now only invoices.stripe_dispute_id existed, which holds
-- one id per invoice and no state.
--
-- PURE EXPAND. One new enum, one new table, its indexes and foreign keys, and the tenant RLS
-- backstop. Nothing existing is dropped, renamed or narrowed, and no invoice status is added, so the
-- old instance running during the deploy overlap never names anything that has gone.
--
-- IDEMPOTENT + portable: the type is guarded, every CREATE is IF NOT EXISTS, every constraint
-- tolerates a re-run, every policy is dropped before it is created, and the Supabase-only roles sit
-- behind a pg_roles guard. Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice
-- against the shared staging DB. NEVER run `prisma migrate` from a worktree.
--
-- No backfill: no row is written here. Disputes already open on staging stay on
-- invoices.stripe_dispute_id; the reconciler records a row the next time an event for them arrives.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DisputeStatus') THEN
    CREATE TYPE "DisputeStatus" AS ENUM ('NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'CLOSED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "disputes" (
  "id"                UUID NOT NULL,
  "organization_id"   UUID NOT NULL,
  "invoice_id"        UUID NOT NULL,
  "payment_id"        UUID NOT NULL,
  "stripe_dispute_id" TEXT NOT NULL,
  "status"            "DisputeStatus" NOT NULL,
  "reason"            TEXT,
  "amount"            DECIMAL(12,2) NOT NULL,
  "evidence_due_by"   TIMESTAMP(3),
  "is_bank_return"    BOOLEAN NOT NULL DEFAULT false,
  "closed_at"         TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- One processor dispute is one row, however many events (and concurrent deliveries) it sends.
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_stripe_dispute_id_key" ON "disputes"("stripe_dispute_id");
CREATE INDEX IF NOT EXISTS "disputes_organization_id_idx" ON "disputes"("organization_id");
CREATE INDEX IF NOT EXISTS "disputes_invoice_id_idx" ON "disputes"("invoice_id");
CREATE INDEX IF NOT EXISTS "disputes_payment_id_idx" ON "disputes"("payment_id");

DO $$ BEGIN
  ALTER TABLE "disputes" ADD CONSTRAINT "disputes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "disputes" ADD CONSTRAINT "disputes_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disputes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "disputes";
CREATE POLICY "tenant_isolation" ON "disputes"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before this table
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.disputes FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.disputes FROM authenticated';
  END IF;
END $$;
