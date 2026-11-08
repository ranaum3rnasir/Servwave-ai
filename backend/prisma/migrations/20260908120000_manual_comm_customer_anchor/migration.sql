-- Manual communication log — the CUSTOMER anchor (#2021).
--
-- A conversation that was about the customer and about no one lead or job had nowhere to go, and
-- a customer holding neither a lead nor a job could not be logged against at all. The anchor set
-- widens from two to three; the invariant stays "EXACTLY one".
--
-- PURE EXPAND, PLUS A CHECK SWAP THAT NO EXISTING ROW CAN FAIL.
--
--   The column is ADDITIVE, which is the safe half of expand/contract. The hazard this repo has
--   shipped before (see 20260831120000_drop_manual_comm_outcome's header at length) is a column
--   DROP during the deploy overlap: Prisma enumerates its BUILD-TIME column list on every
--   select-less query, so the old instance 500s asking for a column that has gone. Adding one is
--   the inverse and is invisible to the old instance — it simply never names the new column.
--
--   The CHECK swap cannot fail on data. Every existing row satisfies num_nonnulls(lead, job) = 1,
--   and adding a third operand that is NULL on all of them leaves the count at exactly 1. So
--   num_nonnulls(lead, job, customer) = 1 holds for every row already stored — no backfill, and
--   the ALTER cannot abort on a validation scan.
--
--   The DROP + ADD below is two statements but not two windows: a migration file is applied
--   inside one transaction, so there is no moment at which a writer could slip an anchorless row
--   past a table standing with no anchor constraint at all.
--
-- IDEMPOTENT + re-runnable: the column add is IF NOT EXISTS, the constraint drop is IF EXISTS,
-- the re-add is guarded on pg_constraint, the index is IF NOT EXISTS and the FK is guarded the
-- same way every FK in the table's own creating migration is. Portable: plain DDL and the
-- Postgres builtin num_nonnulls — no Supabase-only objects, no auth.* helpers, no
-- TO authenticated/anon/service_role.
--
-- NO RLS CHANGE. The table already ENABLEs + FORCEs row level security with the canonical
-- `tenant_isolation` policy on organization_id (created in 20260827160000). A new column is
-- inside that policy's reach automatically; the anchor is not what the policy filters on.

-- ─── 1. The third anchor column ───────────────────────────────────────────────

ALTER TABLE "manual_communication_logs"
  ADD COLUMN IF NOT EXISTS "customer_id" UUID;

-- ─── 2. The exactly-one-anchor CHECK, widened to three ────────────────────────
--
-- Dropped and re-added rather than edited: Postgres has no ALTER CONSTRAINT for a CHECK
-- expression. The re-add validates every existing row, which is exactly what makes the "cannot
-- fail" claim above testable rather than asserted — a row violating it would abort this file.

ALTER TABLE "manual_communication_logs"
  DROP CONSTRAINT IF EXISTS "manual_communication_logs_exactly_one_anchor";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_communication_logs_exactly_one_anchor') THEN
    ALTER TABLE "manual_communication_logs"
      ADD CONSTRAINT "manual_communication_logs_exactly_one_anchor"
      CHECK (num_nonnulls("lead_id", "job_id", "customer_id") = 1);
  END IF;
END $$;

-- ─── 3. Index ─────────────────────────────────────────────────────────────────
--
-- The customer roll-up's fourth access pattern, matching the two anchor indexes already there.

CREATE INDEX IF NOT EXISTS "manual_communication_logs_customer_id_idx"
  ON "manual_communication_logs"("customer_id");

-- ─── 4. Foreign key ───────────────────────────────────────────────────────────
--
-- CASCADE, matching the lead and job anchors: an entry names exactly one anchor, so it cannot
-- outlive the row it hangs off — SetNull would leave behind a row violating the CHECK above.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_communication_logs_customer_id_fkey') THEN
    ALTER TABLE "manual_communication_logs" ADD CONSTRAINT "manual_communication_logs_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
