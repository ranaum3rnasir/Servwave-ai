-- Payments go-live, slice P2: payout records, failure reasons and attention resolutions
-- (md_files/plans/payments/2026-10-05-payments-go-live/03-slices/P2-payout-and-failure-records.md).
--
-- ServWave holds the facts the Payments page shows. Until now it held no payout at all, no reason a
-- bank payment or a refund failed, and no "resolved" mark on a failed item. This adds:
--   - payouts: one row per payout of a company's money to its bank, kept by the payout sync;
--   - payments.payout_id (which payout a payment was paid out in) and payments.failure_code;
--   - refunds.failure_code;
--   - payment_attention_resolutions: a person marked a failed payment / refund / payout as resolved;
--   - organizations.payout_summary: schedule and bank label for the "next payout" tip.
-- payouts.status is a TEXT column with a TypeScript union (PENDING | IN_TRANSIT | PAID | FAILED |
-- CANCELED), deliberately not an enum: a new Prisma enum trips the frontend status-registry guard.
--
-- PURE EXPAND. Two new tables, four new NULLable columns, indexes, foreign keys and the tenant RLS
-- backstop. Nothing existing is dropped, renamed or narrowed, so the old instance running during the
-- deploy overlap never names anything that has gone. No data moved: the payout backfill is a script
-- (backend/scripts/backfill-payouts.ts), run apart.
--
-- IDEMPOTENT + portable: every CREATE is IF NOT EXISTS, every constraint tolerates a re-run, every
-- policy is dropped before it is created, and the Supabase-only roles sit behind a pg_roles guard.
-- Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice against the shared
-- staging DB. NEVER run `prisma migrate` from a worktree.
--
-- Foreign keys: the org CASCADEs (an org purge takes its records with it); payments.payout_id is
-- SET NULL (a payout row going never takes a payment with it); resolved_by is SET NULL (the name is
-- kept in resolved_by_name).

CREATE TABLE IF NOT EXISTS "payouts" (
  "id"                   UUID NOT NULL,
  "organization_id"      UUID NOT NULL,
  "stripe_payout_id"     TEXT NOT NULL,
  "status"               TEXT NOT NULL,
  "amount"               DECIMAL(12,2) NOT NULL,
  "arrival_date"         DATE,
  "processor_created_at" TIMESTAMPTZ,
  "is_automatic"         BOOLEAN NOT NULL DEFAULT true,
  "destination_label"    TEXT,
  "failure_code"         TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payouts_stripe_payout_id_key" ON "payouts"("stripe_payout_id");
CREATE INDEX IF NOT EXISTS "payouts_organization_id_arrival_date_idx" ON "payouts"("organization_id", "arrival_date" DESC);
CREATE INDEX IF NOT EXISTS "payouts_organization_id_status_idx" ON "payouts"("organization_id", "status");

DO $$ BEGIN
  ALTER TABLE "payouts" ADD CONSTRAINT "payouts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Which payout a payment was paid out in, and why a bank payment failed (the processor's code, never shown).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payout_id" UUID;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "failure_code" TEXT;
CREATE INDEX IF NOT EXISTS "payments_payout_id_idx" ON "payments"("payout_id");

DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_payout_id_fkey"
    FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "failure_code" TEXT;

-- {interval, weekly_anchor, delay_days, bank_label}, written by the account sync.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payout_summary" JSONB;

CREATE TABLE IF NOT EXISTS "payment_attention_resolutions" (
  "id"               UUID NOT NULL,
  "organization_id"  UUID NOT NULL,
  "item_key"         TEXT NOT NULL,
  "resolution"       TEXT NOT NULL,
  "note"             TEXT,
  "resolved_by"      UUID,
  "resolved_by_name" TEXT NOT NULL,
  "resolved_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_attention_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_attention_resolutions_organization_id_item_key_key"
  ON "payment_attention_resolutions"("organization_id", "item_key");

DO $$ BEGIN
  ALTER TABLE "payment_attention_resolutions" ADD CONSTRAINT "payment_attention_resolutions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "payment_attention_resolutions" ADD CONSTRAINT "payment_attention_resolutions_resolved_by_fkey"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payouts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payouts";
CREATE POLICY "tenant_isolation" ON "payouts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "payment_attention_resolutions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attention_resolutions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payment_attention_resolutions";
CREATE POLICY "tenant_isolation" ON "payment_attention_resolutions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before these tables
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payouts FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payment_attention_resolutions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payouts FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.payment_attention_resolutions FROM authenticated';
  END IF;
END $$;
