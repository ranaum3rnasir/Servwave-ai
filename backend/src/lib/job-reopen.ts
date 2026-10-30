import { Prisma, type JobStatus } from '@prisma/client';
import { prisma } from './prisma';
import { decideCloseOutMove, type CloseOutDecision, type CloseOutSwitches } from './job-close-out';
import { subStatusClears } from './job-sub-status';
import { syncJobFromVisits } from '../services/walkthrough.service';

/**
 * Reopen (Roles & Permissions, PRD 6, S06.16): the move from Done or Cancelled back to In Progress, in ONE transaction
 * and on the transaction's own client for every query, so the hosted database's one-connection pool never waits on a
 * second connection.
 *
 * The transaction first takes the job's row, so two people reopening at once are served one after the other: the second
 * finds the job already In Progress and is refused. Then M7 (`decideCloseOutMove`) decides from the status it finds
 * there, and only then is anything written.
 *
 * Writes: the status, and the stamps that went with the closed state. From Done that is the completed stamp and the Done
 * stamps (when and by whom); from Cancelled the cancel stamp, the reason code and its note. It touches nothing else: it
 * does not un-void an invoice, re-book a visit or return stock, and it leaves an open review round as it is (a finished
 * round is history; the next Complete opens a new one that starts at its finish). Nothing here fires an automation: the
 * job-completed trigger fires at each Complete, and the alert for a reopened job is the caller's.
 */

/** The history entry on the job when it is reopened. */
export const JOB_REOPENED_EVENT = 'JOB_REOPENED';

/** A Reopen that M7 (or the state of the job) refused. Thrown inside the transaction so nothing is left behind. */
export class ReopenRefusal extends Error {
  constructor(readonly refusal: Extract<CloseOutDecision, { allowed: false }>) {
    super(refusal.reason);
  }
}

export interface ReopenArgs {
  orgId: string;
  jobId: string;
  actorId: string;
  /** The person's own value for Reopen Done jobs, answered by the route for this job. */
  switches: Pick<CloseOutSwitches, 'reopen_done_jobs'>;
}

export interface ReopenResult {
  job_number: string;
  /** The status the job was reopened from. */
  from: JobStatus;
}

export async function reopenJob(args: ReopenArgs): Promise<ReopenResult> {
  const { orgId, jobId, actorId, switches } = args;
  return prisma.$transaction(async (tx) => {
    // Take the job's row: a second reopener waits here, then finds the job already In Progress.
    const [locked] = await tx.$queryRaw<{ status: JobStatus; job_number: string; source_plan_id: string | null }[]>(
      Prisma.sql`SELECT status::text AS status, job_number, source_plan_id FROM jobs WHERE id = ${jobId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`,
    );
    if (!locked) throw new ReopenRefusal({ allowed: false, kind: 'status', reason: 'Job not found' });

    const decision = decideCloseOutMove({ move: 'reopen', status: locked.status, switches });
    if (!decision.allowed) throw new ReopenRefusal(decision);

    // The evidence of the closed state goes with it. Leaving a stamp set produced a job reading In Progress while still
    // carrying a cancellation record, which every report keyed on cancelled_at counted as cancelled.
    await tx.job.update({
      where: { id: jobId },
      data: {
        status: decision.next,
        ...subStatusClears(locked.status, decision.next),
        completed_at: null,
        closed_at: null,
        closed_by_id: null,
        cancelled_at: null,
        cancelled_reason: null,
        cancel_reason_code: null,
      },
      select: { id: true },
    });

    // The window has to be re-derived off the visit set, or the mirror keeps pointing at a trip that is still CANCELLED.
    // `deriveStatus: false` because this is the human deciding the status: re-deriving would answer UNSCHEDULED off an
    // all-cancelled visit set and immediately undo the reopen.
    await syncJobFromVisits(tx, { jobId, orgId, deriveStatus: false });

    // Reopening CLEARS completion, so the linked service-plan visit has to come back with it, or the plan's
    // visits_remaining stays decremented for a job that is open again.
    if (locked.source_plan_id) {
      await tx.planVisit.updateMany({
        where: { job_id: jobId, organization_id: orgId, status: 'COMPLETED' },
        data: { status: 'SCHEDULED', completed_at: null },
      });
    }

    await tx.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: jobId,
        event_type: JOB_REOPENED_EVENT,
        description: `Job ${locked.job_number} reopened`,
        metadata: { from: locked.status, to: decision.next },
        created_by: actorId,
      },
    });

    return { job_number: locked.job_number, from: locked.status };
  });
}
