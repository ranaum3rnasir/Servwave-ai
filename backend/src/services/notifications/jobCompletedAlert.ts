/**
 * jobCompletedAlert.ts - the one place the job-completed alert is sent from (Roles & Permissions, PRD 6, S06.23).
 *
 * When a job is completed it lands in Office review, and one bell alert goes out through M6's two lanes (alertChain.ts):
 * the job's stored Sold By, crew and Dispatcher; whoever must act next (the Dispatcher, else the Office review holders
 * who can open the job, else the Admins); and a copy to the Alert me about every job
 * holders. Its link opens the job with the review panel open. In-app only.
 *
 * The people who reached it as a fallback are told why ("This job has no Dispatcher") and the others are not, so a
 * completion goes out as up to two alerts: one without the line and one with it. Nobody is on both.
 *
 * Fire-and-forget: a failure here is logged and never reaches the completion that already landed.
 */

import { logger } from '../../lib/logger';
import { sendByWhyLine, twoLaneRecipients } from './alertChain';
import { emit } from './notificationService';

/** The panel inside the job this alert opens. The job page decides whether the viewer may see it. */
export const REVIEW_PANEL = 'review';

export async function alertJobCompleted(args: {
  organizationId: string;
  /** The person who completed the job; never someone for the alert. */
  actorId: string;
  job: {
    id: string;
    job_number: string;
    /** The job's stored Sold By. */
    salesperson_id: string | null;
    dispatcher_id: string | null;
    /** The people on the job's visits. */
    crewIds: string[];
  };
}): Promise<void> {
  try {
    const { job } = args;
    const people = await twoLaneRecipients({
      organizationId: args.organizationId,
      record: { type: 'JOB', id: job.id },
      actorId: args.actorId,
      recordPeople: [...(job.salesperson_id ? [job.salesperson_id] : []), ...job.crewIds],
      dispatcherId: job.dispatcher_id,
      stepSwitch: 'office_review',
      copySwitch: 'alert_every_job',
      words: { record: 'job', step: 'review jobs', alert: 'job completed alert' },
    });

    await sendByWhyLine(people, (entity, whyLine) =>
      emit({
        verb: 'job.completed',
        organizationId: args.organizationId,
        actorId: args.actorId,
        object: { type: 'JOB', id: job.id, label: job.job_number },
        entity,
        data: { object_label: job.job_number, panel: REVIEW_PANEL, fallback_reason: whyLine ?? '' },
      }));
  } catch (err) {
    logger.warn('[jobCompletedAlert] could not send the job completed alert', {
      jobId: args.job.id, error: err instanceof Error ? err.message : String(err),
    });
  }
}
