import type { JobStatus, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { scopeWhereForUser, type PermissionUser } from './permissions/enforce';
import { COMPLETED_OR_LATER_JOB_STATUSES, JOB_STATUS_ORDER } from './job-status-order';
import { LIVE_VISIT_STATUSES } from './visit-status';
import { OPEN_LEAD_STATUSES } from '../services/lead-status-options';
import { addOrgDays, orgDayOf, orgDayStart } from './orgDayRange';
import { getOrgTimezone } from './timezone';

/**
 * The Missing crew predicate (Roles & Permissions, PRD 3).
 *
 * Booked job visits and booked walkthroughs - a time is set, the visit is not cancelled and not
 * finished - that start in the next 7 days (see the window below) with nobody on their crew, on a job that is not Cancelled
 * and not Completed or later, or on an open lead. Nobody else counts as crew: a job's Sold By and
 * Dispatcher and a lead's Owner and Dispatcher are people on the record, not people on the visit.
 * A walkthrough with performers and no time has no start to be late for, so it is never counted.
 *
 * This is the one place that says what Missing crew means. The dashboard tile, the Needs Attention
 * item and the Schedule's "No crew" filter all read it; none of them may count it differently.
 *
 * Each viewer counts only the jobs and leads they can open: the job and lead row-scopes are the ones
 * every list uses (`scopeWhereForUser`), so a person without View jobs counts no job visits and a
 * person without View leads counts no walkthroughs.
 */

/** How many calendar days ahead, counting today, a booked visit with nobody on it is worth surfacing. */
export const MISSING_CREW_WINDOW_DAYS = 7;

/**
 * Where the window ends: the moment the company's day after the 7th one begins (today is the 1st), read on the
 * company's clock. The window is whole calendar days, not 168 hours from now, because the Schedule's "No crew" filter
 * shows seven day columns starting at today's: a visit in the first hours of the 8th day is on neither, and a
 * rolling window would count it though the board has no column to show it in. The tile, the Needs Attention item
 * and the Schedule all end here, so they cannot disagree. Derived from the next day's start, not from a
 * 23:59:59.999 offset, so a 23- or 25-hour day is exact.
 */
export function missingCrewWindowEnd(now: Date, timeZone: string): Date {
  return orgDayStart(addOrgDays(orgDayOf(now, timeZone), MISSING_CREW_WINDOW_DAYS), timeZone);
}

/**
 * The job statuses a Missing crew visit may sit on: every status that is neither Cancelled nor in the
 * completed-or-later set (both read from the status order, so a status added to it is placed once).
 */
export const MISSING_CREW_JOB_STATUSES: readonly JobStatus[] = JOB_STATUS_ORDER.filter(
  (status) => status !== 'CANCELLED' && !COMPLETED_OR_LATER_JOB_STATUSES.includes(status),
);

/** The visit half of the test: booked (live, timed), starting from now to the end of the window, with nobody on its crew. */
export function missingCrewBookedVisit(now: Date, timeZone: string): Prisma.VisitWhereInput {
  return {
    status: { in: [...LIVE_VISIT_STATUSES] },
    scheduled_at: { gte: now, lt: missingCrewWindowEnd(now, timeZone) },
    assignees: { none: {} },
  };
}

/**
 * The jobs a Missing crew visit may be on, as a job `where`: a live job holding a Missing crew visit. For a list of
 * jobs (the Schedule's feed) that already carries its own tenant and row scope, composed under `AND`.
 */
export function missingCrewJobWhere(now: Date, timeZone: string): Prisma.JobWhereInput {
  return { status: { in: [...MISSING_CREW_JOB_STATUSES] }, visits: { some: missingCrewBookedVisit(now, timeZone) } };
}

/** The same for leads: an open lead holding a Missing crew walkthrough. */
export function missingCrewLeadWhere(now: Date, timeZone: string): Prisma.LeadWhereInput {
  return { status: { in: [...OPEN_LEAD_STATUSES] }, visits: { some: missingCrewBookedVisit(now, timeZone) } };
}

/**
 * The row scopes a Missing crew visit is counted over: the jobs the person can open and the leads they can open.
 * `lead: null` leaves the walkthroughs out altogether (a person without View leads is sent none).
 */
export type MissingCrewScope = { job: Record<string, unknown>; lead: Record<string, unknown> | null };

/**
 * The `where` for the Missing crew visits over a row scope: the company, narrowed to the visits of the jobs and
 * the leads that scope reaches. The one builder every reading of the test goes through (the tile, the Needs
 * Attention item and the Schedule's "No crew" filter), so the numbers are the same query and cannot disagree.
 */
export function missingCrewVisitWhereIn(
  org: { organization_id: string },
  scope: MissingCrewScope,
  now: Date,
  timeZone: string,
): Prisma.VisitWhereInput {
  return {
    ...org,
    ...missingCrewBookedVisit(now, timeZone),
    OR: [
      { job: { AND: [scope.job as Prisma.JobWhereInput, { status: { in: [...MISSING_CREW_JOB_STATUSES] } }] } },
      ...(scope.lead ? [{ lead: { AND: [scope.lead as Prisma.LeadWhereInput, { status: { in: [...OPEN_LEAD_STATUSES] } }] } }] : []),
    ],
  };
}

/** The `where` for the viewer's Missing crew visits: only the jobs and leads they can open. */
export async function missingCrewVisitWhere(viewer: PermissionUser, now: Date = new Date()): Promise<Prisma.VisitWhereInput> {
  const [job, lead, timeZone] = await Promise.all([
    scopeWhereForUser(viewer, 'Job'),
    scopeWhereForUser(viewer, 'Lead'),
    getOrgTimezone(viewer.organization_id),
  ]);
  return missingCrewVisitWhereIn({ organization_id: viewer.organization_id }, { job, lead }, now, timeZone);
}

/** The viewer's Missing crew visits, soonest first. */
export async function findMissingCrew(viewer: PermissionUser, opts: { now?: Date; take?: number } = {}) {
  return prisma.visit.findMany({
    where: await missingCrewVisitWhere(viewer, opts.now),
    select: { id: true, scheduled_at: true, purpose: true, job_id: true, lead_id: true },
    orderBy: { scheduled_at: 'asc' },
    take: opts.take,
  });
}

/** How many Missing crew visits the viewer has. */
export async function countMissingCrew(viewer: PermissionUser, opts: { now?: Date } = {}): Promise<number> {
  return prisma.visit.count({ where: await missingCrewVisitWhere(viewer, opts.now) });
}
