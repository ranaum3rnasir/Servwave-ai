import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { TAGS_FACET, type FacetConfig } from '@/lib/filters/types';

/**
 * Lead pipeline statuses, in pipeline order. Single source of truth for the
 * Status facet's static options - was previously duplicated inline in
 * `LeadsPage.tsx`; now lives here so the registry and any other Leads-page
 * consumer share one definition.
 *
 * Walkthrough Scheduled and Walkthrough Completed sit between Contacted and Estimate Sent. The
 * lead moves onto them as its walkthrough visits are booked and finished (the visit itself still
 * lives on the Walkthrough row; see the `walkthrough_status` facet below). This list is both the
 * filterable AND the settable vocabulary, and its order is the order every menu and filter shows.
 */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
  'ESTIMATED',
  'WON',
  'LOST',
  'CANCELLED',
];

/**
 * The closed end of the pipeline: a WON (converted), LOST or CANCELLED lead needs no more work.
 * The frontend copy of the backend's `TERMINAL_LEAD_STATUSES` (services/lead-stage.service.ts),
 * same members; kept beside LEAD_STATUSES so the lead vocabulary stays in one file.
 */
export const TERMINAL_LEAD_STATUSES: readonly string[] = ['WON', 'LOST', 'CANCELLED'];

export function isTerminalLeadStatus(status: string): boolean {
  return TERMINAL_LEAD_STATUSES.includes(status);
}

/**
 * Today the backend's synthetic `walkthrough_status` facet only recognizes
 * `'needs_scheduling'` (see `backend/src/lib/query/registries/lead.filters.ts`),
 * but the option list mirrors the full set the page has always offered so the
 * control isn't a single-choice toggle in disguise; picking a value the
 * backend doesn't special-case is a client-side no-op (filters nothing out),
 * matching the pre-refactor page's behavior exactly.
 */
export const WALKTHROUGH_FILTERS = [
  { value: 'needs_scheduling', label: 'Needs Scheduling' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'not_needed', label: 'Not Needed' },
];

/**
 * Leads list facet registry (Task 9). One `FacetConfig` per Task 4 backend
 * facet (`backend/src/lib/query/registries/lead.filters.ts`) — every `param`
 * below matches that file's `param` exactly; that match is the wire contract
 * `useFilterState`/`urlCodec` rely on to produce query params the backend
 * actually reads. `customer_id` is a real backend facet too, but it's driven
 * by page-to-page navigation (e.g. "view this customer's leads"), not a rail
 * facet a user picks from the Filter popover, so it's intentionally absent
 * here.
 *
 * Exported as a module-level `const` (not a function or inline literal) per
 * `useFilterState.ts`'s reference-stability requirement — passing a
 * freshly-allocated array on every render would thrash `useFilterState`'s
 * internal memoization.
 */
export const leadsRegistry: FacetConfig[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    label: 'Status',
    icon: 'M21.801 10A10 10 0 1 1 17 3.335 M9 11 3 3L22 4',
    // Static: lead statuses are fixed (every company sees the same vocabulary), so the wire VALUE
    // and the label both come straight from the enum and the status registry.
    options: LEAD_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.lead[s]?.label ?? s })),
  },
  {
    key: 'ad_source',
    kind: 'multi',
    param: 'ad_source',
    label: 'Source',
    icon: 'M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14 M8 6v8',
    optionSource: 'org.sourceOptions',
  },
  {
    key: 'job_type',
    kind: 'multi',
    param: 'job_type',
    label: 'Type',
    icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    optionSource: 'org.jobTypeOptions',
  },
  {
    key: 'assigned_to',
    kind: 'multi',
    param: 'assigned_to',
    label: 'Assigned To',
    icon: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7A4 4 0 1 1 8 7A4 4 0 1 1 16 7Z',
    // Resolved by the page's resolveOptions('assignableUsers') — MUST include
    // an {value:'UNASSIGNED', label:'Unassigned'} option; the backend facet
    // (lead.filters.ts) treats that value specially (`lead_assignees: {none: {}}`).
    optionSource: 'assignableUsers',
  },
  {
    key: 'walkthrough_status',
    kind: 'multi',
    param: 'walkthrough_status',
    label: 'Walkthrough',
    icon: 'M18 6 7 17l-5-5 M22 10-7.5 7.5L13 16',
    options: WALKTHROUGH_FILTERS,
  },
  {
    key: 'estimates',
    kind: 'range',
    param: 'estimates',
    label: '# of Estimates',
    icon: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z M14 2v5a1 1 0 0 0 1 1h5 M10 9H8 M16 13H8 M16 17H8',
    unit: 'estimates',
    min: 0,
    // No backend field for "max estimates on any one lead" today — 20 is a
    // sensible static ceiling (matches the approved filter-system mockup).
    // Could be made data-driven (e.g. a stat from the leads list response)
    // later if orgs start exceeding it.
    maxSource: 'leads.maxEstimates',
  },
  {
    key: 'created',
    kind: 'dateRange',
    param: 'created',
    label: 'Created',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  TAGS_FACET,
];
