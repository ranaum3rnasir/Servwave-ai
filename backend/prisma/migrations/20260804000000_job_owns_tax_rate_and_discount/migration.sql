-- E1/E2: the JOB owns its tax rate and discount.
--
-- Until now a job borrowed both from its tax-source estimate (`job.estimate ?? oldest
-- linked_estimates`), which meant attaching an estimate silently re-priced already-entered work and
-- left the rate editable from nowhere once a job-anchored estimate existed. Workiz and Housecall
-- Pro - the two closest SMB peers - both put these on the job itself.
-- -> md_files/plans/jobs/2026-08-04-job-owns-its-tax-and-discount-workiz-parity.md
--
-- Portable: no Supabase-only objects, so vanilla Postgres in CI runs it unchanged.
-- Idempotent: every ADD COLUMN is guarded, and the backfill only touches rows still at their
-- defaults (see the WHERE at the bottom), so a second apply cannot clobber a user's later edit.

-- 1. Columns. Mirror Estimate's shapes exactly so the three money surfaces stay one shape.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "tax_rate" DECIMAL(6,5) NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_type" "DiscountType";
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_value" DECIMAL(12,2);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 2. Backfill, so no existing job's total moves the day this ships.
--
-- `src` reproduces taxSourceEstimate(job) in SQL: the PRIMARY estimate (jobs.estimate_id) wins, and
-- failing that the OLDEST attachment (estimates.job_id, ordered created_at ASC) - which is exactly
-- what the ORDER BY encodes. Jobs with no estimate at all fall back to the service location's state
-- rate, matching taxRateForState()'s `state_tax_rates.state_code = service_locations.state` lookup;
-- a job whose state has no row lands on 0, same as that function returns today.
--
-- discount_amount is copied as the already-RESOLVED figure the source estimate carries, not
-- recomputed from discount_value. That is the whole point of E2: the stored dollar amount is the
-- truth, and it must not drift when the job's item set later changes.
UPDATE "jobs" AS j
SET
  "tax_rate"        = COALESCE(s."src_tax_rate", s."loc_tax_rate", 0),
  "discount_type"   = s."src_discount_type",
  "discount_value"  = s."src_discount_value",
  "discount_amount" = COALESCE(s."src_discount_amount", 0)
FROM (
  SELECT
    j2."id"                AS "job_id",
    src."tax_rate"         AS "src_tax_rate",
    src."discount_type"    AS "src_discount_type",
    src."discount_value"   AS "src_discount_value",
    src."discount_amount"  AS "src_discount_amount",
    str."tax_rate"         AS "loc_tax_rate"
  FROM "jobs" j2
  LEFT JOIN LATERAL (
    SELECT e."tax_rate", e."discount_type", e."discount_value", e."discount_amount"
    FROM "estimates" e
    WHERE e."id" = j2."estimate_id" OR e."job_id" = j2."id"
    ORDER BY (e."id" = j2."estimate_id") DESC, e."created_at" ASC
    LIMIT 1
  ) src ON TRUE
  LEFT JOIN "service_locations" sl ON sl."id" = j2."service_location_id"
  LEFT JOIN "state_tax_rates"   str ON str."state_code" = sl."state"
) AS s
WHERE j."id" = s."job_id"
  -- Untouched rows only. On a first apply every row qualifies (these are the column defaults just
  -- added above); on a re-apply against a DB where someone has since set a job's own rate or
  -- discount, that row is skipped rather than reset to its estimate's numbers.
  AND j."tax_rate" = 0
  AND j."discount_amount" = 0
  AND j."discount_type" IS NULL;
