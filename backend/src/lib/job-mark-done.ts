import { Prisma, type JobStatus } from '@prisma/client';
import { prisma } from './prisma';
import { decideCloseOutMove, type CloseOutDecision, type CloseOutSwitches } from './job-close-out';
import { subStatusClears } from './job-sub-status';
import { lockJobInvoices, readJobMoneyOwed } from './job-money-owed';
import { fromCents, toCents } from './payment-ledger';

/**
 * Mark Done (Roles & Permissions, PRD 6, S06.13): the move from Ready to close to Done, stamping when and by whom, in ONE
 * transaction.
 *
 * The transaction first takes the job's row, so two people marking Done at once are served one after the other: the
 * second finds the job already Done and is refused. A job that is not in Ready to close is refused there, before any
 * money is read. Then it takes the job's invoices (every money writer locks its invoice first) and reads the money owed
 * INSIDE the transaction, so a payment landing between the page's read and this write can neither slip a job with money
 * owed past the rule nor be missed: it either lands before the read, and the amount the person confirmed no longer
 * matches and the move is refused with the new amount, or it waits for the commit. Only then does M7
 * (`decideCloseOutMove`) decide, and only then is anything written.
 *
 * Writes: the job's status, who closed it and when, and the history entry. Nothing here fires an automation or an alert:
 * the job-completed trigger fired once, at Complete, and the alerts around Done belong to the notification chain.
 */

/** The history entry on the job when it is marked Done. */
export const JOB_MARKED_DONE_EVENT = 'JOB_MARKED_DONE';

/** The machine-readable codes the screen reads to know why a Mark Done was refused (a status refusal uses JOB_CLOSE_OUT_REFUSED). */
export const JOB_MONEY_OWED = 'JOB_MONEY_OWED';
export const MARK_DONE_AMOUNT = 'MARK_DONE_AMOUNT';

/**
 * A Mark Done that M7 (or the state of the job) refused. Thrown inside the transaction so nothing is left behind.
 * `owedCents` is what the transaction found owed, when it got as far as reading it, so the screen can show the new amount.
 */
export class MarkDoneRefusal extends Error {
  constructor(readonly refusal: Extract<CloseOutDecision, { allowed: false }>, readonly owedCents?: number) {
    super(refusal.reason);
  }
}

export interface MarkDoneArgs {
  orgId: string;
  jobId: string;
  actor: { id: string; name: string };
  /** The person's own switch values for the move, answered by the route for this job. */
  switches: Pick<CloseOutSwitches, 'close_jobs' | 'close_jobs_with_money_owed'>;
  /** The amount (dollars) the person confirmed, null when they were not asked. */
  confirmedAmount: number | null;
}

export interface MarkDoneResult {
  status: 'DONE';
  job_number: string;
  closed_at: Date;
  /** What was still owed when the job was marked Done, in dollars; 0 when nothing was. */
  owed_amount: number;
}

const dollars = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

export async function markJobDone(args: MarkDoneArgs): Promise<MarkDoneResult> {
  const { orgId, jobId, actor, switches } = args;
  const confirmedCents = args.confirmedAmount === null ? null : toCents(args.confirmedAmount);
  return prisma.$transaction(async (tx) => {
    // Take the job's row: a second closer waits here, then finds the job already Done.
    const [locked] = await tx.$queryRaw<{ status: JobStatus; job_number: string }[]>(
      Prisma.sql`SELECT status::text AS status, job_number FROM jobs WHERE id = ${jobId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`,
    );
    if (!locked) throw new MarkDoneRefusal({ allowed: false, kind: 'status', reason: 'Job not found' });

    // Where the job stands is answered before any money is read or any invoice is locked.
    const standing = decideCloseOutMove({ move: 'mark_done', status: locked.status, switches });
    if (!standing.allowed && (standing.kind === 'forbidden' || standing.kind === 'status')) throw new MarkDoneRefusal(standing);

    await lockJobInvoices(tx, orgId, jobId);
    const { owedCents } = await readJobMoneyOwed({ orgId, jobId, db: tx });
    const decision = decideCloseOutMove({ move: 'mark_done', status: locked.status, switches, markDone: { owedCents, confirmedCents } });
    if (!decision.allowed) throw new MarkDoneRefusal(decision, owedCents);

    const closedAt = new Date();
    const moved = await tx.job.updateMany({
      where: { id: jobId, organization_id: orgId, status: 'READY_TO_CLOSE' },
      data: { status: decision.next, closed_at: closedAt, closed_by_id: actor.id, ...subStatusClears('READY_TO_CLOSE', decision.next) },
    });
    // The row is held, so it must have matched; anything else rolls the whole move back.
    if (moved.count !== 1) throw new MarkDoneRefusal({ allowed: false, kind: 'status', reason: 'This job is already Done.' });

    const owed = fromCents(owedCents);
    await tx.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: jobId,
        event_type: JOB_MARKED_DONE_EVENT,
        description: owedCents > 0
          ? `Job ${locked.job_number} marked Done with ${dollars(owed)} still owed`
          : `Job ${locked.job_number} marked Done`,
        metadata: { from: 'READY_TO_CLOSE', to: decision.next, owed_amount: owed, closed_by_name: actor.name },
        created_by: actor.id,
        created_at: closedAt,
      },
    });

    return { status: 'DONE' as const, job_number: locked.job_number, closed_at: closedAt, owed_amount: owed };
  });
}
