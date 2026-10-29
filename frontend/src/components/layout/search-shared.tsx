// Shared types, constants, and helpers for search components (GlobalSearch + ScheduleSearch)

import { STATUS_REGISTRY, STATUS_INTENT_FILL, type StatusDomain } from '@/design-system/status-registry';

export interface SearchResult {
  id: string;
  entity_type: 'job' | 'customer' | 'lead' | 'estimate' | 'service-plan' | 'calendar-entry';
  title: string;
  subtitle?: string | null;
  date?: string | null;
  address?: string | null;
  phone?: string | null;
  status?: string | null;
  total?: number | null;
}

export interface SearchResponse {
  results: {
    jobs: SearchResult[];
    customers: SearchResult[];
    leads: SearchResult[];
    estimates: SearchResult[];
    invoices: SearchResult[];
    /** Schedule scope only - the board's third schedulable type. Empty elsewhere. */
    servicePlans: SearchResult[];
    /**
     * Schedule scope only (Slice 09) - the board's fourth schedulable type (user-facing
     * "Event"). Matched on title only (spec §3 - an entry carries no record number). Empty
     * elsewhere, and empty (not missing) for a caller without `read CalendarEntry`.
     */
    calendarEntries: SearchResult[];
  };
}

/**
 * A search row carries its entity_type, so its status resolves in ITS OWN registry
 * domain. That is what the previous flat STATUS_DOT map could not express: it keyed
 * on the status VALUE alone, so LeadStatus and EstimateStatus collided on shared
 * names (WON, CANCELLED, SENT) and the map needed a comment apologising for it.
 * Customers have no status, so they never resolve a dot.
 */
const RESULT_DOMAIN: Record<SearchResult['entity_type'], StatusDomain | null> = {
  job:              'job',
  customer:         null,
  lead:             'lead',
  estimate:         'estimate',
  'service-plan':   'servicePlan',
  // An Event carries no status (spec §3) - `result.status` is never set for this entity_type,
  // so statusDotClass/statusLabel are never called with it in practice. Present anyway so this
  // Record stays exhaustive over SearchResult['entity_type'].
  'calendar-entry': null,
};

/**
 * Dot class for a search row's status - registry-resolved, never a local colour map.
 * The dot is a solid swatch carrying no text of its own, so it takes the registry's
 * FILL role rather than the tinted-chip CLASSES role.
 */
export function statusDotClass(entityType: SearchResult['entity_type'], status: string): string {
  const domain = RESULT_DOMAIN[entityType];
  const intent = domain ? STATUS_REGISTRY[domain][status]?.intent : undefined;
  return STATUS_INTENT_FILL[intent ?? 'neutral'];
}

/**
 * Label for a search row's status. Registry-resolved for `job` and `lead`; every
 * other entity type keeps the humaniser, which is also the fallback for any status
 * value the registry does not carry.
 *
 * `estimate` is deliberately HELD on the fallback path (E1). Routing it here would
 * land EstimateStatus.PENDING's contested label into a compact global-search meta
 * row - see the E1 note on ESTIMATE_STATUS in design-system/status-registry.ts, where
 * two contradictory decisions about what PENDING means are still unadjudicated. Do
 * not "simplify" this into a domain-agnostic lookup until that is settled.
 */
/*
 * SR-E6 - COPY ESCALATION. Routing this function through the registry ships THREE
 * SEMANTIC label rewords in GlobalSearch and ScheduleSearch. They are listed here so
 * they are adjudicated rather than absorbed:
 *
 *   lead.WALKTHROUGH_SCHEDULED   'WALKTHROUGH SCHEDULED' -> 'WT Scheduled'
 *   lead.WALKTHROUGH_COMPLETED   'WALKTHROUGH COMPLETED' -> 'WT Completed'
 *   lead.ESTIMATED               'ESTIMATED'             -> 'Estimate Sent'
 *
 * KEEP, not revert. Those three strings were ALREADY the app-wide lead labels at
 * origin/staging: STATUS_REGISTRY.lead carried them byte for byte, LeadsPage renders
 * <StatusBadge domain="lead"> off that same registry, and
 * lib/filters/registries/leads.ts STATUS_LABELS repeated them verbatim for the Status
 * facet. Global search was the LONE lead surface still shouting the raw enum, so this
 * moves the one outlier onto the wording every other lead surface already showed.
 * Reverting the three would put global search back out of step with the rest of the
 * app, which is worse than the reword. The defect being corrected here is process,
 * not outcome: this diff holds its other copy changes for review behind SR-E1/SR-E2/
 * SR-E4/SR-E5 and was shipping these three by omission.
 *
 * The other ELEVEN label changes on this path (six job, five lead) are CASE ONLY,
 * e.g. 'EN ROUTE' -> 'En Route'. The old humaniser
 * `s.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())` only UPCASES, so on an
 * already-uppercase enum literal it returned the value verbatim, and neither meta row
 * applies a CSS case transform (GlobalSearch.tsx:204 and ScheduleSearch.tsx:179 are
 * both `truncate flex-shrink-0`). ALL CAPS is what actually shipped. The full before
 * and after for all 23 reachable lead/job/estimate statuses is the appearance table in
 * md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md.
 *
 * ID scheme: this escalation series is prefixed SR- because the bare E-numbers already
 * mean something unrelated on origin/staging (E2 call attribution in
 * stores/dialer.store.ts, E5 comms gating in JobCommunicationsTab.tsx, E6 the shared
 * CommRow in LeadCommunicationsTab.tsx). The un-prefixed E1/E2/E4/E5 citations
 * elsewhere in this diff, including the E1 note directly above, belong to this SR-
 * series and are defined in that same work-package file.
 */
export function statusLabel(entityType: SearchResult['entity_type'], status: string): string {
  // Display-only rename (job scheduling state) - the enum VALUE stays UNSCHEDULED.
  if (status === 'UNSCHEDULED') return 'Unscheduled';
  const domain = RESULT_DOMAIN[entityType];
  const label =
    domain === 'job' || domain === 'lead' ? STATUS_REGISTRY[domain][status]?.label : undefined;
  return label ?? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query || query.length < 2) return text;
  const words = query.split(/\s+/).filter(Boolean);
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    regex.test(part)
      ? <span key={i} className="font-semibold text-text-primary">{part}</span>
      : part,
  );
}
