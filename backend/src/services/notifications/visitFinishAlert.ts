/**
 * visitFinishAlert.ts - the one place the visit-finish alert is sent from (Roles & Permissions, PRD 4, S04.16).
 *
 * After a visit is committed as finished, one bell alert goes out through M6's two lanes (alertChain.ts): the job's
 * Sold By, crew and Dispatcher; whoever must act next (the Dispatcher, else the Complete jobs holders, else the Manage
 * roles and permissions holders); and a copy to the Alert me about every job holders. The alert that leaves no live
 * visit unfinished says the job is ready to complete. In-app only.
 *
 * Fire-and-forget: a failure here is logged and never reaches the finish that already landed.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { jobCrewIds } from '../../lib/job-crew';
import { twoLaneRecipients } from './alertChain';
import { emit } from './notificationService';

export async function alertVisitFinished(args: {
  organizationId: string;
  /** The person who tapped. */
  actor: { id: string; first_name: string };
  jobId: string;
  visitId: string;
  /** The instant the visit was finished; it keys the alert, so a repeated request cannot send it twice. */
  at: Date;
}): Promise<void> {
  try {
    const job = await prisma.job.findFirst({
      where: { id: args.jobId, organization_id: args.organizationId },
      select: {
        job_number: true, salesperson_id: true, dispatcher_id: true,
        visits: { select: { id: true, visit_seq: true, status: true, assignees: { select: { user_id: true } } } },
      },
    });
    const finished = job?.visits.find((v) => v.id === args.visitId);
    if (!job || !finished) return;

    const people = await twoLaneRecipients({
      organizationId: args.organizationId,
      record: { type: 'JOB', id: args.jobId },
      actorId: args.actor.id,
      recordPeople: [...(job.salesperson_id ? [job.salesperson_id] : []), ...jobCrewIds(job)],
      dispatcherId: job.dispatcher_id,
      stepSwitch: 'complete_jobs',
      copySwitch: 'alert_every_job',
      words: { record: 'job', step: 'complete jobs', alert: 'visit finish alert' },
    });

    // A cancelled visit is not live, and the visit just finished is not open any more.
    const stillOpen = job.visits.some((v) => v.id !== args.visitId && v.status !== 'COMPLETED' && v.status !== 'CANCELLED');

    await emit({
      verb: 'job.visit_finished',
      organizationId: args.organizationId,
      actorId: args.actor.id,
      object: { type: 'JOB', id: args.jobId, label: job.job_number },
      entity: {
        lane_one_ids: people.laneOne,
        lane_two_ids: people.laneTwo,
        copy_ids: people.copies,
        all_finished: !stillOpen,
      },
      data: {
        object_label: job.job_number,
        visit_seq: String(finished.visit_seq),
        actor_name: args.actor.first_name,
        all_finished: !stillOpen,
        fallback_reason: people.fallbackReason ?? '',
      },
      dedupKey: `job.visit_finished:${args.visitId}:${args.at.getTime()}`,
    });
  } catch (err) {
    logger.warn('[visitFinishAlert] could not send the visit finish alert', {
      jobId: args.jobId, visitId: args.visitId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
