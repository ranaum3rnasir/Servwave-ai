/**
 * Shared report vocabulary types.
 *
 * These are contracts between a report's controls and whoever drives them, so
 * they are declared once here rather than in the page that happens to render
 * the control. The legacy pages and the /v2 rebuilds both read this module, so
 * the two presentations cannot drift apart on the shape of an option or a
 * filter facet.
 *
 * Row types are NOT re-exported here on purpose. `Lead` lives in
 * `leads-fixtures.ts` and `Job`/`Status` in `jobs-fixtures.ts`, next to the
 * deterministic data that produces them. Both fixture modules declare a
 * `Status`, and they are different unions - funnelling them through one barrel
 * would make it possible to import the wrong one by name.
 */

/** One entry in a `DateRangeControl` preset or date-field menu. */
export interface Opt {
  key: string;
  label: string;
}

/** One column of a faceted filter: a stable key, a heading and its options. */
export interface FacetGroup {
  key: string;       // stable id the parent switches on (e.g. 'category')
  label: string;     // column heading + chip prefix (e.g. 'Category')
  options: string[]; // selectable values
  selected: string[];
}
