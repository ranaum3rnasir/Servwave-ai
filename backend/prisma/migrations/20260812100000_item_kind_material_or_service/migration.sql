-- Item Kind collapses to material|service.
--
-- `labor`, `bundle` and `fee` were selectable in the Add Item dialog but bought
-- no behaviour: typeForKind already billed all three as SERVICE, and the
-- Stock > Items grid filtered bundle and fee out entirely, so an item saved as
-- either was created successfully and then never appeared anywhere.
--
-- Measured before writing this (2026-08-12): prod holds 601 items, all
-- `material` or NULL, with ZERO labor/bundle/fee rows - so on prod the first
-- two statements are no-ops and only the NULL backfill does anything (1 row).
-- Staging holds 65 items: 1 `labor` and 8 NULL.
--
-- Data only, no DDL: `kind` is a nullable free-text column and stays one. The
-- constraint lives in the controller (normalizeKind), which folds a retired
-- token into `service` rather than rejecting it, so an old client or a saved
-- CSV keeps working.
--
-- Idempotent by construction: every statement is an UPDATE whose WHERE clause
-- is false once it has run.

-- 1. Retired kinds, and anything unrecognised, become `service` - the value
--    they already behaved as everywhere downstream.
UPDATE "price_book_items"
   SET "kind" = 'service'
 WHERE "kind" IS NOT NULL
   AND btrim("kind") <> ''
   AND lower(btrim("kind")) <> 'material'
   AND "kind" <> 'service';

-- 2. Case and whitespace variants of the one surviving non-service kind.
--    "Material" and "material" would otherwise be two different strings to the
--    grid filter, which compares exactly.
UPDATE "price_book_items"
   SET "kind" = 'material'
 WHERE lower(btrim("kind")) = 'material'
   AND "kind" <> 'material';

-- 3. Empty strings join the NULLs rather than becoming a third empty value.
UPDATE "price_book_items"
   SET "kind" = NULL
 WHERE "kind" IS NOT NULL
   AND btrim("kind") = '';

-- 4. Backfill the kind-less rows from `type`, which is the authoritative
--    billing column. These rows are not merely untidy: the Stock > Items grid
--    matches `kind` against a fixed list, so a NULL kind is invisible there
--    today, exactly like the bundle/fee rows. Reading FROM type is the safe
--    direction - it never changes how anything bills, it only makes the
--    display column agree with the column that already decides.
UPDATE "price_book_items"
   SET "kind" = CASE WHEN "type" = 'MATERIAL' THEN 'material' ELSE 'service' END
 WHERE "kind" IS NULL;
