-- Rename the rep's own tick on an optional estimate line from the when-shaped name it shipped
-- with to `rep_selected`. Pure rename: no behaviour changes here, the value keeps its current
-- meaning, and nothing is backfilled or invented. The name has to move first because the meaning
-- is about to become "the rep's recommendation" -- written before a send and read at one -- and a
-- when-shaped name holding a value written days before any send makes the next reader wrong.
--
-- @@map'd physical table name (`estimate_line_items`), never the Prisma model name. Portable
-- plain Postgres, no vendor-only objects, no secrets.
--
-- WHY THE GUARD, and why the trailing ADD COLUMN. 20260918140000 added the column, and it reached
-- the shared staging database but never production. Two different databases therefore run this
-- file, and it has to land the SAME end state on both:
--   * a database that received 20260918140000 -> the old column is renamed, values carried over;
--   * a database that never did -> nothing to rename, so the column is created outright, exactly
--     as 20260918140000 would have created it (nullable boolean, no default, no backfill).
-- The pair is also idempotent: on a second run the guard finds nothing to rename and ADD COLUMN
-- IF NOT EXISTS is a no-op, which the shared staging database needs.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'estimate_line_items'
      AND column_name = 'selected_at_send'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'estimate_line_items'
      AND column_name = 'rep_selected'
  ) THEN
    EXECUTE 'ALTER TABLE "estimate_line_items" RENAME COLUMN "selected_at_send" TO "rep_selected"';
  END IF;
END $$;

ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "rep_selected" boolean;

-- THE SCOPE HALF, and why it is a DATA migration rather than a read-both-keys tolerance in the
-- code. Scope-of-work blocks are not rows: they live inside the `estimates.scopes` JSONB array,
-- one key per block, written by the same `commitFirstSend`. JSONB carries no schema, so a blob
-- stored under the old key does not rename itself when the TypeScript field does -- the editor
-- would simply read `undefined` and fall back to `is_selected`, which is the customer's live
-- answer, and every scope block sent on staging since 20260918140000 would silently start showing
-- the wrong tick. That fails this slice's "no behaviour change" contract.
--
-- The alternative -- reading both keys in the frontend -- was rejected: it keeps the retired name
-- alive in the code indefinitely (the point of this slice is that exactly one name exists), and
-- A2 inverts what this value MEANS, at which point a tolerance branch would be quietly attaching
-- the new meaning to blobs written under the old one. Renaming the stored key here keeps the JSONB
-- half and the column half in lockstep through that change instead of drifting apart.
--
-- Scoped to `estimates` only. Job.scopes and Invoice.scopes never carry this key (the copy path
-- strips it), and `estimate_version_snapshots` is append-only send history that no route reads
-- the key out of -- rewriting a historical record of what was sent would be a lie, not a rename.
--
-- Idempotent by construction: once rewritten no element carries the old key, so the EXISTS
-- predicate matches no row on a second run.
UPDATE "estimates" e
SET "scopes" = sub.renamed
FROM (
  SELECT x.id,
         jsonb_agg(
           CASE
             WHEN jsonb_typeof(t.elem) = 'object' AND t.elem ? 'selected_at_send'
               THEN (t.elem - 'selected_at_send')
                    || jsonb_build_object('rep_selected', t.elem -> 'selected_at_send')
             ELSE t.elem
           END
           ORDER BY t.ord
         ) AS renamed
  FROM "estimates" x
  CROSS JOIN LATERAL jsonb_array_elements(x."scopes") WITH ORDINALITY AS t(elem, ord)
  WHERE jsonb_typeof(x."scopes") = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(x."scopes") y
      WHERE jsonb_typeof(y) = 'object' AND y ? 'selected_at_send'
    )
  GROUP BY x.id
) AS sub
WHERE e.id = sub.id;
