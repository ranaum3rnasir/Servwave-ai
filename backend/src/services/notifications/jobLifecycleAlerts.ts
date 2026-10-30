/**
 * jobLifecycleAlerts.ts - the one place the job started, job cancelled and job reopened alerts are sent from (Roles &
 * Permissions, PRD 6, S06.25).
 *
 * Each goes out through M6's two lanes (alertChain.ts): the job's stored Sold By, crew and Dispatcher; whoever must act
 * next (the Dispatcher, else the holders of the verb's step switch who can open the job, else the Manage roles and
 * permissions holders); and a copy to the Alert me about every job holders. The step switch is Assign people to jobs for
 * started and Office review for cancelled and reopened (the M6 table). Nobody comes from a role name. A job is only ever
 * cancelled, never lost: there is no Job lost alert.
 *
 * The people who reached it as a fallback are told why ("This job has no Dispatcher") and the others are not, so an
 * action goes out as up to two alerts: one without the line and one with it. Nobody is on both. Priorities and "needs
 * action" are what each verb always had (see resolveRecipients).
 *
 * Sent AFTER the change committed and AFTER the response, off the request queue (reviewAttentionQueue): a bulk of jobs
 * walks the chain once per job, every walk costing the same few batched reads whatever the size of the company, and none
 * of it is on the request. Fire-and-forget: a failure is logged and never reaches the change that already landed.
 */

import { logger } from '../../lib/logger';
import { jobCrewIds } from '../../lib/job-crew';
import { sendByWhyLine, twoLaneRecipients } from './alertChain';
import { emit } from './notificationService';
import { queueReviewAttention } from './reviewAttentionQueue';

export type JobLifecycleVerb = 'job.started' | 'job.cancelled' | 'job.reopened';

/** What each verb is called in a log line and in the why line, and the switch whose holders must act when there is no Dispatcher. */
const ROWS: Record<JobLifecycleVerb, { stepSwitch: string; step: string; alert: string }> = {
  'job.started': { stepSwitch: 'assign_people_to_jobs', step: 'assign people to jobs', alert: 'job started alert' },
  'job.cancelled': { stepSwitch: 'office_review', step: 'review jobs', alert: 'job cancelled alert' },
  'job.reopened': { stepSwitch: 'office_review', step: 'review jobs', alert: 'job reopened alert' },
};

/** The job as the alert needs it: its number and its people. */
export interface JobLifecycleJob {
  jobNumber: string;
  /** The job's stored Sold By; an empty one sends no Sold By alert, whatever the estimate's lead has as an Owner. */
  soldById: string | null;
  /** The people on the job's visits. */
  crewIds: string[];
  dispatcherId: string | null;
}

export async function alertJobLifecycle(args: {
  verb: JobLifecycleVerb;
  organizationId: string;
  /** The person who did it; never someone for the alert. */
  actorId: string | null;
  jobId: string;
  job: JobLifecycleJob;
  /** Extra display data kept on the alert (the cancel reason, for instance). */
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { job } = args;
    const row = ROWS[args.verb];
    const people = await twoLaneRecipients({
      organizationId: args.organizationId,
      record: { type: 'JOB', id: args.jobId },
      actorId: args.actorId,
      recordPeople: [...(job.soldById ? [job.soldById] : []), ...job.crewIds],
      dispatcherId: job.dispatcherId,
      stepSwitch: row.stepSwitch,
      copySwitch: 'alert_every_job',
      words: { record: 'job', step: row.step, alert: row.alert },
    });

    await sendByWhyLine(people, (entity, whyLine) =>
      emit({
        verb: args.verb,
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'JOB', id: args.jobId, label: job.jobNumber },
        // `crew_ids` is for the priority only: a cancelled job interrupts its crew.
        entity: { ...entity, crew_ids: job.crewIds },
        data: { ...(args.data ?? {}), object_label: job.jobNumber, fallback_reason: whyLine ?? '' },
      }));
  } catch (err) {
    logger.warn('[jobLifecycleAlerts] could not send a job alert', {
      verb: args.verb, jobId: args.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Leave the alert for after the response. `job` is the row the request just wrote (the detail select: its stored Sold By, its
 * Dispatcher and the crew on its visits), so the alert is queued without one more read on the request.
 */
export function queueJobLifecycleAlert(args: {
  verb: JobLifecycleVerb;
  orgId: string;
  actorId: string | null;
  jobId: string;
  jobNumber: string;
  job: Parameters<typeof jobCrewIds>[0] & { salesperson?: { id: string } | null; dispatcher?: { id: string } | null };
  data?: Record<string, unknown>;
}): void {
  queueReviewAttention({
    orgId: args.orgId, actorId: args.actorId, jobId: args.jobId, onlyIfDone: false, items: [],
    lifecycle: {
      verb: args.verb,
      job: {
        jobNumber: args.jobNumber,
        soldById: args.job.salesperson?.id ?? null,
        crewIds: jobCrewIds(args.job),
        dispatcherId: args.job.dispatcher?.id ?? null,
      },
      data: args.data,
    },
  });
}
