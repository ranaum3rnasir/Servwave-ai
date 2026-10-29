import { TAGS_FACET, type FacetConfig } from '@/lib/filters/types';

/**
 * Ad-source options for customer intake. Single source of truth for the
 * Source facet's static options — moved out of `CustomersPage.tsx` (was
 * previously used to render `FilterToggleChip` rows in the old single-pane
 * `FilterPopover`), mirroring how Task 9/11/13/15 moved their own
 * status/type constants out of the page and into the registry file.
 */
export const AD_SOURCES = [
  'Google', 'Facebook', 'Referral', 'Yelp', 'Instagram', 'Direct Mail', 'Door Hanger', 'Other',
];

/** Payment-terms options. Same move-out reasoning as `AD_SOURCES` above. */
export const PAYMENT_TYPES = ['COD', 'EOM', 'NET 15', 'NET 30', 'NET 60'];

/**
 * Customers list facet registry (Task 17). One `FacetConfig` per Task 16
 * backend facet (`backend/src/lib/query/registries/customer.filters.ts`):
 * `ad_source`, `payment_type`, `tax_exempt`, `leads` (countRange), `jobs`
 * (countRange), `created` (dateRange), plus `tags` (SRVW-58).
 *
 * Every facet but `tags` uses STATIC options. `tags` is this registry's FIRST
 * dynamic `optionSource` facet - until SRVW-58 there were none at all, and the
 * page's `resolveOptions` was a stable no-op kept only to satisfy
 * `FilterBar`/`AppliedChips`'s contract (same precedent as Invoices' Task 15
 * page). It now resolves the `'tags'` source; every other source id still
 * returns [].
 *
 * `leads`/`jobs` are `countRange` facets on the BACKEND, but the frontend
 * has no separate "countRange" `FacetKind` — `kind: 'range'` is the exact
 * same wire shape (`<param>_min`/`<param>_max`) whether the backend counts
 * child rows or compares a column directly. Leads' own `estimates` facet
 * (Task 9, backed by a Task-4 countRange on Lead→Estimate) already
 * established this precedent for a countRange backend facet rendered via
 * `kind: 'range'` on the frontend. Both omit `money` (they count leads/jobs,
 * not currency) and carry a `unit` label for `RangeFacet`'s "Any {unit}"
 * placeholder / "N {unit} or more" open-ended caption.
 *
 * `has_leads`/`has_jobs` are 2-option `kind: 'multi'` facets (`true`/`false`),
 * the exact same pattern as `tax_exempt` above — a tri-state has-any/has-none
 * toggle, semantically distinct from the `leads`/`jobs` COUNT ranges (a
 * customer can have 0 leads — "no leads" — vs. "between 2 and 5 leads").
 * Selecting both options degrades to "no filter" (comma-joined
 * `?has_leads=true,false` matches neither of the backend's `=== 'true'` /
 * `=== 'false'` checks in `buildCustomerListWhere` — same graceful
 * both-selected-means-no-filter semantics `tax_exempt` already has).
 *
 * Deliberately EXCLUDED from this registry (kept as standalone page state —
 * NOT rail facets; see `CustomersPage.tsx`'s own comment on standalone
 * state):
 * - `open_leads`/`active_jobs` — KPI-tile-only booleans (Active Leads/Active
 *   Jobs KPI tiles), no dedicated user-facing control of their own.
 * - `include_archived` — a plain "show archived" checkbox, not a filter
 *   facet with values.
 * - `search` — the table's built-in search box, not a rail facet (same
 *   precedent as every other entity registry).
 * - `state` — intentionally NOT surfaced (see Task 16's report: `state` is
 *   hand-rolled on the backend, coupled with the non-facet `city` filter in
 *   the same `service_locations.some` sub-object; the CURRENT page sends
 *   neither `state` nor `city`, so adding a State facet here would be new UI
 *   the brief explicitly excludes — see `customers-filter-no-state.test.tsx`,
 *   which guards this).
 *
 * Exported as a module-level `const` (not a function or inline literal) per
 * `useFilterState.ts`'s reference-stability requirement.
 */
export const customersRegistry: FacetConfig[] = [
  {
    key: 'ad_source',
    kind: 'multi',
    param: 'ad_source',
    label: 'Source',
    // Same converted lucide Megaphone icon path Leads' registry uses for its
    // own "Source" facet — ad_source is the same concept on both entities.
    icon: 'M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14 M8 6v8',
    options: AD_SOURCES.map((s) => ({ value: s, label: s })),
  },
  {
    key: 'payment_type',
    kind: 'multi',
    param: 'payment_type',
    label: 'Payment Type',
    // lucide's CreditCard icon (rect converted to a rounded-rect path
    // equivalent, plus the horizontal card-stripe line), same conversion
    // pattern as every other registry's rect-based icons.
    icon: 'M4 5H20A2 2 0 0 1 22 7V17A2 2 0 0 1 20 19H4A2 2 0 0 1 2 17V7A2 2 0 0 1 4 5Z M2 10H22',
    options: PAYMENT_TYPES.map((pt) => ({ value: pt, label: pt })),
  },
  {
    key: 'tax_exempt',
    kind: 'multi',
    param: 'tax_exempt',
    label: 'Tax Exempt',
    // lucide's Percent icon (two circles converted to two-arc path
    // equivalents, same convention Jobs'/Leads' registries use for their
    // circular icon primitives, plus the diagonal slash).
    icon: 'M19 5 5 19 M3 6.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0 M14 17.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0',
    options: [
      { value: 'true', label: 'Tax Exempt' },
      { value: 'false', label: 'Not Tax Exempt' },
    ],
  },
  {
    key: 'has_leads',
    kind: 'multi',
    param: 'has_leads',
    label: 'Leads',
    // Same ClipboardList icon the `leads` (# of Leads) facet below and the
    // page's own "Active Leads" KPI tile use — same concept, has-any vs. count.
    icon: 'M9 2H15A1 1 0 0 1 16 3V5A1 1 0 0 1 15 6H9A1 1 0 0 1 8 5V3A1 1 0 0 1 9 2Z M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M12 11h4 M12 16h4 M8 11h.01 M8 16h.01',
    options: [
      { value: 'true', label: 'Has Leads' },
      { value: 'false', label: 'No Leads' },
    ],
  },
  {
    key: 'has_jobs',
    kind: 'multi',
    param: 'has_jobs',
    label: 'Jobs',
    // Same Wrench icon the `jobs` (# of Jobs) facet below and the page's own
    // "Active Jobs" KPI tile use — same concept, has-any vs. count.
    icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    options: [
      { value: 'true', label: 'Has Jobs' },
      { value: 'false', label: 'No Jobs' },
    ],
  },
  {
    key: 'leads',
    kind: 'range',
    param: 'leads',
    label: '# of Leads',
    // Same ClipboardList icon CustomersPage's own "Active Leads" KPI tile
    // uses (rect converted to a rounded-rect path equivalent).
    icon: 'M9 2H15A1 1 0 0 1 16 3V5A1 1 0 0 1 15 6H9A1 1 0 0 1 8 5V3A1 1 0 0 1 9 2Z M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M12 11h4 M12 16h4 M8 11h.01 M8 16h.01',
    unit: 'leads',
    min: 0,
    // No backend "max leads on any one customer" stat today — 50 is a
    // sensible static ceiling (a customer with 50+ leads is an extreme
    // outlier for this domain), same static-ceiling pattern as every other
    // countRange/range facet in the app (Leads' `estimates`: 20; Estimates'/
    // Invoices' `total`/`balance`: 100000). Data-driveable later if real
    // counts start exceeding it.
    maxSource: 'customers.maxLeads',
  },
  {
    key: 'jobs',
    kind: 'range',
    param: 'jobs',
    label: '# of Jobs',
    // Same Wrench icon CustomersPage's own "Active Jobs" KPI tile uses
    // (lucide's Wrench path, a single already-closed subpath — no
    // rect/circle primitives to convert).
    icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    unit: 'jobs',
    min: 0,
    // Same static-ceiling reasoning as `leads` above.
    maxSource: 'customers.maxJobs',
  },
  {
    key: 'created',
    kind: 'dateRange',
    param: 'created',
    label: 'Created',
    // Same converted Calendar-icon path every other entity registry's
    // "Created" facet uses — reused verbatim for consistency.
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  TAGS_FACET,
];
