/**
 * visitDoorAlerts.ts - what the doors that book, move or re-crew ONE trip of a job raise (Roles & Permissions, PRD 6, S06.27).
 *
 * The Schedule page and the visit dialog write a trip through PATCH /api/jobs/:id/visits/:visitId and POST /api/jobs/:id/visits,
 * not through the older assign and assignees doors, and used to tell nobody. They now say what those doors say, through the same
 * senders (jobSchedulingAlerts.ts, left for after the response): Job assigned to the people put on the trip; a move that names
 * nobody new is Job rescheduled (one that also names someone is "assigned", as the assign door has it); Unassigned from you to the
 * people who came off, naming the trip when they are still on another one. A request that changed nothing raises nothing, and
 * restating a trip's crew adds and removes nobody because the caller hands over the write's own delta.
 */

import { queueJobSchedulingAlert, queueJobUnassignedAlert } from './jobSchedulingAlerts';

export interface VisitDoorAlertArgs {
  organizationId: string;
  actorId: string | null;
  jobId: string;
  jobNumber: string;
  /** The people the request put on THIS trip. */
  added: string[];
  /** The people the request took off THIS trip. */
  removed: string[];
  /** The people on ANOTHER trip of the job that is not cancelled: taken off this trip, they have not left the job. */
  onOtherTrips: ReadonlySet<string>;
  /** The request moved the trip (or booked the job's first date): the job's people are told it was rescheduled. */
  moved: boolean;
  trip: { seq: number; scheduledAt: Date | null };
}

export function queueVisitDoorAlerts(args: VisitDoorAlertArgs): void {
  const { organizationId, actorId, jobId, jobNumber, trip } = args;
  const scheduledStart = trip.scheduledAt?.toISOString() ?? null;

  if (args.added.length > 0) {
    queueJobSchedulingAlert({ verb: 'dispatch.job_assigned', organizationId, actorId, jobId, namedIds: args.added, scheduledStart });
  } else if (args.moved) {
    queueJobSchedulingAlert({ verb: 'dispatch.job_rescheduled', organizationId, actorId, jobId, scheduledStart });
  }

  const offJob = args.removed.filter((id) => !args.onOtherTrips.has(id));
  const offTripOnly = args.removed.filter((id) => args.onOtherTrips.has(id));
  if (offJob.length > 0) {
    queueJobUnassignedAlert({ organizationId, actorId, jobId, jobNumber, removedIds: offJob, scheduledStart });
  }
  if (offTripOnly.length > 0) {
    queueJobUnassignedAlert({ organizationId, actorId, jobId, jobNumber, removedIds: offTripOnly, scheduledStart, trip });
  }
}
