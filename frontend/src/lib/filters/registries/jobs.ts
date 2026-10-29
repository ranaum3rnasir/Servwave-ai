import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { TAGS_FACET, type FacetConfig } from '@/lib/filters/types';

/**
 * Job list statuses, in list order. Single source of truth for the Status
 * facet's static options — moved out of `JobsPage.tsx` (was previously
 * duplicated inline) so the registry and the page share one definition,
 * mirroring how Task 9 moved `LEAD_STATUSES` out of `LeadsPage.tsx`.
 */
// Multi-visit S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus and live on VisitStatus. The
// API's jobs facet drops an unknown literal rather than 400ing, so leaving them here would offer a
// filter option that silently matched nothing.
export const JOB_STATUSES = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

/**
 * Completed/Cancelled tiles show MONTHLY counts (by scheduled_start this
 * month); clicking them applies the current-month Scheduled range. The other
 * three status tiles are all-time. Moved out of `JobsPage.tsx` alongside
 * `JOB_STATUSES` - the KPI-tile logic that reads this lives in the page, but
 * the set itself is registry-adjacent status metadata. This is a reporting
 * subset of `JOB_STATUSES`, NOT a label map.
 */
export const MONTHLY_JOB_STATUSES = ['COMPLETED', 'CANCELLED'];

/**
 * Jobs list facet registry (Task 11). One `FacetConfig` per Task 10 backend
 * facet (`backend/src/lib/query/registries/job.filters.ts`) PLUS the
 * hand-rolled crew filters (`assigned_to`/`department_id`) that
 * `buildJobListWhere` (job.controller.ts) applies separately for RBAC-safety
 * reasons (see that file's comment) but which use the exact same `param`
 * names as if they were engine facets — the wire contract this registry must
 * match is the controller's actual `req.query` reads, not just `jobFacets`.
 *
 * Deliberately EXCLUDED from this registry (kept as standalone page state,
 * NOT rail facets):
 * - `customer_id` — the page's customer filter was removed entirely (not
 *   just excluded from the registry): customer names are specific/unique
 *   enough that the page's global search bar already narrows to at most one
 *   match, so a dedicated customer picker added no value over search.
 * - `exclude_plan_visits` — always sent as `'true'` by this page; not
 *   user-controllable, so it isn't a filter at all.
 *
 * `needs_invoice` (below) WAS standalone (boolean toggle driven by the "Need
 * Invoices" KPI tile + a deep-link URL param) but is now modeled as an
 * ordinary 1-option `multi` facet — `CheckboxFacet` already handles a
 * single-checkbox boolean toggle (see `customers.ts`'s `tax_exempt` facet for
 * the same pattern with two options), and the wire format is identical: the
 * codec encodes a checked single-value facet as `?needs_invoice=true`, the
 * exact string the backend's `req.query.needs_invoice === 'true'` check
 * (`job.controller.ts`) already read from the old standalone checkbox.
 *
 * Exported as a module-level `const` (not a function or inline literal) per
 * `useFilterState.ts`'s reference-stability requirement.
 */
export const jobsRegistry: FacetConfig[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    label: 'Status',
    // Converted from lucide's ListChecks icon (relative "m" subpaths
    // resolved to absolute coordinates so they concatenate safely into one
    // `<path d>`). No longer rendered (FilterBar's rail dropped icons); kept
    // since `icon` is still a required FacetConfig field.
    icon: 'M13 5H21 M13 12H21 M13 19H21 M3 17L5 19L9 15 M3 7L5 9L9 5',
    // Display labels come from the status registry (the single source of truth
    // for the `job` domain), not from a local map. The wire VALUE stays the
    // Prisma enum literal - including `UNSCHEDULED`, which the registry displays
    // as the ratified "Unscheduled" rename.
    options: JOB_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.job[s]?.label ?? s })),
  },
  {
    key: 'assigned_to',
    kind: 'multi',
    param: 'assigned_to',
    label: 'Assigned To',
    // Converted from lucide's Users icon (crew, plural — distinct from
    // Leads' single-person "Assigned To" icon); circle converted to a
    // two-arc path equivalent.
    icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3.128a4 4 0 0 1 0 7.744 M22 21v-2a4 4 0 0 0-3-3.87 M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
    // No `{value:'UNSCHEDULED', label:'Unassigned'}` sentinel here (unlike
    // Leads): the Jobs backend crew block (job.controller.ts) has no
    // "none" special-case for this param — it's just a plain `user_id`
    // equals/in filter. Passing 'UNSCHEDULED' would look for a user with
    // that literal id and match nothing. (The JOB_STATUSES `UNSCHEDULED`
    // value is a *status* meaning "Unscheduled", filtered via the `status`
    // facet above — unrelated to this facet.)
    optionSource: 'assignableUsers',
  },
  {
    key: 'department_id',
    kind: 'multi',
    param: 'department_id',
    label: 'Department',
    // Converted from lucide's Building2 icon (all subpaths already
    // absolute-`M`-leading, no circle/rect primitives to convert).
    icon: 'M10 12h4 M10 8h4 M14 21v-3a2 2 0 0 0-4 0v3 M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2 M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16',
    optionSource: 'departments',
  },
  {
    key: 'scheduled',
    kind: 'dateRange',
    param: 'scheduled',
    label: 'Scheduled',
    // Converted from lucide's CalendarClock icon; circle converted to a
    // two-arc path equivalent. Distinct from "Created" below so the two
    // date facets are visually distinguishable in the rail.
    icon: 'M16 14v2.2l1.6 1 M16 2v4 M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5 M3 10h5 M8 2v4 M10 16a6 6 0 1 0 12 0a6 6 0 1 0 -12 0',
  },
  {
    key: 'created',
    kind: 'dateRange',
    param: 'created',
    label: 'Created',
    // Same converted Calendar-icon path Leads' registry uses for its
    // "Created" facet (rect converted to a rounded-rect path equivalent) —
    // reused verbatim for consistency across entity registries.
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  {
    key: 'sub_status_id',
    kind: 'multi',
    param: 'sub_status_id',
    label: 'Sub-Status',
    // Converted from lucide's Tag icon (relative subpaths resolved to
    // absolute coordinates, same convention as every other icon in this
    // file) — distinct from Tags' pin-shaped icon above.
    icon: 'M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2.59 12.58a2 2 0 0 1 0-2.83L9.76 2.58a2 2 0 0 1 2.83 0L20.59 10.58a2 2 0 0 1 0 2.83Z M7 7h.01',
    // Options are per-org labels (JobSubStatusesPage), so they cannot be a
    // static list like JOB_STATUSES above — resolved on JobsPage from
    // useJobSubStatuses(). Two orgs can reuse the same word under different
    // parents, so each option's label is prefixed with its parent status's
    // display label (e.g. "Scheduled: Waiting on parts") rather than adding
    // a `group` field to the shared FacetOption/CheckboxFacet contract used
    // by every other registry.
    optionSource: 'jobSubStatuses',
  },
  {
    key: 'needs_invoice',
    kind: 'multi',
    param: 'needs_invoice',
    label: 'Needs Invoice',
    // Converted from lucide's Receipt icon (relative subpaths resolved to
    // absolute coordinates, same convention as every other icon in this
    // file) — matches the KPI tile's own Receipt icon (JobsPage.tsx).
    icon: 'M4 2L4 22L6 21L8 22L10 21L12 22L14 21L16 22L18 21L20 22L20 2L18 3L16 2L14 3L12 2L10 3L8 2L6 3Z M8 7H16 M8 11H16 M8 15H12',
    // Single-option checkbox — same 1-option `multi` boolean-toggle pattern
    // as `customers.ts`'s `tax_exempt` facet (which uses 2 options); checking
    // the lone "Needs Invoice" checkbox sets `values: ['true']`, which the
    // codec encodes as `?needs_invoice=true` — unchecking clears `values: []`,
    // which the codec omits from the URL entirely. Wire-identical to the
    // standalone checkbox this facet replaces.
    options: [{ value: 'true', label: 'Needs Invoice' }],
  },
  TAGS_FACET,
];
