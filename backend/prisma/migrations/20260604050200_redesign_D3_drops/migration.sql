-- ============================================================================
-- Entity-redesign Phase D — D3 DROPS (irreversible — the point of no return)
-- (generated via `prisma migrate diff --from-schema-datamodel <pre-removal snapshot>
--  --to-schema-datamodel prisma/schema.prisma --script`, then hand-curated to contain
--  ONLY the drops — the NOT NULL tightens + RESTRICT swaps already landed in D2.)
-- ============================================================================
--
-- STATUS: hand-curated from the schema diff, committed UNAPPLIED. Applied by the HUMAN
-- LAST, AFTER D1 (backfills) and D2 (tighten/restrict) are verified on staging itself.
-- This is the point of no return — keep the pre-migration pg_dump until a full
-- post-cutover QA pass signs off. See md_files/plans/entity-redesign/CUTOVER-RUNBOOK.md.
--
-- COORDINATION: deploy the legacy-removed code (this Phase-D PR — Deposit/JobCharge/
-- customer_id gone from the generated client) AT THE SAME TIME as D3, so no running
-- instance ever queries a dropped table/column (plan "Data migration & rollout" Step 4).
--
-- DIVERGENCE FROM PLAN D9 (flagged): this work-order KEEPS customers.phone/phone_ext/
-- secondary_phone/secondary_phone_ext/ad_source/allow_billing/payment_type AND
-- leads.service_address_* (deferred follow-up — FE-coupled / data-quality). They are NOT
-- dropped here; D1c/D1f read them as backfill sources. The deferred drop is a separate
-- later migration documented in the runbook (Step 6).

-- ─── Drop the legacy Deposit FKs, then the table ────────────────────────────
ALTER TABLE "deposits" DROP CONSTRAINT IF EXISTS "deposits_estimate_id_fkey";
ALTER TABLE "deposits" DROP CONSTRAINT IF EXISTS "deposits_marked_received_by_fkey";
ALTER TABLE "deposits" DROP CONSTRAINT IF EXISTS "deposits_refunded_by_fkey";
ALTER TABLE "deposits" DROP CONSTRAINT IF EXISTS "deposits_voided_by_fkey";
DROP TABLE IF EXISTS "deposits";

-- ─── Drop the legacy JobCharge FKs, then the table ──────────────────────────
ALTER TABLE "job_charges" DROP CONSTRAINT IF EXISTS "job_charges_job_id_fkey";
ALTER TABLE "job_charges" DROP CONSTRAINT IF EXISTS "job_charges_organization_id_fkey";
DROP TABLE IF EXISTS "job_charges";

-- ─── Drop estimates.customer_id (+ its FK + index) ──────────────────────────
-- (the EstimateCustomer relation is gone; customer is reached via estimate → lead → customer)
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_customer_id_fkey";
DROP INDEX IF EXISTS "estimates_customer_id_idx";
ALTER TABLE "estimates" DROP COLUMN IF EXISTS "customer_id";

-- ─── Drop jobs.is_urgent + jobs.urgency_reason (urgent flow retired) ─────────
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "is_urgent";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "urgency_reason";

-- ─── Drop the now-orphaned DepositStatus enum (nothing references it) ─────────
DROP TYPE IF EXISTS "DepositStatus";
