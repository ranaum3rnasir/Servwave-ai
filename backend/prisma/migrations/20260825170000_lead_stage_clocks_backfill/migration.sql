-- Backfill the lead stage clocks from history (spec #1751, decision D10) -- 2026-08-25.
--
-- 20260825150000_lead_stage_clocks added the columns and deliberately left them NULL, because a
-- lead with several visits in mixed states is exactly the shape the mocked test seam cannot
-- validate and the derivation deserved its own rehearsed step. This is that step.
--
-- WHY A MIGRATION RATHER THAN THE ONE-OFF SCRIPT D10 DESCRIBES.
--
-- D10's own words are that "the backfill runs against production explicitly", because a local
-- one-off script in this repo reads backend/.env, which points at STAGING, and will report
-- success having written to the wrong database. A migration removes that failure mode outright
-- instead of documenting it: it runs wherever `prisma migrate deploy` runs, exactly once per
-- database, in the deploy that ships the readers - so it cannot be pointed at the wrong host,
-- cannot be forgotten, and cannot be run twice by mistake. It is also rehearsed three times
-- before it reaches production (CI's vanilla Postgres, then the demo database, then staging)
-- rather than being typed at a prompt once.
--
-- EVERY STATEMENT IS GUARDED `IS NULL` AND IS THEREFORE IDEMPOTENT AND NON-DESTRUCTIVE.
-- That guard is doing two jobs, not one:
--   1. re-running this file changes nothing; and
--   2. it can never overwrite a value a LIVE writer has already set. The writers shipped in the
--      same release, so by the time this runs some leads have been stamped by the real doors,
--      and those stamps are better evidence than anything derivable here.
--
-- WHAT IS DELIBERATELY NOT BACKFILLED: `contacted_at`. D10 accepts it as unrecoverable, and it
-- is. The only writer that ever existed before this release was the demo seeder, so there is no
-- historical record of human outbound contact to reconstruct from. NULL is the correct value and
-- means "unknown" - which is why D10 also requires null to be excluded from averages rather than
-- coerced to zero: a backfill gap rendered as a zero-duration stage reads as perfect performance.

-- ─── 1. Walkthrough booked ────────────────────────────────────────────────────────────────────

-- The live door stamps this at the moment a walkthrough is BOOKED, so its historical twin is the
-- visit row's own `created_at` -- not `scheduled_at`, which is when the trip was due to happen.
--
-- No status filter, and that matches the live writer rather than departing from it: booking a
-- visit that was later cancelled still happened, and the clock is MONOTONIC, so the live cancel
-- path does not clear it either. Filtering cancelled visits out here would make the backfilled
-- population disagree with the live one.
UPDATE "leads" l
SET "walkthrough_first_booked_at" = agg.first_booked
FROM (
  SELECT organization_id, lead_id, MIN(created_at) AS first_booked
  FROM "visits"
  WHERE lead_id IS NOT NULL
  GROUP BY organization_id, lead_id
) agg
WHERE l.id = agg.lead_id
  -- Tenancy stated rather than assumed. It changes nothing today (a visit's parent is in its own
  -- org) and costs nothing, and this repo has shipped a cross-tenant read before.
  AND l.organization_id = agg.organization_id
  AND l."walkthrough_first_booked_at" IS NULL;

-- ─── 2. Walkthrough completed: the monotonic clock AND the re-anchoring mirror ─────────────────

-- Both come from the SAME visit set, which is the clearest way to say what they are: MIN is "did
-- this lead ever finish a walkthrough, and when did site work first happen", MAX is "what is the
-- latest completion, i.e. what does the estimate SLA count from right now".
--
-- `completed_at IS NOT NULL` is load-bearing on the MAX half, exactly as it is in the live
-- readers: Postgres sorts NULLs FIRST on a DESC order, so a COMPLETED row carrying no instant
-- would otherwise win an ordering and mask the true latest completion. Inside MIN/MAX the null
-- rows are skipped anyway, but the predicate also keeps the two aggregates over one identical
-- population, which is the property being asserted here.
--
-- CANCELLED is excluded, per the contract documented on the column in schema.prisma and on
-- `leadClockPatch` -- a trip that was cancelled left no outstanding work for an estimate to
-- chase. On the lead side this is defensive: the cancel door refuses anything but a SCHEDULED
-- visit, so a COMPLETED-then-CANCELLED row should not exist. Defensive is the right posture for
-- a one-shot derivation that nothing will re-check.
UPDATE "leads" l
SET "walkthrough_first_completed_at" = COALESCE(l."walkthrough_first_completed_at", agg.first_completed),
    "last_visit_completed_at"        = COALESCE(l."last_visit_completed_at", agg.last_completed)
FROM (
  SELECT organization_id, lead_id,
         MIN(completed_at) AS first_completed,
         MAX(completed_at) AS last_completed
  FROM "visits"
  WHERE lead_id IS NOT NULL
    AND completed_at IS NOT NULL
    AND status <> 'CANCELLED'
  GROUP BY organization_id, lead_id
) agg
WHERE l.id = agg.lead_id
  AND l.organization_id = agg.organization_id
  -- Touch a row only if at least one of the two is still unknown; COALESCE then leaves whichever
  -- half a live writer has already filled exactly as it found it.
  AND (l."walkthrough_first_completed_at" IS NULL OR l."last_visit_completed_at" IS NULL);

-- ─── 3. First estimate sent ───────────────────────────────────────────────────────────────────

-- The live door stamps on FIRST send only and never on a resend, so the historical twin is
-- MIN(sent_at) across the lead's estimates.
--
-- An estimate whose status says SENT but whose `sent_at` is null (Workiz-imported rows are the
-- known population) contributes nothing, and a lead holding only such estimates keeps a NULL
-- clock. That is the honest outcome: the platform knows the estimate went out but not when, and
-- inventing a date from `created_at` would report a turnaround the business never achieved.
UPDATE "leads" l
SET "first_estimate_sent_at" = agg.first_sent
FROM (
  SELECT organization_id, lead_id, MIN(sent_at) AS first_sent
  FROM "estimates"
  WHERE lead_id IS NOT NULL AND sent_at IS NOT NULL
  GROUP BY organization_id, lead_id
) agg
WHERE l.id = agg.lead_id
  AND l.organization_id = agg.organization_id
  AND l."first_estimate_sent_at" IS NULL;

-- ─── 4. Won ───────────────────────────────────────────────────────────────────────────────────

-- "Best available evidence", and the evidence is the estimate's approval instant. Every one of
-- the five doors that moves a lead to WON does so off an estimate being approved or its deposit
-- being paid, so MIN(approved_at) is the recorded moment of the winning event rather than a
-- proxy for it. MIN, not MAX: if several estimates were approved, the lead was won at the first.
--
-- Restricted to leads that ARE won. An approved estimate on a lead sitting in some other status
-- is a data-integrity question, not a win, and this file must not answer it by writing a clock.
--
-- A WON lead with no approved estimate keeps a NULL `won_at` and is NOT given `updated_at`, which
-- is the value time-to-close is inferred from today and the reason this column exists: any
-- unrelated edit moves it, so it would furnish a precise-looking date that is simply wrong.
UPDATE "leads" l
SET "won_at" = agg.first_approved
FROM (
  SELECT organization_id, lead_id, MIN(approved_at) AS first_approved
  FROM "estimates"
  WHERE lead_id IS NOT NULL AND approved_at IS NOT NULL
  GROUP BY organization_id, lead_id
) agg
WHERE l.id = agg.lead_id
  AND l.organization_id = agg.organization_id
  AND l."won_at" IS NULL
  AND l."status" = 'WON';
