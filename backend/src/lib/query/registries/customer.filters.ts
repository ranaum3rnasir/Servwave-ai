import { equalsOrIn, FacetDef } from '../filterEngine';

/**
 * Customer list facet registry (Task 16). Four of the seven pre-existing
 * hand-rolled filters move here; `state` and the existence/tri-state toggles
 * (`has_leads`/`has_jobs`/`open_leads`/`active_jobs`/`is_parent`) stay
 * hand-rolled in `buildCustomerListWhere` — see the comment there for why.
 *
 * - `ad_source`, `payment_type`: plain direct Customer columns — stock
 *   `equalsOrIn`.
 * - `tax_exempt` is a boolean column surfaced as a 2-option ('true'/'false')
 *   checkbox facet, matching the pre-existing string-compare behavior: a
 *   single selection maps to that boolean, selecting both (or neither) is a
 *   no-op (no filter), never `{ in: [true, false] }` (which Prisma would
 *   accept but which is equivalent to "everyone" and just wastes a WHERE
 *   clause).
 * - `leads`, `jobs`: the first DOUBLE-countRange case in the app — two
 *   `countRange` facets on the same parent model (Customer), each grouping a
 *   different child model (`Lead`, `Job`) by its own `customer_id` FK. This
 *   is exactly the scenario `mergeIdFilter` (Task 3, filterEngine.ts) was
 *   built for: the second facet's `{ id: {...} }` filter must AND-append via
 *   `where.AND`, not clobber the first facet's `where.id`. Order here
 *   (leads before jobs) is what determines which one lands in `where.id`
 *   first vs. gets AND-appended — either order is correct, this one is
 *   arbitrary.
 *
 * `param` names use the wire-contract SUFFIX convention (`<key>_min`/
 * `<key>_max`), matching every other countRange facet in the app (see
 * lead.filters.ts's `estimates_min`/`estimates_max`) and the frontend
 * codec, which emits `<param>_min`/`<param>_max` for `range`-kind facets.
 */
export const customerFacets: FacetDef[] = [
  { key: 'ad_source', kind: 'multi', param: 'ad_source', apply: equalsOrIn('ad_source') },
  { key: 'payment_type', kind: 'multi', param: 'payment_type', apply: equalsOrIn('payment_type') },
  {
    key: 'tax_exempt',
    kind: 'multi',
    param: 'tax_exempt',
    apply: (where, values) => {
      if (values.length !== 1) return; // both or neither selected = no filter
      where.tax_exempt = values[0] === 'true';
    },
  },
  { key: 'leads', kind: 'countRange', minParam: 'leads_min', maxParam: 'leads_max', countOn: { model: 'lead', groupField: 'customer_id' } },
  { key: 'jobs', kind: 'countRange', minParam: 'jobs_min', maxParam: 'jobs_max', countOn: { model: 'job', groupField: 'customer_id' } },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  // SRVW-58 - composes with the two countRange facets above through the SAME
  // `mergeIdFilter` path: whichever runs first lands in `where.id`, the rest AND-append
  // to `where.AND` instead of clobbering it.
  { key: 'tags', kind: 'tags', param: 'tags', entityType: 'CUSTOMER' },
];
