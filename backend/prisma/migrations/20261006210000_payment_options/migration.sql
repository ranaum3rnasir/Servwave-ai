-- Payments go-live, slice 19: payment options, org defaults and document overrides
-- (md_files/plans/payments/2026-10-05-payments-go-live/02-prd.md, Module 6).
--
-- PURE EXPAND. One new enum and new columns on organizations, invoices and estimates. Nothing is
-- dropped, renamed or narrowed, so the old instance during the deploy overlap never names
-- something that has gone.
--
-- EXISTING ORGS READ THE DEFAULTS: card and bank offered by default, tips off, presets 10/15/20 (%),
-- deposit required before approval (today's behaviour). Every document override is NULL (= follow
-- the org). Two data moves:
--   - bank-transfer instructions an org already wrote in the legacy per-org setting row are
--     copied onto the org, so the customer keeps seeing them. The setting row is left in place.
--   - ACH in accepted_payment_methods now means "the account can take bank payments", written only
--     by the account-status sync. Any ACH a settings payload put there before this slice is not
--     that fact, so it is removed; the next status refresh or account update adds it back for an
--     account whose bank-debit capability is active.
--
-- IDEMPOTENT + portable: every statement is IF NOT EXISTS / guarded, plain DDL, no Supabase-only
-- objects. Runs on CI's vanilla postgres:16, on Render deploy, and possibly twice against the
-- shared staging DB. NEVER run `prisma migrate` from a worktree.

-- ─── 1. Deposit policy ───────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DepositPolicy') THEN
    CREATE TYPE "DepositPolicy" AS ENUM ('REQUIRED_BEFORE_APPROVAL', 'PAY_LATER');
  END IF;
END $$;

-- ─── 2. Org defaults ─────────────────────────────────────────────────────────

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "tips_enabled" BOOLEAN NOT NULL DEFAULT false;
-- Card and bank offered by default: on for every existing org (today's behaviour). CARD and ACH
-- inside accepted_payment_methods mean "the account can take cards / bank payments".
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "card_offered_by_default" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "bank_offered_by_default" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "tip_presets" INTEGER[] NOT NULL DEFAULT ARRAY[10, 15, 20]::INTEGER[];
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "deposit_policy" "DepositPolicy" NOT NULL DEFAULT 'REQUIRED_BEFORE_APPROVAL';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "bank_transfer_instructions" TEXT;

-- Copy instructions an org already wrote. Only where the org column is still empty, so a second
-- run never overwrites what an owner has since saved on the org.
UPDATE "organizations" o
   SET "bank_transfer_instructions" = s."value"
  FROM "app_settings" s
 WHERE s."organization_id" = o."id"
   AND s."key" = 'bank_transfer_instructions'
   AND btrim(s."value") <> ''
   AND o."bank_transfer_instructions" IS NULL;

-- A client-written ACH is not the capability fact (see the header). jsonb_agg keeps the order of
-- the remaining methods; an org with no ACH is untouched, so an immediate second run changes
-- nothing. A later re-run would only remove an ACH the sync wrote, and the next refresh or
-- account update writes it back.
UPDATE "organizations"
   SET "accepted_payment_methods" = COALESCE(
         (SELECT jsonb_agg(m ORDER BY ord) FROM jsonb_array_elements("accepted_payment_methods") WITH ORDINALITY AS e(m, ord) WHERE m <> '"ACH"'::jsonb),
         '[]'::jsonb)
 WHERE jsonb_typeof("accepted_payment_methods") = 'array'
   AND "accepted_payment_methods" @> '["ACH"]'::jsonb;

-- ─── 3. Document overrides (NULL = follow the org) ──────────────────────────

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payment_methods_override" JSONB;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "allow_partial_payment" BOOLEAN;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "deposit_policy" "DepositPolicy";
