-- Lead stage clocks (spec #1751, decisions D2/D3/D5) -- 2026-08-25.
--
-- The platform could not answer any of the three questions a business owner actually asks about
-- their pipeline ("how long before somebody reached out", "how long before a walkthrough was
-- booked", "how long before the estimate went out") because it never recorded when a lead
-- reached a stage. Editing a lead's status writes an audit row naming which FIELDS changed and
-- nothing else -- no from, no to -- so no time-in-stage was computable even retroactively.
--
-- This migration adds the durable clocks. It adds NO enum label: LeadStatus is deliberately
-- unchanged (D1). A status with no history yields no metric, and this codebase has been burned
-- repeatedly by code that assumed LeadStatus was ordered when it is not.
--
-- Every statement is IF NOT EXISTS / IF EXISTS. This file runs in three places (CI's vanilla
-- Postgres, the deploy pipeline, and by hand against the hosted database) and the ledger has
-- drifted from the real catalog here before -- see 20260819190000_jobstatus_enum_repair, where a
-- migration was recorded applied while its labels were absent. Verify the catalog, not the
-- ledger:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'
--   AND column_name LIKE '%_at' ORDER BY 1;
--
-- NO BACKFILL HERE, on purpose. D10 backfills from the visit and estimate rows, and it is a
-- separate, rehearsed step: a lead with several visits in mixed states is exactly the shape the
-- mocked test seam cannot validate. Leaving these NULL is also the CORRECT reading in the
-- meantime -- null means "unknown", and D10 requires unknown to be excluded from averages rather
-- than coerced to zero, because a backfill gap rendered as a zero-duration stage reads as
-- perfect performance.

-- ─── 1. The clocks ────────────────────────────────────────────────────────────────────────────

-- MONOTONIC pair. Set once, never cleared, never overwritten -- see schema.prisma for the full
-- three-clock argument. The rule is enforced by the writers (a conditional UPDATE ... WHERE col
-- IS NULL, which is atomic), not by a constraint: a CHECK cannot see the previous value, and a
-- trigger would put business logic somewhere no reader of the service would think to look.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "walkthrough_first_booked_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "walkthrough_first_completed_at" TIMESTAMP(3);

-- RE-ANCHORING mirror: MAX(completed_at) over the lead's non-cancelled visits. Same name and
-- same maintenance rule as jobs.last_visit_completed_at from multi-visit slice S8, which is
-- already in production over the other parent of the same `visits` table.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_visit_completed_at" TIMESTAMP(3);

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "first_estimate_sent_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "won_at" TIMESTAMP(3);

-- Attribution for a HAND-SET contact time (D5). Null when the automatic detection wrote the
-- stamp, which is the overwhelming majority. ON DELETE SET NULL, never CASCADE: deleting a user
-- must not delete the lead.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "contacted_set_by" UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_contacted_set_by_fkey'
  ) THEN
    ALTER TABLE "leads"
      ADD CONSTRAINT "leads_contacted_set_by_fkey"
      FOREIGN KEY ("contacted_set_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 2. Email provenance ──────────────────────────────────────────────────────────────────────

-- Mirrors messages.automated on the SMS channel. See schema.prisma for why the available
-- structural proxy (thread_id IS NULL) was rejected rather than used.
--
-- BE CLEAR ABOUT WHICH WAY THE DEFAULT CUTS. `false` is the value that reads as HUMAN, so
-- DEFAULT false backfills every pre-existing row - transactional mirrors included - to
-- indistinguishable-from-human. That is a deliberate accepted cost, not an oversight: only the
-- two writers that state the flag outright feed the contact filter, and that filter additionally
-- requires `direction = 'out'`, which every row predating the direction column fails. So no
-- historical row can reach it. Reconstructing contact history is out of scope either way (D10).
--
-- NULL-meaning-unknown was considered and rejected: it buys nothing here, because the filter
-- treats null and false identically by design (a historical row cannot prove a human sent it),
-- and it would make every future reader handle a third state that never carries information.
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "automated" BOOLEAN DEFAULT false;

-- ─── 3. Indexes for the date-anchor sweep ─────────────────────────────────────────────────────

-- candidatesForAnchor runs once a minute, per org, per registered anchor. Each of these three is
-- the exact (organization_id, <anchor column>) pair one of the new lead anchors selects on;
-- without them every tick is a sequential scan of `leads` per automation.
--
-- Not CONCURRENTLY: this migration runs inside the migration transaction, which forbids it, and
-- `leads` is small enough on every deployment that the brief ACCESS EXCLUSIVE lock is not worth
-- splitting the file to avoid.
CREATE INDEX IF NOT EXISTS "leads_organization_id_created_at_idx"
  ON "leads"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "leads_organization_id_contacted_at_idx"
  ON "leads"("organization_id", "contacted_at");
-- The third one covers last_visit_completed_at, NOT walkthrough_first_completed_at. The estimate
-- SLA is anchored on the latest completed visit rather than the first (the product owner rejected
-- asking a person whether more visits are needed), so the re-anchoring column is the one the
-- sweep selects on and the monotonic one is written but never queried. Indexing the column
-- nothing reads would cost every lead write and save nothing.
CREATE INDEX IF NOT EXISTS "leads_organization_id_last_visit_completed_at_idx"
  ON "leads"("organization_id", "last_visit_completed_at");
