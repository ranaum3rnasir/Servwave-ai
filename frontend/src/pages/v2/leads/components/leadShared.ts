/** Shared helpers for the v2 lead detail page and its walkthrough tab. */

import { formatInstant } from '@/lib/schedule-tz';

export interface UserSummary {
  id: string;
  first_name: string;
  last_name: string;
}

/**
 * D14: `walkthrough_count` / `walkthrough_history` are full-detail-only fields -
 * the raw Walkthrough rows for this lead, newest first.
 */
export interface VisitHistoryRow {
  id: string;
  /**
   * D13 - the trip's creation-order number, the one the customer's email subject names.
   * Nullable because a row written before the projection carried it has none to show
   * (MV-LEAD-13).
   */
  visit_seq: number | null;
  status: string;
  scheduled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  /**
   * Visit-location slice 6: where this trip was, already resolved server-side, or null for the
   * service address. Structurally `VisitRow['location_label']` (lib/visits.ts) - these rows are
   * handed to `otherVisits` as such - and it is stated here for the same reason the rest of this
   * interface is: this is the shape the lead DETAIL payload's `walkthrough_history` arrives in.
   */
  location_label?: string | null;
}

/**
 * Both renderers take the ORG zone, and take it as a REQUIRED argument.
 *
 * They used to resolve against the viewer's browser, which put every date and time on
 * the lead surfaces - the hero, the walkthrough tab, visit history rows, the conflict
 * list and the estimates table - on a different clock from the job surfaces beside them.
 * walkthroughTab contradicted itself inside one component: its picker seeded from the org
 * zone while the Starts/Ends readout two lines below printed the browser's (#1634, and
 * the lead half of MV-TZ-08).
 *
 * `tz` is required rather than defaulted so a new call site cannot quietly reintroduce
 * the leak by omitting it; `formatInstant` applies the zone AFTER the options, so a
 * stray `timeZone` in a future opts bag cannot put the viewer's zone back either.
 */
export function formatDate(date: string, tz: string): string {
  return formatInstant(date, tz, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(date: string, tz: string): string {
  return formatInstant(date, tz, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * "Is the CURRENT visit actively scheduled", derived from the three projected
 * timestamps rather than from lead.status.
 *
 * The guard order is load-bearing: a CANCELLED visit keeps its `scheduled_at`
 * set (kept as history so the backend can still resolve "the most recent visit
 * that happened"), so `scheduledAt` alone is not "still scheduled" -
 * `completedAt` and `cancelledAt` must both be excluded first.
 */
export function isWalkthroughActive(
  scheduledAt: unknown,
  completedAt: unknown,
  cancelledAt: unknown,
): boolean {
  return Boolean(scheduledAt) && !completedAt && !cancelledAt;
}
