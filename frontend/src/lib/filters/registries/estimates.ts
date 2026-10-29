import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { TAGS_FACET, type FacetConfig } from '@/lib/filters/types';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';

/**
 * Estimate list statuses, in workflow order. Single source of truth for the
 * Status facet's static options - was previously duplicated inline in
 * `EstimatesPage.tsx` as `ESTIMATE_STATUSES`/`STATUS_LABELS`; moved here so
 * the registry and any other Estimates-page consumer share one definition
 * (mirrors how Task 11 moved `JOB_STATUSES`/`JOB_STATUS_LABELS` out of
 * `JobsPage.tsx`).
 *
 * NOT yet migrated onto `STATUS_REGISTRY.estimate`, unlike this file's sibling
 * registries (`leads.ts`, `jobs.ts`, `invoices.ts`, and the `deposit_status`
 * facet below), and unlike them the reason is NOT technical. See the E1 note on
 * `ESTIMATE_STATUS_LABELS` directly below: the two sources disagree on one
 * label and the conflict is unadjudicated. Nothing else blocks it - this list
 * and its label map have no importer outside this file.
 */
export const ESTIMATE_STATUSES: string[] = [
  ESTIMATE_STATUS.DRAFT,
  ESTIMATE_STATUS.SENT,
  ESTIMATE_STATUS.PENDING,
  ESTIMATE_STATUS.WON,
  ESTIMATE_STATUS.DECLINED,
  ESTIMATE_STATUS.ARCHIVED,
];

/**
 * OPEN CONFLICT (E1) - do NOT migrate this map onto `STATUS_REGISTRY.estimate`,
 * and do NOT reword either side, until E1 is adjudicated.
 *
 * TWO decisions, BOTH labelled D6, contradict each other on `PENDING`:
 *   - THIS file, D6 (2026-07-20): PENDING = 'Pending'. Reads PENDING as "sent,
 *     awaiting approval and deposit" - pre-acceptance, the customer is still
 *     deciding.
 *   - `frontend/src/design-system/status-registry.ts:117-125`, D6 (2026-07-21):
 *     PENDING = "Approved - Deposit Pending". Reads PENDING as post-acceptance -
 *     the customer HAS approved and signed and only the deposit is outstanding.
 *     (The registry spells that separator as an em dash. It is reproduced here
 *     with a plain hyphen because CLAUDE.md forbids em dashes in comments; the
 *     user-facing label itself is unchanged and is not this branch to reword.)
 *
 * The comment that stood here asserted as settled fact that the registry copy
 * was "stale" post-signature wording. It is not settled: the registry's copy is
 * one day NEWER and states the opposite semantics. The two cannot both be true,
 * and which one is right is a product decision about what the PENDING state
 * MEANS, not a refactor. Neither string may be changed until E1 is decided.
 *
 * Consequence for anyone tidying this file: migrating this map is mechanically
 * trivial (verified: no importer outside this file), and that is precisely the
 * trap. Doing it silently reworders a live Status filter facet from "Pending" to
 * the registry's string and pre-empts the open escalation. The `deposit_status`
 * facet below WAS migrated because its four labels are byte-identical to the
 * registry's, so there is nothing to adjudicate there.
 */
export const ESTIMATE_STATUS_LABELS: Record<string, string> = {
  [ESTIMATE_STATUS.DRAFT]: 'Draft',
  [ESTIMATE_STATUS.SENT]: 'Sent',
  // Held byte-identical on E1 - see the block comment above.
  [ESTIMATE_STATUS.PENDING]: 'Pending',
  [ESTIMATE_STATUS.WON]: 'Won',
  [ESTIMATE_STATUS.DECLINED]: 'Declined',
  [ESTIMATE_STATUS.ARCHIVED]: 'Archived',
};

/**
 * Draft/Sent/Won/Declined/Archived tiles show MONTHLY counts (by created_at
 * this month); clicking them applies the current-month Created range.
 * `PENDING` ("sent, awaiting approval and deposit" - this file's D6 reading,
 * which E1 disputes; see the block comment on `ESTIMATE_STATUS_LABELS`) is
 * the one all-time status tile, status-only with no date range. Moved out of
 * `EstimatesPage.tsx` alongside `ESTIMATE_STATUSES`/`ESTIMATE_STATUS_LABELS`
 * - the KPI-tile logic that reads this lives in the page, but the set itself
 * is registry-adjacent status metadata (mirrors `jobs.ts`'s
 * `MONTHLY_JOB_STATUSES`).
 */
export const MONTHLY_ESTIMATE_STATUSES: string[] = [
  ESTIMATE_STATUS.DRAFT,
  ESTIMATE_STATUS.SENT,
  ESTIMATE_STATUS.WON,
  ESTIMATE_STATUS.DECLINED,
  ESTIMATE_STATUS.ARCHIVED,
];

/**
 * Deposit status shown on the Estimate list is a legacy `DepositStatus`
 * vocabulary the frontend still surfaces, even though the standalone
 * `Deposit` model was dissolved into a `kind=DEPOSIT` Invoice on the backend
 * (see `backend/src/lib/query/registries/estimate.filters.ts`'s
 * `DEPOSIT_INVOICE_STATUS` mapping, which this facet's `param` wires into).
 *
 * The wire VALUES stay here (they are this facet's query vocabulary). The
 * LABELS moved to `STATUS_REGISTRY.deposit`, which already carried the same
 * four strings byte-identically - see the `deposit_status` facet below.
 */
export const DEPOSIT_STATUSES = ['REQUESTED', 'PAID', 'VOIDED', 'REFUNDED'];

/**
 * Estimates list facet registry (Task 13). One `FacetConfig` per Task 12
 * backend facet (`backend/src/lib/query/registries/estimate.filters.ts`):
 * `status`, `created_by`, `deposit_status`, `total` (range), `created`
 * (dateRange).
 *
 * Deliberately EXCLUDED from this registry (kept as standalone page state or
 * dropped entirely — NOT rail facets):
 * - `customer_id` — same reasoning as Jobs' registry (see `jobs.ts`): the
 *   page's Customer filter is an async debounced search over
 *   `/api/customers` (`CustomerSelect`), a single-select id+label control
 *   with no finite option list. Doesn't fit `CheckboxFacet`'s model, so it
 *   stays a standalone control outside `<FilterBar>`, same placement as
 *   before. (The backend facet still exists — `estimate.filters.ts`'s
 *   `customer_id` reaches the customer through `lead.customer_id` — the
 *   frontend just drives it from a different control.)
 * - `lead_id` — a backend-only facet (`estimate.filters.ts`) used for
 *   deep-linking "this lead's estimates" from elsewhere in the app; the
 *   Estimates list page has never exposed it as a user-facing filter, so
 *   it's intentionally absent here, same as Jobs' `customer_id` isn't a rail
 *   facet.
 *
 * Exported as a module-level `const` (not a function or inline literal) per
 * `useFilterState.ts`'s reference-stability requirement.
 */
export const estimatesRegistry: FacetConfig[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    label: 'Status',
    // lucide's ListChecks icon (relative subpaths resolved to absolute
    // coordinates so they concatenate safely into one `<path d>`) — same
    // icon Jobs' registry uses for its Status facet. No longer rendered
    // (FilterBar's rail dropped icons); kept since `icon` is still a
    // required FacetConfig field.
    icon: 'M13 5H21 M13 12H21 M13 19H21 M3 17L5 19L9 15 M3 7L5 9L9 5',
    options: ESTIMATE_STATUSES.map((s) => ({ value: s, label: ESTIMATE_STATUS_LABELS[s] ?? s })),
  },
  {
    key: 'created_by',
    kind: 'multi',
    param: 'created_by',
    label: 'Created By',
    // lucide's User icon (single person — Estimates' "Created By" is a
    // single-author field, unlike Jobs' multi-person "Assigned To" crew);
    // circle converted to a two-arc path equivalent. Same converted path
    // Leads' registry uses for its single-select "Assigned To" icon.
    icon: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7A4 4 0 1 1 8 7A4 4 0 1 1 16 7Z',
    // Resolved by the page's resolveOptions('assignableUsers') from the
    // `/api/estimates/creators` roster — reusing the same `optionSource` id
    // Jobs' "Assigned To" facet uses is fine; each page's own resolveOptions
    // decides what that id means for that page.
    optionSource: 'assignableUsers',
  },
  {
    key: 'deposit_status',
    kind: 'multi',
    param: 'deposit_status',
    label: 'Deposit',
    // lucide's CreditCard icon (rect converted to a rounded-rect path
    // equivalent, plus the horizontal divider line).
    icon: 'M4 5H20A2 2 0 0 1 22 7V17A2 2 0 0 1 20 19H4A2 2 0 0 1 2 17V7A2 2 0 0 1 4 5Z M2 10H22',
    // Static options with friendly labels - DEPOSIT_STATUSES's wire values
    // are the legacy vocabulary `estimate.filters.ts`'s `deposit_status`
    // facet maps onto invoice status(es); no optionSource/resolveOptions
    // needed since there's nothing dynamic to resolve.
    //
    // Labels resolve through STATUS_REGISTRY.deposit, same as leads.ts /
    // jobs.ts / invoices.ts do for their Status facets. The local
    // DEPOSIT_STATUS_LABELS map this replaced held Requested/Paid/Voided/
    // Refunded, byte-identical to the registry's four, so this is a pure
    // de-duplication with zero rendered change. (Unlike the Status facet
    // above, which is held on E1 because its labels genuinely conflict.)
    options: DEPOSIT_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.deposit[s]?.label ?? s })),
  },
  {
    key: 'total',
    kind: 'range',
    param: 'total',
    label: 'Total',
    // lucide's Banknote icon (rect + circle converted to path equivalents,
    // plus the two corner "dot" ticks).
    icon: 'M4 6H20A2 2 0 0 1 22 8V16A2 2 0 0 1 20 18H4A2 2 0 0 1 2 16V8A2 2 0 0 1 4 6Z M14 12A2 2 0 1 1 10 12A2 2 0 1 1 14 12Z M6 12H6.01 M18 12H18.01',
    money: true,
    min: 0,
    // No backend "max total across all estimates" stat today — 100000 is a
    // sensible static money ceiling (mirrors leads.ts's `leads.maxEstimates`
    // precedent: a static domain ceiling noted as data-driveable later).
    // This is the first production `money: true` RangeFacet; the ceiling
    // just needs to comfortably exceed realistic estimate totals so the
    // slider/inputs stay usable — pick a larger org-specific value here if
    // real totals start exceeding it.
    maxSource: 'estimates.maxTotal',
  },
  {
    key: 'created',
    kind: 'dateRange',
    param: 'created',
    label: 'Created',
    // Same converted Calendar-icon path Jobs'/Leads' registries use for
    // their "Created" facet — reused verbatim for consistency across entity
    // registries.
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  TAGS_FACET,
];
