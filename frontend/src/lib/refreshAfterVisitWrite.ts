/**
 * The one refresh every visit write calls: book, reschedule, re-crew, cancel, complete, unschedule
 * and every lifecycle step, from the job page, the lead page, the scheduler board and the dialogs.
 * Every job CREATE calls it too (the job form, duplicate, lead and estimate conversion): a new job
 * is a new row on its customer's page, and the job form can book Visit 1 in the same request.
 * Deleting a job or a lead calls it as well (`{ deleted: true }`): its visits leave the board and
 * the customer page. The deleted record's OWN queries are then removed rather than invalidated: an
 * invalidated query still on screen refetches at once, and for a record that no longer exists
 * every one of those refetches is a 404, fired before the page navigates away.
 *
 * It exists because each write path used to keep its own list, and the lists drifted: none of
 * them named the customer page, whose queries sit under the app-wide five-minute staleTime, so a
 * job booked seconds ago read "Unscheduled" there until a reload. Adding a surface that shows a
 * visit means adding its key HERE, once, rather than at every write site.
 *
 * Customer keys are invalidated by PREFIX: write sites rarely know the owning customer, and
 * `['customer']` matches every `['customer', id]` (and not `['customers']`, the list). Invalidation
 * only refetches queries that are on screen; the rest are marked stale and refetch when shown.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { jobVisitsQueryKey } from '@/lib/useJobVisits';

/** What was written: one job's visits, several jobs' (a bulk action), or a lead's walkthrough visits. */
export type VisitWriteTarget =
  | { jobId: string }
  | { jobIds: readonly string[] }
  | { leadId: string };

/** The scheduler board's queries, prefix-matched so every date range and department filter is covered. */
const SCHEDULE_KEYS: readonly QueryKey[] = [
  ['schedule-jobs'],
  ['schedule-walkthroughs'],
  ['schedule-unassigned'],
  ['schedule-unscheduled-walkthroughs'],
];

/**
 * The customer page's queries that show a visit: the customer detail (its jobs and leads carry
 * their visits), the paged Leads and Jobs tabs, and the per-visit Schedule feed. Not the Events
 * list (`customer-calendar-entries`): a calendar entry is a standalone meeting with no job, lead
 * or visit behind it, and calendar-entry writes refresh it themselves.
 */
const CUSTOMER_KEYS: readonly QueryKey[] = [
  ['customer'],
  ['customer-leads'],
  ['customer-schedule'],
  ['customer-jobs'],
];

/** The written record's own queries: its detail, and for a job its visit list and timeline. */
function ownKeys(target: VisitWriteTarget): QueryKey[] {
  if ('leadId' in target) return [['lead', target.leadId]];
  const jobIds = 'jobId' in target ? [target.jobId] : target.jobIds;
  return jobIds.flatMap((id) => [['job', id], jobVisitsQueryKey(id), ['job-timeline', id]]);
}

/** The list the record appears in. */
function listKey(target: VisitWriteTarget): QueryKey {
  return 'leadId' in target ? ['leads'] : ['jobs'];
}

export interface VisitWriteOptions {
  /** The job or lead itself was deleted: drop its own queries instead of refetching them. */
  deleted?: boolean;
}

export function refreshAfterVisitWrite(
  queryClient: QueryClient,
  target: VisitWriteTarget,
  { deleted = false }: VisitWriteOptions = {},
): void {
  for (const queryKey of ownKeys(target)) {
    if (deleted) queryClient.removeQueries({ queryKey });
    else queryClient.invalidateQueries({ queryKey });
  }
  for (const queryKey of [listKey(target), ...SCHEDULE_KEYS, ...CUSTOMER_KEYS]) {
    queryClient.invalidateQueries({ queryKey });
  }
  if ('leadId' in target) {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }
}
