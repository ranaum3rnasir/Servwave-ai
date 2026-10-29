-- Uncap markup_percent: widen from numeric(8,2) (max 999,999.99) to numeric(311,2) on all three
-- line-item tables. Ran settled the product question on 2026-09-18: nothing is capped anywhere.
-- The five Zod `.max(100000)` bounds come out in the same change; this migration is what makes
-- that safe, because the COLUMN — not the validator — is the bound that actually refuses a write.
-- At numeric(8,2) a markup of 1,000,000 is not truncated, it is rejected:
--   ERROR 22003: numeric field overflow
--   DETAIL: A field with precision 8, scale 2 must round to an absolute value less than 10^6.
-- Uncapping validation alone would therefore convert a clean 400 into a failed write on a screen
-- that had just told the operator their number was fine.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHY 311, AND WHY THAT IS BEYOND REACH RATHER THAN MERELY LARGER
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- A fixed-precision numeric ALWAYS has a bound, so "uncapped" cannot mean "no bound". It has to
-- mean a bound that no value the system can accept is able to reach. That makes the number
-- derivable rather than a matter of taste:
--
--   * markup_percent arrives as a JSON number and is validated by `z.number().min(0).finite()`.
--     The largest value that can survive that is Number.MAX_VALUE = 1.7976931348623157e308.
--   * Written out, that has 309 integer digits.
--   * numeric(p, s) stores (p - s) integer digits, so p = 309 + 2 = 311.
--
-- 311 is therefore not "a big number someone liked". It is the exact width at which the set of
-- values the API can accept becomes a SUBSET of the values the column can store — the overflow
-- is not made less likely, it is made unreachable. Any smaller precision, however generous,
-- leaves a live 22003 path open at the write; any larger precision buys nothing, because no
-- further value can get through the edge.
--
-- Precision costs nothing here. `numeric` is a variable-length type: the typmod bounds what may
-- be stored, it does not reserve space. A row holding 25.00 occupies exactly the same bytes at
-- numeric(311,2) as it did at numeric(8,2). So there is no width/thrift trade-off to balance —
-- only the reachability argument above.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHY NOT AN UNCONSTRAINED `numeric`
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- A bare `numeric` (no precision, no scale) reads as the more honest expression of "nothing is
-- capped", and it was the first candidate. It was rejected for three reasons, in order of weight:
--
--   1. It drops the SCALE contract, which is a behaviour change nobody asked for. numeric(8,2)
--      rounds every input to 2 decimals at the door; a bare numeric stores whatever scale the
--      caller sent, so a markup of 12.3456 would persist as 12.3456 and read back that way. Every
--      reader, every derived total and every profitability display in the product assumes markup
--      is a 2-decimal figure. Uncapping the MAGNITUDE is this slice's decision; silently making
--      the stored SCALE caller-controlled is not.
--   2. It is a one-way door on exactly these tables. Measured on postgres 16.15 (method below):
--      numeric(8,2) -> numeric(311,2) leaves the relfilenode unchanged (metadata only), and so
--      does numeric(8,2) -> bare numeric; but bare numeric -> any numeric(p,s) CHANGES the
--      relfilenode, i.e. a full rewrite of the three busiest line tables in the product. Going to
--      a bare numeric would mean that if the scale contract ever had to be reinstated, the cost
--      of doing so would be a rewrite. Widening a constrained column again stays free forever.
--   3. It is not needed for reach. numeric(311,2) already holds every value the API can accept
--      (see above), so the bare type buys headroom only for values that cannot arrive.
--
-- The one thing a bare numeric would additionally accept is 'Infinity' (PG14+). That is not an
-- argument for it: `JSON.parse('{"markup_percent":1e999}')` yields Infinity and plain `z.number()`
-- accepts it, which is precisely why the request schemas now carry `.finite()`. Infinity is
-- refused at the edge, as a value that is not a number, not as a value that is too large.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- REWRITE COST — ESTABLISHED, NOT ASSUMED
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- This is a METADATA-ONLY change. No table rewrite, no row scan, no verification pass.
--
-- How that was established (not read off a release note): on a throwaway local cluster running
-- the SAME binary CI runs — postgres 16.15, the Homebrew postgresql@16 the self-hosted runner
-- puts on PATH — a table was built with a numeric(8,2) column and 1,000,000 rows (50 MB), then
-- altered to numeric(311,2), comparing `pg_relation_filenode()` and `pg_relation_size()` either
-- side. A rewrite necessarily allocates a new relfilenode; an unchanged relfilenode is proof that
-- no rewrite happened.
--
--   before  filenode 16406, 50 MB
--   ALTER TABLE ... TYPE numeric(311,2)   ->  Time: 15.378 ms
--   after   filenode 16406, 50 MB
--
-- 15 ms on a million rows, with the relation untouched on disk. Controls run in the same session:
-- a scale change (numeric(311,2) -> numeric(311,4)) and a narrowing (bare numeric -> numeric(30,2))
-- BOTH moved the relfilenode, so the probe can detect a rewrite and simply did not see one here.
-- Production and staging run postgres 17, one major ahead of where this was measured; Postgres
-- does not withdraw a DDL optimisation across majors, so 17 takes the same path.
--
-- What this still takes is an ACCESS EXCLUSIVE lock on each of the three tables (confirmed from
-- pg_locks during the ALTER). It is held for the duration of the catalog update — the 15 ms
-- above — not for a scan, and these are OLTP line tables with no long-running readers. The whole
-- statement is transactional: it was rolled back cleanly in the probe.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- DEPLOY-OVERLAP SAFETY
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Migrations are applied at boot while the PREVIOUS instance is still serving, so this has to be
-- correct for code that has not been replaced yet:
--
--   * Widening is additive. Every value already stored is still storable and is returned byte for
--     byte; the old instance reads the same rows it read a moment ago. Nothing is reinterpreted.
--   * The old instance's WRITES all pass its own surviving `.max(100000)` bound, and 100000 fits
--     numeric(311,2) with room to spare. It cannot write anything the new column refuses.
--   * The old instance's READS carry no typmod expectation. Prisma selects columns by name and
--     hands a numeric back as a string wrapped in Decimal; there is no client-side precision
--     assertion that a wider column could trip. A 5,000,000 markup written by the new instance is
--     read and rendered by the old one without error.
--   * Scale is unchanged at 2, so no stored value changes shape mid-overlap.
--   * Nothing is dropped, renamed or narrowed, so there is no reverse-compatibility window.
--
-- The dangerous ordering for this pair of changes is the opposite one — code first, column later —
-- which is why the widening and the five `.max()` removals ship as ONE change.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- All three tables must widen together: backend/src/lib/invoice-lines-from-job.ts and
-- estimate.controller.ts copy markup_percent verbatim ACROSS these tables, so widening one alone
-- would only relocate the 22003 overflow into a cross-surface conversion.
--
-- No row is rewritten and no data is backfilled: nothing stored today exceeds the old bound.
--
-- Portability: no Supabase-only object (no auth.*, no TO authenticated/anon/service_role), so no
-- pg_roles guard is needed; this runs unchanged on CI's vanilla postgres 16.
--
-- Idempotency: the guard below only fires on a column that is present, still narrower than 311
-- and at scale 2, so a second run is a no-op; and the post-conditions refuse to pass silently if
-- the widening did not actually happen. This is the same shape as its predecessor,
-- 20260903190000_widen_markup_percent, which took these columns from (5,2) to (8,2).
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
        AND numeric_precision < 311
        -- scale must be pinned: without it a hypothetical numeric(310,4) column would match
        -- `precision < 311` and be REWRITTEN to (311,2), truncating two decimal places. Pinning
        -- scale = 2 is what makes the "can never narrow" claim literally true.
        AND numeric_scale = 2
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN "markup_percent" TYPE numeric(311,2)', t);
    END IF;
  END LOOP;

  -- Post-condition, part 1 (negative): name every column that is present but still too narrow.
  -- This is the better message of the two - it says which table and at what width - so it runs
  -- first and wins when a column exists and simply did not widen. 309 integer digits is the width
  -- of Number.MAX_VALUE, i.e. of the largest markup the API can now accept.
  SELECT string_agg(table_name || ' numeric(' || numeric_precision || ',' || numeric_scale || ')', ', ')
    INTO bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'markup_percent'
     AND table_name IN ('estimate_line_items','invoice_line_items','job_line_items')
     AND numeric_precision - numeric_scale < 309;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'markup_percent not widened to hold every finite markup: %', bad;
  END IF;

  -- Post-condition, part 2 (positive). Part 1 alone is NOT enough: it only fires when a row comes
  -- back. If information_schema returns NO row - a renamed/absent table, or information_schema
  -- filtered by privilege for the connecting role, since it exposes only columns the current role
  -- can see - then string_agg yields NULL, `bad IS NULL`, and the migration would exit 0 having
  -- widened nothing while _prisma_migrations records it as applied; the very next write at a large
  -- markup would then 22003 in production with no trace of why. So assert the POSITIVE too: all
  -- three columns must be present AND wide enough, counted from the same catalog.
  --
  -- An UNCONSTRAINED `numeric` column has NULL precision and NULL scale and needs no widening -
  -- it already stores any finite value - so it counts as satisfied. That also keeps this half in
  -- agreement with part 1, where `numeric_precision - numeric_scale < 309` is NULL for such a
  -- column and therefore already treats it as fine. Today's schema has no unconstrained numeric
  -- here, and the header above says why it deliberately does not gain one.
  SELECT count(*)
    INTO ok
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'markup_percent'
     AND table_name IN ('estimate_line_items','invoice_line_items','job_line_items')
     AND (numeric_precision IS NULL
          OR (numeric_precision - numeric_scale >= 309 AND numeric_scale = 2));
  IF ok <> 3 THEN
    RAISE EXCEPTION 'expected 3 uncapped markup_percent columns, found %', ok;
  END IF;
END $$;
