-- Structured (Google-Calendar-style) recurrence for service plans: "every N days/weeks/months/
-- years, on selected weekdays (weekly), ending never / on a date / after N visits". These columns
-- supplement the legacy visit_cadence enum (kept as a best-fit label). They are nullable / defaulted
-- so existing rows derive their rule from visit_cadence with ZERO backfill (see derive.ts toRule):
--   interval_unit NULL  → fall back to mapping visit_cadence.
-- byweekday holds 0-6 (0=Sun) and is only meaningful for WEEK; occurrence_count is the optional
-- "after N visits" terminator, paired with the (already nullable) end_date "on date" terminator.
--
-- Idempotent: guarded CREATE TYPE + ADD COLUMN IF NOT EXISTS (may run twice on the shared staging
-- DB). Portable: standard Postgres only — no Supabase-only objects (runs on vanilla postgres:16 in CI).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntervalUnit') THEN
    CREATE TYPE "IntervalUnit" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');
  END IF;
END
$$;

ALTER TABLE "service_plans" ADD COLUMN IF NOT EXISTS "interval_unit" "IntervalUnit";
ALTER TABLE "service_plans" ADD COLUMN IF NOT EXISTS "interval_count" INTEGER;
ALTER TABLE "service_plans" ADD COLUMN IF NOT EXISTS "byweekday" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "service_plans" ADD COLUMN IF NOT EXISTS "occurrence_count" INTEGER;
