-- Widen markup_percent from numeric(5,2) (max 999.99) to numeric(8,2) (max 999999.99)
-- on all three line-item tables. Required by #1991: the validated bound is 0..100000, which
-- needs 6 integer digits. Catalog-only under PostgreSQL's numeric_support transform - no
-- table rewrite, no row scan.
--
-- All three tables must widen together: backend/src/lib/invoice-lines-from-job.ts and
-- estimate.controller.ts copy markup_percent verbatim ACROSS these tables, so widening one
-- alone would only relocate the 22003 overflow into a cross-surface conversion.
--
-- No row is rewritten and no data is backfilled: nothing stored today exceeds 100.
--
-- Prior art in this repo: 20260722020000_org_tax_rates_and_precision_widen widened three
-- tax_rate columns with plain unguarded ALTERs and documented why that is idempotent
-- ("re-running an ALTER COLUMN ... TYPE to the type it's already at is a harmless no-op").
-- The guard below is a strict superset of that: it also refuses to touch a column that is
-- already wider, and it refuses to pass silently if it widened nothing.
--
-- Portability: no Supabase-only object (no auth.*, no TO authenticated/anon/service_role), so
-- no pg_roles guard is needed; this runs unchanged on CI's vanilla postgres:16.
DO $$
DECLARE
  t text;
  bad text;
  ok integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['estimate_line_items','invoice_line_items','job_line_items'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t
        AND column_name = 'markup_percent'
        AND numeric_precision < 8
        -- scale must be pinned: without it a hypothetical numeric(7,4) column would match
        -- `precision < 8` and be REWRITTEN to (8,2), truncating two decimal places. Pinning
        -- scale = 2 is what makes the "can never narrow" claim literally true.
        AND numeric_scale = 2
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN "markup_percent" TYPE numeric(8,2)', t);
    END IF;
  END LOOP;

  -- Post-condition, part 1 (negative): name every column that is present but still too narrow.
  -- This is the better message of the two - it says which table and at what width - so it runs
  -- first and wins when a column exists and simply did not widen.
  SELECT string_agg(table_name || ' numeric(' || numeric_precision || ',' || numeric_scale || ')', ', ')
    INTO bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'markup_percent'
     AND table_name IN ('estimate_line_items','invoice_line_items','job_line_items')
     AND numeric_precision - numeric_scale < 6;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'markup_percent not widened to hold 100000: %', bad;
  END IF;

  -- Post-condition, part 2 (positive). Part 1 alone is NOT enough: it only fires when a row comes
  -- back. If information_schema returns NO row - a renamed/absent table, or information_schema
  -- filtered by privilege for the connecting role, since it exposes only columns the current role
  -- can see - then string_agg yields NULL, `bad IS NULL`, and the migration would exit 0 having
  -- widened nothing while _prisma_migrations records it as applied; the very next write at
  -- markup >= 1000 would then 22003 in production with no trace of why. So assert the POSITIVE
  -- too: all three columns must be present AND wide enough, counted from the same catalog.
  --
  -- An UNCONSTRAINED `numeric` column has NULL precision and NULL scale and needs no widening -
  -- it already stores 100000 exactly - so it counts as satisfied. That also keeps this half in
  -- agreement with part 1, where `numeric_precision - numeric_scale < 6` is NULL for such a column
  -- and therefore already treats it as fine. Today's schema has no unconstrained numeric here.
  SELECT count(*)
    INTO ok
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'markup_percent'
     AND table_name IN ('estimate_line_items','invoice_line_items','job_line_items')
     AND (numeric_precision IS NULL
          OR (numeric_precision - numeric_scale >= 6 AND numeric_scale = 2));
  IF ok <> 3 THEN
    RAISE EXCEPTION 'expected 3 widened markup_percent columns, found %', ok;
  END IF;
END $$;
