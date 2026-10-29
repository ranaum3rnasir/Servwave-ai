# Slice 7 - List search and filter on custom-field values

**Parent:** SRVW-115 · **Type:** AFK · **Blocked by:** Slice 6
**Not approved to start.** SRVW-115 states v2 waits until the MVP has proven the schema model.

## What to build

The first and largest SRVW-115 criterion: find records by what an org put in its own fields. Start
with **one list** (jobs), prove the whole path, then widen to leads, customers and price-book items.

Three pieces:

* **Index** - a GIN index on each `custom_fields` column. Additive, no value rewrite, which is the
  payoff for keying the bag by definition UUID in slice 1.
* **Query** - the list endpoints accept filters over custom-field values, typed per definition:
  equality and membership for SELECT and CHECKBOX, ranges for NUMBER and DATE, contains for TEXT.
* **Surface** - the list UI exposes org-defined fields as filters, and optionally as columns.

**Two traps this repo has already been bitten by:**

1. **Unknown-field handling.** SRVW-89 was exactly this: the sort parser silently fell back to
   `created_at` on an unrecognized field, so five columns sorted wrong with no error anywhere. A
   filter naming an unknown or archived definition must **400**, never silently return unfiltered
   rows. Silently-wrong results are worse than an error here.
2. **Values are strings in JSONB.** A NUMBER field's range filter and a DATE field's range filter both
   need the definition's type to cast correctly. Comparing "10" to "9" as text gives the wrong answer,
   and it gives it quietly.

## Acceptance criteria

- [ ] GIN index added per entity in a portable, idempotent migration
- [ ] Jobs list filters on custom-field values, typed per definition: equality, membership, range, contains as appropriate
- [ ] NUMBER and DATE ranges compare numerically and chronologically, proven by a test that fails under string comparison
- [ ] A filter naming an unknown or archived definition returns 400, never unfiltered results
- [ ] Filters compose with existing list filters and with pagination, and are tenant-scoped
- [ ] Filtering is exposed in the jobs list UI for org-defined fields
- [ ] Widened to leads, customers and price-book items once the jobs path is proven
- [ ] Query plans checked on a realistic row count, not an empty dev table
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Blocked by

- Slice 6 (MVP complete and schema proven)
