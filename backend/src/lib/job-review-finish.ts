import { Prisma, type JobStatus } from '@prisma/client';
import { prisma } from './prisma';
import { readJobReview, type ReadReviewArgs } from './job-review-reader';
import { changeItems, itemsLeft, type ReviewItem } from './job-review-changeset';
import { decideCloseOutMove, type CloseOutDecision } from './job-close-out';
import { subStatusClears } from './job-sub-status';
import { findLiveJobEntry } from './record-contact-entries';
import { applyDecisionToCustomer, CONTACT_LABEL, OUTCOME, shown, type AppliedDecision, type Outcome } from './job-review-apply';

/**
 * Finish review (Roles & Permissions, PRD 6, S06.12): the move from Office review to Ready to close, and the customer
 * decisions it applies, in ONE transaction. A failure at any step applies nothing.
 *
 * The transaction first takes the job's row, so two people finishing at once are served one after the other: the second
 * finds the job already in Ready to close and is refused. Then it reads the review again, inside the transaction, and
 * asks M7 (`decideCloseOutMove`) whether the move is allowed: the job is in Office review, the version the client sent is
 * still the review's version, and no item is left unchecked. Only then is anything written.
 *
 * Writes, in order: each customer decision is applied to the customer (the job's contact entries are never changed),
 * and each writes a history entry on the job and, when the customer changed, one on the customer; the round is marked
 * finished with who and when; the job moves to Ready to close; the Ready to close entry is written last.
 *
 * Nothing here fires an automation or an alert: the job-completed trigger fired once, at Complete. The Ready to close alert
 * (S06.24) is sent by the finish route once this transaction has committed (services/notifications/jobReviewAlerts), never from here.
 */

export const REVIEW_NOT_OPEN_MESSAGE = 'This job has no open review.';

/** The history entry on the job when its review is finished. */
export const OFFICE_REVIEW_FINISHED_EVENT = 'OFFICE_REVIEW_FINISHED';
/** The history entry on the job for each customer decision applied. */
export const CUSTOMER_DECISION_APPLIED_EVENT = 'JOB_CUSTOMER_DECISION_APPLIED';

/** A finish M7 (or the state of the review) refused. Thrown inside the transaction so nothing is left behind. */
export class FinishRefusal extends Error {
  constructor(readonly refusal: Extract<CloseOutDecision, { allowed: false }>) {
    super(refusal.reason);
  }
}

export interface FinishReviewArgs {
  orgId: string;
  jobId: string;
  actor: { id: string; name: string };
  /** The version the client loaded; null when it sent none. */
  sentVersion: string | null;
  mayCosts: boolean;
  openInvoices: ReadReviewArgs['openInvoices'];
}

export interface FinishReviewResult {
  status: 'READY_TO_CLOSE';
  /** The customer columns and lists the decisions wrote, for the audit trail; empty when the customer was left alone. */
  customer_id: string;
  customer_fields: string[];
  job_number: string;
}

const REFUSAL_FOR_MISSING_ROUND: Extract<CloseOutDecision, { allowed: false }> = { allowed: false, kind: 'status', reason: REVIEW_NOT_OPEN_MESSAGE };

/** What a decision's outcome reads like on the job, after the value ("Phone (555) 222-3333 ..."). */
function jobWords(outcome: Outcome, kind: string, old: string | null): string {
  switch (outcome) {
    case OUTCOME.ADDED: return 'added to the customer';
    case OUTCOME.REPLACED: return `replaced ${shown(kind, old)} on the customer`;
    case OUTCOME.ADDED_INSTEAD: return `added to the customer instead, because the ${shown(kind, old)} it was changed from is no longer on the customer`;
    case OUTCOME.ALREADY_ON_CUSTOMER: return 'already on the customer, so nothing was added';
    default: return 'kept for this job only';
  }
}

/** What the same outcome reads like on the customer's own history. */
function customerWords(applied: AppliedDecision, kind: string): string {
  const label = CONTACT_LABEL[kind] ?? 'Detail';
  const value = shown(kind, applied.new);
  switch (applied.outcome) {
    case OUTCOME.ADDED: return `${label} ${value} added`;
    case OUTCOME.REPLACED: return applied.old ? `${label} ${shown(kind, applied.old)} replaced by ${value}` : `${label} set to ${value}`;
    default: return `${label} ${value} added; the ${shown(kind, applied.old)} it was changed from is no longer on this customer`;
  }
}

export async function finishReview(args: FinishReviewArgs): Promise<FinishReviewResult> {
  const { orgId, jobId, actor, sentVersion } = args;
  return prisma.$transaction(async (tx) => {
    // Take the job's row: a second finisher waits here, then finds the review already finished.
    const [locked] = await tx.$queryRaw<{ status: JobStatus; customer_id: string; job_number: string }[]>(
      Prisma.sql`SELECT status::text AS status, customer_id, job_number FROM jobs WHERE id = ${jobId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`,
    );
    if (!locked) throw new FinishRefusal({ allowed: false, kind: 'status', reason: 'Job not found' });

    // Where the job stands is answered before the review is even read (a job that was never in review has none).
    const standing = decideCloseOutMove({ move: 'finish_review', status: locked.status, switches: { office_review: true } });
    if (!standing.allowed && standing.kind === 'status') throw new FinishRefusal(standing);

    const review = await readJobReview({ orgId, jobId, mayCosts: args.mayCosts, openInvoices: args.openInvoices, db: tx });
    if (!review?.round || review.round.state !== 'OPEN') throw new FinishRefusal(REFUSAL_FOR_MISSING_ROUND);

    const decision = decideCloseOutMove({
      move: 'finish_review',
      status: locked.status,
      switches: { office_review: true },
      review: { version: review.version, sentVersion, left: itemsLeft(review) },
    });
    if (!decision.allowed) throw new FinishRefusal(decision);

    // Every history entry gets its own millisecond, so the history reads in the order things were applied.
    const began = Date.now();
    let tick = 0;
    const stamp = () => new Date(began + tick++);
    const finishedAt = new Date(began);
    const customerFields = new Set<string>();

    // A round that was sent back from Ready to close (S06.18) comes here again with the decisions it already applied: the
    // customer holds those, so they are not applied a second time. A decision changed since has `applied` false again.
    const alreadyApplied = new Set(
      (await tx.jobReviewCustomerDecision.findMany({ where: { organization_id: orgId, review_id: review.round.id, applied: true }, select: { entry_id: true } })).map((d) => d.entry_id),
    );

    for (const item of changeItems(review).filter((i): i is ReviewItem & { contact: NonNullable<ReviewItem['contact']> } => i.contact !== undefined)) {
      const { contact } = item;
      // An entry taken off the job before the review has no choice and applies nothing, whatever an earlier tick chose.
      if (contact.removed || !contact.choice || alreadyApplied.has(contact.entry_id)) continue;
      const entry = await findLiveJobEntry(tx, orgId, jobId, contact.entry_id);
      if (!entry) continue;

      const applied = await applyDecisionToCustomer(tx, { orgId, customerId: locked.customer_id, choice: contact.choice, entry });
      const label = CONTACT_LABEL[entry.kind] ?? 'Detail';
      const by = item.checked_by ?? 'the reviewer';
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: jobId,
          event_type: CUSTOMER_DECISION_APPLIED_EVENT,
          description: `${label} ${shown(entry.kind, entry.value)} ${jobWords(applied.outcome, entry.kind, applied.old)} (decided by ${by})`,
          metadata: {
            entry_id: entry.id, kind: entry.kind, choice: contact.choice, outcome: applied.outcome, old: applied.old, new: applied.new,
            decided_by_name: item.checked_by, decided_at: item.checked_at, review_id: review.round.id,
          },
          created_by: actor.id,
          created_at: stamp(),
        },
      });
      if (applied.fields.length > 0) {
        applied.fields.forEach((f) => customerFields.add(f));
        // The customer's own history, in the shape the customer page writes (CUSTOMER_UPDATED with the fields), plus the values.
        await tx.timelineEvent.create({
          data: {
            organization_id: orgId,
            entity_type: 'CUSTOMER',
            entity_id: locked.customer_id,
            event_type: 'CUSTOMER_UPDATED',
            description: `${customerWords(applied, entry.kind)} from job ${locked.job_number}, confirmed by ${actor.name} in office review`,
            metadata: {
              fields: applied.fields, via: 'office_review', job_id: jobId, job_number: locked.job_number, review_id: review.round.id,
              reviewed_by_id: actor.id, reviewed_by_name: actor.name, decided_by_name: item.checked_by,
              changes: [{ kind: entry.kind, outcome: applied.outcome, old: applied.old, new: applied.new }],
            },
            created_by: actor.id,
            created_at: stamp(),
          },
        });
      }
    }

    // Every decision of the round has now been dealt with, an entry removed before the review included (it applied nothing).
    await tx.jobReviewCustomerDecision.updateMany({
      where: { organization_id: orgId, review_id: review.round.id, applied: false },
      data: { applied: true, applied_at: finishedAt },
    });

    const round = await tx.jobReview.updateMany({
      where: { id: review.round.id, organization_id: orgId, state: 'OPEN' },
      data: { state: 'FINISHED', finished_by_id: actor.id, finished_at: finishedAt },
    });
    const moved = await tx.job.updateMany({
      where: { id: jobId, organization_id: orgId, status: 'OFFICE_REVIEW' },
      data: { status: decision.next, ...subStatusClears('OFFICE_REVIEW', decision.next) },
    });
    // The row is held, so both must have matched; anything else rolls the whole finish back.
    if (round.count !== 1 || moved.count !== 1) throw new FinishRefusal({ allowed: false, kind: 'status', reason: 'This review has already been finished.' });

    await tx.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: jobId,
        event_type: OFFICE_REVIEW_FINISHED_EVENT,
        description: `Job ${locked.job_number} moved to Ready to close`,
        metadata: { from: 'OFFICE_REVIEW', to: decision.next, review_id: review.round.id },
        created_by: actor.id,
        created_at: stamp(),
      },
    });

    return { status: 'READY_TO_CLOSE' as const, customer_id: locked.customer_id, customer_fields: [...customerFields], job_number: locked.job_number };
  });
}
