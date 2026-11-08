/**
 * The customer schedule projection (visits-and-task-categories slice 04).
 *
 * Turns `GET /api/customers/:id/schedule` - every visit of the customer's jobs and every
 * walkthrough visit of the customer's leads - into ONE ROW PER VISIT, labelled "Visit n of m",
 * sorted by time. The customer page's Schedule tab renders these rows. The Jobs and Leads tabs do
 * NOT derive their dates from them: each row of their own pages carries the date the server picked
 * (`scheduled_start` by the job-window rule, `next_walkthrough` by slice 05's rule), which is always
 * one of these same visits, so the page fetches this feed only while the Schedule tab is open.
 *
 * Pure: no React, no fetching, no clock read unless the caller omits `now`.
 */

import { visitDenominator } from '@/lib/visits';

export interface CustomerScheduleCrewMember {
  id: string;
  first_name: string;
  last_name: string;
}

/** One visit as the endpoint serves it: its own window and its OWN crew, never a job-wide union. */
export interface CustomerScheduleVisit {
  id: string;
  visit_seq: number;
  status: string;
  scheduled_at: string | null;
  scheduled_end: string | null;
  is_all_day: boolean;
  created_at: string;
  crew: CustomerScheduleCrewMember[];
}

export interface CustomerScheduleJob {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  visits: CustomerScheduleVisit[];
}

export interface CustomerScheduleLead {
  id: string;
  lead_number: string;
  status: string;
  service_request: string;
  visits: CustomerScheduleVisit[];
}

/** The `GET /api/customers/:id/schedule` response. */
export interface CustomerSchedule {
  jobs: CustomerScheduleJob[];
  leads: CustomerScheduleLead[];
}

export type CustomerVisitRowKind = 'job' | 'walkthrough';

export interface CustomerVisitRow {
  key: string;
  kind: CustomerVisitRowKind;
  /** The job or lead the visit belongs to - what a row click opens. */
  parentId: string;
  /** J00044 / L00075. */
  number: string;
  title: string;
  /** Null only on the placeholder row of a job that holds no visit yet. */
  visitId: string | null;
  /**
   * "Visit 2 of 3" - the total is the board's (lib/visits.ts visitDenominator). A cancelled visit
   * reads "Visit 3" alone. Null on the placeholder row.
   */
  visitLabel: string | null;
  status: string;
  /**
   * A called-off trip. Kept as a row so the office can see it was booked and cancelled, and
   * MARKED so it is never read as upcoming work. It does not count toward "of m".
   */
  cancelled: boolean;
  /** ISO instant, or null for a visit with no time yet - sorts last. */
  start: string | null;
  end: string | null;
  isAllDay: boolean;
  /** Display names of THIS visit's crew; empty = unassigned. */
  crew: string[];
}

function crewNames(crew: CustomerScheduleCrewMember[]): string[] {
  return crew.map((c) => `${c.first_name} ${c.last_name}`.trim());
}

function visitRows(
  kind: CustomerVisitRowKind,
  parent: { id: string; number: string; title: string; visits: CustomerScheduleVisit[] },
): CustomerVisitRow[] {
  const total = visitDenominator(parent.visits);
  return parent.visits.map((v) => ({
    key: `${kind}-visit-${v.id}`,
    kind,
    parentId: parent.id,
    number: parent.number,
    title: parent.title,
    visitId: v.id,
    // A cancelled trip has no place in the live count, so it carries its number alone; the tab
    // renders it as "Visit 3 · Cancelled".
    visitLabel: v.status === 'CANCELLED' ? `Visit ${v.visit_seq}` : `Visit ${v.visit_seq} of ${total}`,
    status: v.status,
    cancelled: v.status === 'CANCELLED',
    start: v.scheduled_at,
    end: v.scheduled_end,
    isAllDay: v.is_all_day,
    crew: crewNames(v.crew),
  }));
}

/** Time order; a row with no time sorts last, keeping its incoming order. */
function byStart(a: { start: string | null }, b: { start: string | null }): number {
  if (a.start === null && b.start === null) return 0;
  if (a.start === null) return 1;
  if (b.start === null) return -1;
  return new Date(a.start).getTime() - new Date(b.start).getTime();
}

const jobTitle = (j: CustomerScheduleJob) => j.scope_notes?.trim() || 'Job';

/**
 * A job with no visit yet still gets ONE unscheduled row (sorted last): the row says "this job
 * exists for this customer and nobody is booked on it", which is exactly what the office needs to
 * see. A lead with no walkthrough gets none - a lead is not work until a visit is booked.
 */
function unscheduledJobRow(j: CustomerScheduleJob): CustomerVisitRow {
  return {
    key: `job-unscheduled-${j.id}`,
    kind: 'job',
    parentId: j.id,
    number: j.job_number,
    title: jobTitle(j),
    visitId: null,
    visitLabel: null,
    status: j.status,
    cancelled: false,
    start: null,
    end: null,
    isAllDay: false,
    crew: [],
  };
}

export function projectCustomerSchedule(schedule: CustomerSchedule): CustomerVisitRow[] {
  const jobRows = schedule.jobs.flatMap((j) =>
    j.visits.length === 0
      ? [unscheduledJobRow(j)]
      : visitRows('job', { id: j.id, number: j.job_number, title: jobTitle(j), visits: j.visits }),
  );
  const walkthroughRows = schedule.leads.flatMap((l) =>
    // The lead's own service request, not a bare "Walkthrough" - the type chip already says that.
    visitRows('walkthrough', { id: l.id, number: l.lead_number, title: l.service_request?.trim() || 'Walkthrough', visits: l.visits }),
  );
  return [...jobRows, ...walkthroughRows].sort(byStart);
}
