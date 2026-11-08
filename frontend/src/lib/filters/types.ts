/**
 * Shared, metadata-driven filter contract for the frontend.
 *
 * A `FacetConfig` describes one filterable field on an entity list page
 * (Leads, Jobs, Estimates, Invoices, Customers, Inventory, ...). The generic
 * `<FilterBar>` (later tasks) renders each facet's control by dispatching on
 * `kind`; `useFilterState` + `urlCodec` bind the resulting `FilterState` to
 * the URL. Per-entity registries (later tasks) only ever *populate* this
 * contract — they must not need to change it.
 *
 * The `param` on each facet is the wire contract with the backend registry
 * (`backend/src/lib/query/registries/*.filters.ts`): the param name (and, for
 * range/dateRange, the `_min`/`_max`/`_after`/`_before` suffixes) must match
 * on both sides.
 */

export type FacetKind = 'multi' | 'range' | 'dateRange';

export interface FacetOption {
  value: string;
  label: string;
  swatch?: string;
}

export interface FacetConfig {
  /** Stable id, also the key into `FilterState`. */
  key: string;
  /** Rail label + chip prefix (reuse the column header where possible). */
  label: string;
  /** SVG path `d` attribute for the rail icon. */
  icon: string;
  kind: FacetKind;

  // multi
  /** Static option list. */
  options?: FacetOption[];
  /** Id of a dynamic option source the page resolves (e.g. "users", "org"). */
  optionSource?: string;

  // range
  /** Unit label shown next to the value, e.g. "estimates", "$". */
  unit?: string;
  /** Domain floor (defaults to 0 if omitted). */
  min?: number;
  /** Id of a data-derived domain ceiling the page resolves. */
  maxSource?: string;
  /** Format the range as currency. */
  money?: boolean;

  /**
   * Base URL param name. Wire contract with the backend:
   * - multi: used as-is, e.g. "status"
   * - range: suffixed `_min` / `_max`, e.g. "estimates_min" / "estimates_max"
   * - dateRange: suffixed `_after` / `_before`, e.g. "created_after" / "created_before"
   */
  param: string;
}

/**
 * SRVW-58 - the Tags facet is identical across every entity registry: same
 * icon, same `param` (the wire contract with the backend's own `tags` facet),
 * same dynamic `optionSource`. Declared once here so the five registries
 * cannot drift on it.
 */
export const TAGS_FACET: FacetConfig = {
  key: 'tags',
  kind: 'multi',
  param: 'tags',
  label: 'Tags',
  icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z M7.5 7.5h.01',
  // `param` matches the backend registry's `tags` facet param exactly; that
  // match is the whole wire contract. Options carry `swatch: tag.color`,
  // which CheckboxFacet already renders.
  optionSource: 'tags',
};

export type FilterValue =
  | { kind: 'multi'; values: string[] }
  | { kind: 'range'; from: number | null; to: number | null }
  | { kind: 'dateRange'; from: string; to: string }; // 'YYYY-MM-DD'

/** Keyed by `FacetConfig.key`. */
export type FilterState = Record<string, FilterValue>;
