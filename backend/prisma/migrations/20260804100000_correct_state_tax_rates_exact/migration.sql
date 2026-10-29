-- Correct the state_tax_rates reference table to exact statutory rates (2026-08-04).
--
-- Two distinct defects, both of which bill the wrong amount of sales tax:
--
--  1. ROUNDING. The column began life as DECIMAL(5,4), which cannot represent a rate whose
--     percentage carries a third decimal, so MN/MO/NJ/NM were seeded rounded. Migration
--     20260722020000 widened the column to DECIMAL(6,5) and corrected those four rows, but
--     src/seed-tax-rates.ts was never updated to match - so every `npm run seed:tax-rates`
--     silently reverted the correction. Rounding a half-basis-point always rounds UP, so the
--     error is a systematic overcharge (0.005pp, or $0.05 per $1,000 invoiced).
--
--  2. STALENESS. Three states changed their rate after the table was first seeded and were
--     never updated: LA (raised), NM (reduced, and also a rounding victim), SD (reduced).
--
-- Rates verified against Tax Foundation "State and Local Sales Tax Rates, Midyear 2026"
-- (effective 2026-07-01) with primary-source confirmation for each of the three changes.
-- The seed file is now the source of truth and is pinned by src/__tests__/state-tax-rates.test.ts.
--
-- Idempotent: the widen is guarded on the current column type, and the UPDATEs set absolute
-- values, so re-running converges rather than drifting. Portable: no Supabase-specific syntax.
-- state_tax_rates is a global reference table with RLS deliberately disabled
-- (20260707000100_disable_rls_global_reference_tables), so no policy work is needed here.

-- 1. Ensure the column can hold five decimal places. This is a no-op on any database that has
--    already applied 20260722020000; it matters for databases still behind that migration,
--    where the UPDATEs below would otherwise silently round right back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'state_tax_rates'
      AND column_name = 'tax_rate'
      AND numeric_scale < 5
  ) THEN
    ALTER TABLE "state_tax_rates" ALTER COLUMN "tax_rate" TYPE DECIMAL(6,5);
  END IF;
END $$;

-- 2. The four jurisdictions whose statutory rate needs all five decimal places.
UPDATE "state_tax_rates" SET "tax_rate" = 0.06875 WHERE "state_code" = 'MN'; -- 6.875%
UPDATE "state_tax_rates" SET "tax_rate" = 0.04225 WHERE "state_code" = 'MO'; -- 4.225%
UPDATE "state_tax_rates" SET "tax_rate" = 0.06625 WHERE "state_code" = 'NJ'; -- 6.625%

-- 3. Rates that changed since the table was seeded.
--    LA: 4.45% -> 5.00%, effective 2025-01-01.
UPDATE "state_tax_rates" SET "tax_rate" = 0.05000 WHERE "state_code" = 'LA';
--    NM state gross receipts: 5.125% -> 4.875%. Also needs five decimal places.
UPDATE "state_tax_rates" SET "tax_rate" = 0.04875 WHERE "state_code" = 'NM';
--    SD: 4.5% -> 4.2% (HB 1137, 2023). NOTE: the reduction sunsets 2027-06-30, so this reverts
--    to 0.04500 on 2027-07-01 unless the South Dakota legislature extends it.
UPDATE "state_tax_rates" SET "tax_rate" = 0.04200 WHERE "state_code" = 'SD';
