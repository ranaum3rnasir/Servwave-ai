-- ============================================================================
-- Entity-redesign Phase D — D2 TIGHTEN (NOT NULL) + PARTIAL-UNIQUE + RESTRICT SWAP
-- (hand-authored, COMMITTED UNAPPLIED)
-- ============================================================================
--
-- STATUS: hand-authored, committed UNAPPLIED. Applied by the HUMAN AFTER D1, during
-- the Phase-D cutover window. See md_files/plans/entity-redesign/CUTOVER-RUNBOOK.md.
--
-- ORDERING (constraint #7): every NOT NULL tighten here PHYSICALLY FOLLOWS its backfill
-- in D1 (D1c → leads.service_location_id; D1d → estimates.lead_id; D1a/D1e →
-- invoices.customer_id; D1f → customers.kind/segment). Running D2 before D1 would
-- re-trigger the customer-number-prod-drift crash class. Apply D1 FIRST, verify the
-- Step-1 audit counts are 0, THEN apply D2.
--
-- SAFE because Phase 5's controller audit already rerouted every financial-spine delete
-- through backend/src/lib/purge.ts (explicit child-deletes, not DB cascade), so flipping
-- onDelete to RESTRICT cannot surface a stray runtime delete (plan risk R5).

-- ─── Part 1: SET NOT NULL (backfills ran in D1) ──────────────────────────────
ALTER TABLE "leads"     ALTER COLUMN "service_location_id" SET NOT NULL;
ALTER TABLE "estimates" ALTER COLUMN "lead_id"             SET NOT NULL;
ALTER TABLE "invoices"  ALTER COLUMN "customer_id"         SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "kind"                SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "segment"             SET NOT NULL;

-- ─── Part 2: PARTIAL-UNIQUE indexes (Prisma can't express WHERE-clause uniques) ──
-- At most one kind=DEPOSIT invoice per estimate.
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_estimate_id_deposit_key"
  ON "invoices" ("estimate_id") WHERE "kind" = 'DEPOSIT';

-- At most one APPROVED estimate per (org, lead).
CREATE UNIQUE INDEX IF NOT EXISTS "estimates_org_lead_approved_key"
  ON "estimates" ("organization_id", "lead_id") WHERE "status" = 'APPROVED';

-- ─── Part 3: onDelete RESTRICT swap across the financial spine (§10 matrix) ──────
-- Customer→Lead, Lead→Estimate, Estimate→Job, Job→Invoice, Invoice→Payment/Refund/Credit,
-- Payment→Refund all become RESTRICT. Owned leaves (InvoiceLineItem, EstimateLineItem,
-- CustomerEmail, CustomerPhone, ServiceLocation) keep CASCADE; customer self-FKs keep SetNull.
--
-- NOTE: Most required-relation FKs already default to NO ACTION/RESTRICT at the DB (Prisma's
-- implicit default for required relations). The ONE behavioral change that the schema diff
-- surfaces is invoices.job_id, which was SET NULL from Phase-0′ (040200) and now becomes
-- RESTRICT. We DROP+ADD each spine constraint explicitly so the matrix is fully pinned in
-- the DB regardless of prior implicit defaults.

-- Customer → Lead
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_customer_id_fkey";
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lead → Estimate
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_lead_id_fkey";
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Estimate → Job
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_estimate_id_fkey";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_estimate_id_fkey"
  FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Job → Invoice (was SET NULL from 040200 — now RESTRICT, per §10)
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_job_id_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Estimate → Invoice (deposit invoices anchor here)
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_estimate_id_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_estimate_id_fkey"
  FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Customer → Invoice (required after D2 Part 1)
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_customer_id_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invoice → Payment
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_invoice_id_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invoice → Refund + Payment → Refund
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_invoice_id_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_payment_id_fkey";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invoice → Credit
ALTER TABLE "credits" DROP CONSTRAINT IF EXISTS "credits_invoice_id_fkey";
ALTER TABLE "credits" ADD CONSTRAINT "credits_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
