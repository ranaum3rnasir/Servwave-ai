/**
 * The per-visit feed behind the customer page's Schedule tab (visits-and-task-categories slice 04).
 *
 * Every visit of the customer's jobs and every walkthrough visit of the customer's leads, each with
 * its own window and its OWN crew - never the job-wide crew union the Jobs tab's technician column
 * shows. The client turns this into one row per visit ("Visit 2 of 3"). The Jobs tab's date is
 * NOT read off this feed: GET /api/customers/:id/jobs serves each job's `scheduled_start` through
 * the job-window rule (lib/job-schedule-projection.ts), which picks one of these same visits.
 *
 * Cancelled visits are included on purpose: the tab marks them rather than silently dropping them.
 * The client numbers visits with the scheduler's own rule (frontend lib/visits.ts visitDenominator).
 */
import type { Prisma } from '@prisma/client';

const crewUserSelect = { id: true, first_name: true, last_name: true } as const;

/**
 * The nested `visits` relation select for a job or lead. The explicit `organization_id` filter is
 * belt and braces over the parent's own tenant filter: a visit row from another organization can
 * never ride along on a matching parent.
 */
export function customerScheduleVisitsArg(organizationId: string) {
  return {
    where: { organization_id: organizationId },
    select: {
      id: true,
      visit_seq: true,
      status: true,
      scheduled_at: true,
      scheduled_end: true,
      is_all_day: true,
      created_at: true,
      assignees: { select: { user: { select: crewUserSelect } } },
    },
    orderBy: { visit_seq: 'asc' },
  } satisfies Prisma.Job$visitsArgs;
}

type ScheduleVisitRow = Prisma.VisitGetPayload<{ select: ReturnType<typeof customerScheduleVisitsArg>['select'] }>;

export interface CustomerScheduleVisit {
  id: string;
  visit_seq: number;
  status: ScheduleVisitRow['status'];
  scheduled_at: Date | null;
  scheduled_end: Date | null;
  is_all_day: boolean;
  created_at: Date;
  crew: Array<{ id: string; first_name: string; last_name: string }>;
}

/** `assignees: [{ user }]` flattened to `crew: [user]` - the visit's own crew, nothing merged in. */
export function presentScheduleVisit(v: ScheduleVisitRow): CustomerScheduleVisit {
  const { assignees, ...rest } = v;
  return { ...rest, crew: assignees.map((a) => a.user) };
}
