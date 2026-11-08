/**
 * Shared limits for a line item, across Estimate, Job and Invoice.
 *
 * A line's `description` is not a label: `AddLineDialog` concatenates the item name and its
 * detail text into this ONE field (`${name}\n${detail}`), and field-service orgs paste entire
 * scope-of-work documents into it. Prod's longest live description was 4,917 characters against
 * the previous 5,000 cap, with 22 estimate lines already past 2,000 and one row beginning
 * "-- 2 of 12 --" where a user had started splitting a document across line items by hand (#1604).
 *
 * The cap lives here, in one place, because the three surfaces previously carried independent
 * `.max(...)` literals and had already drifted apart once (estimate at 5,000 while Job and
 * Invoice sat at 500, reconciled in the v12 unification). The column itself is unbounded
 * Postgres `text`, so this is a product choice, not a storage limit - the number exists to keep
 * a runaway paste from becoming a multi-megabyte row, nothing more.
 */
export const LINE_DESCRIPTION_MAX = 50_000;
