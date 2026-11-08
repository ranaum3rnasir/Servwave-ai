import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { TAGS_FACET, type FacetConfig } from '@/lib/filters/types';

/**
 * Invoice list statuses, in `InvoiceStatus` enum order. Single source of
 * truth for the Status facet's static VALUE list - was previously duplicated
 * inline in `InvoicesPage.tsx` as `INVOICE_STATUSES`/`STATUS_LABELS`; moved
 * here so the registry and any other Invoices-page consumer share one
 * definition (mirrors how Task 13 moved `ESTIMATE_STATUSES`/
 * `ESTIMATE_STATUS_LABELS` out of `EstimatesPage.tsx`).
 *
 * The companion `INVOICE_STATUS_LABELS` map is GONE: labels now resolve
 * through `STATUS_REGISTRY.invoice`, the app-wide single source of truth for
 * what an invoice status is called and how it looks. All seven pre-existing
 * labels were byte-identical to the registry's, so no label changed.
 *
 * `DISPUTED` was MISSING from this list - it is a real `InvoiceStatus` enum
 * member (backend/prisma/schema.prisma) that the list endpoint already
 * accepts (`invoice.filters.ts`'s `status` facet validates against
 * `Object.values(InvoiceStatus)`), so a disputed invoice was simply
 * unfilterable from the UI. Added here in enum order. This is a functional
 * add, not part of the registry refactor.
 *
 * `OVERDUE` is deliberately NOT here even though the registry carries it:
 * it is client-derived from `due_date` + status, not a backend enum value,
 * and it already has its own dedicated `overdue` facet below.
 */
export const INVOICE_STATUSES = [
  'DRAFT',
  'SENT',
  'PARTIAL',
  'PAID',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
];

/**
 * Invoices list facet registry (Task 15, plus a Task-15-follow-up `overdue`
 * facet). One `FacetConfig` per Task 14 backend facet
 * (`backend/src/lib/query/registries/invoice.filters.ts`): `status`, `total`
 * (range), `balance` (range), `created` (dateRange), `due` (dateRange) — plus
 * `overdue`, a 1-option `multi` facet wired to the pre-existing
 * `?overdue=true` computed-predicate param (see below).
 *
 * `total`/`balance` are brand-new UI — the live pre-Task-15 page had NO Total
 * or Balance range filter at all (confirmed in Task 14's report, which
 * corrected the original brief's claim that one already existed). Both are
 * `money: true` range facets with static `maxSource` ceilings (see below),
 * the second production page (after Estimates' `total`) with a money range,
 * and the FIRST page with two coexisting money ranges — `FilterBar` renders
 * only the selected rail tab's control at a time, so Total and Balance never
 * render simultaneously and can't clash; each dispatches through its own
 * `facet.key`/`param` independently (`total_min`/`total_max` vs
 * `balance_min`/`balance_max`), confirmed via `RangeFacet`'s `aria-label`s
 * (`"Total From"`/`"Total To"` vs `"Balance Due From"`/`"Balance Due To"`).
 *
 * `overdue` is modeled as a 1-option `multi` facet (`options: [{value:'true',
 * label:'Overdue'}]`) rather than a standalone boolean toggle — same pattern
 * `tax_exempt` uses on the Customers registry. Checking it sets
 * `values: ['true']`, which the URL codec encodes as `?overdue=true` — the
 * exact string `buildInvoiceListWhere` (`invoice.controller.ts`) already
 * reads via `req.query.overdue === 'true'`, so no backend change was needed.
 * The backend still runs its `overdue` handling AFTER `applyFilters` (MERGING
 * `{ lt: now }` onto whatever the `due` facet set on `due_date`, and
 * OVERWRITING `status` to `{in:['SENT','PARTIAL']}`) — that composition is
 * unchanged; only the frontend's origin of the `?overdue=true` param moved
 * from a bespoke checkbox into this facet.
 *
 * `customer_id` was a standalone async Customer search (`CustomerSelect`) —
 * removed from the page entirely (not ported as a facet): customer names are
 * specific enough that the page's existing global search bar already covers
 * this use case with no loss of value.
 *
 * The old page's "Active" quick-toggle inside the Status filter section
 *   (a curated `['DRAFT','SENT','PARTIAL']` preset chip, reused by the
 *   Due/Unsent KPI math) is DROPPED, not ported — `CheckboxFacet`'s
 *   Select-all only covers the visible/search-filtered option set, it can't
 *   express an arbitrary curated subset as a one-click preset. Same
 *   precedent as Leads'/Jobs' dropped "Active" toggle. Users can still
 *   select DRAFT+SENT+PARTIAL manually via the Status pane; the Due/Unsent
 *   KPI tiles (which used to double as this preset) are unaffected — they
 *   set the same two/one-status combination directly via `setValue`, not
 *   through this dropped chip.
 *
 * Exported as a module-level `const` (not a function or inline literal) per
 * `useFilterState.ts`'s reference-stability requirement.
 */
export const invoicesRegistry: FacetConfig[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    label: 'Status',
    // lucide's ListChecks icon — same converted path Jobs'/Estimates'
    // registries use for their Status facet, reused verbatim for consistency
    // across entity registries.
    icon: 'M13 5H21 M13 12H21 M13 19H21 M3 17L5 19L9 15 M3 7L5 9L9 5',
    options: INVOICE_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.invoice[s]?.label ?? s })),
  },
  {
    // Document TYPE, not lifecycle stage. A deposit is money held against future
    // work and is excluded from every revenue figure the app reports, so being
    // able to separate the two is the difference between reading this list as
    // "what we earned" and reading it as "what we hold". PLAN is included
    // because it is a real InvoiceKind the backend accepts, not because service
    // plans need their own tile.
    key: 'kind',
    kind: 'multi',
    param: 'kind',
    label: 'Type',
    // lucide's Layers icon - the same icon the Deposits tiles use, so the facet
    // and the figure it filters to are recognisably the same idea.
    icon: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z M2 12l8.58 3.91a2 2 0 0 0 1.66 0L21 12 M2 17l8.58 3.91a2 2 0 0 0 1.66 0L21 17',
    options: [
      { value: 'STANDARD', label: 'Invoice' },
      { value: 'DEPOSIT', label: 'Deposit' },
      { value: 'PLAN', label: 'Service plan' },
    ],
  },
  {
    key: 'total',
    kind: 'range',
    param: 'total',
    label: 'Total',
    // lucide's Banknote icon — same converted path Estimates' registry uses
    // for its "Total" facet, reused verbatim (both are the invoice/estimate
    // grand-total field).
    icon: 'M4 6H20A2 2 0 0 1 22 8V16A2 2 0 0 1 20 18H4A2 2 0 0 1 2 16V8A2 2 0 0 1 4 6Z M14 12A2 2 0 1 1 10 12A2 2 0 1 1 14 12Z M6 12H6.01 M18 12H18.01',
    money: true,
    min: 0,
    // No backend "max total across all invoices" stat today — 100000 is a
    // sensible static money ceiling (mirrors estimates.ts's `total` facet:
    // a ceiling comfortably above realistic invoice totals, data-driveable
    // later if real totals start exceeding it).
    maxSource: 'invoices.maxTotal',
  },
  {
    key: 'balance',
    kind: 'range',
    param: 'balance',
    label: 'Balance Due',
    // lucide's Wallet icon (both subpaths are already `path` elements with
    // absolute `M` starts, so no circle/rect-to-path conversion was needed —
    // unlike Banknote above, which converts a `rect`+`circle`+two ticks).
    // Distinct from Total's Banknote icon so the two money facets are
    // visually distinguishable in the rail.
    icon: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1 M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
    money: true,
    min: 0,
    // Same static-ceiling reasoning as `total` above — no backend "max
    // amount_due across all invoices" stat today. `amount_due` can never
    // exceed `total_amount` for a given invoice, so reusing the same 100000
    // ceiling is a safe (if slightly generous) domain bound.
    maxSource: 'invoices.maxBalance',
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
  {
    key: 'due',
    kind: 'dateRange',
    param: 'due',
    label: 'Due',
    // lucide's CalendarClock icon — same converted path Jobs' registry uses
    // for its "Scheduled" facet, reused here for "Due" so the two dateRange
    // facets (Created vs Due) are visually distinguishable in the rail.
    icon: 'M16 14v2.2l1.6 1 M16 2v4 M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5 M3 10h5 M8 2v4 M10 16a6 6 0 1 0 12 0a6 6 0 1 0 -12 0',
  },
  {
    key: 'overdue',
    kind: 'multi',
    param: 'overdue',
    label: 'Overdue',
    // lucide's AlertTriangle icon — same icon the "Overdue" KPI tile already
    // uses (`InvoicesPage.tsx`'s `KpiStrip` item), reused here for visual
    // consistency between the tile and this facet.
    icon: 'M21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z M12 9v4 M12 17h.01',
    options: [{ value: 'true', label: 'Overdue' }],
  },
  TAGS_FACET,
];
