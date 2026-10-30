import { Prisma } from '@prisma/client';
import { jobsHoldingInvoice } from './job-invoice-holders';
import { queueReviewAttention } from '../services/notifications/reviewAttentionQueue';
import { decideCloseOutMove } from './job-close-out';
import { recordBackwardMove } from './job-back-out';
import { openReviewRound } from './job-review';
import { subStatusClears } from './job-sub-status';
import {
  canBeUnusual,
  invoiceIdsNamedBy,
  itemEventTypesOf,
  unusualChangeOf,
  unusualChangesOf,
  UNUSUAL_RELEVANT_EVENT_TYPES,
  type ReviewHistoryEntry,
  type UnusualChange,
} from './job-review-changeset';

/**
 * Ready to close goes back to Office review on an unusual change (Roles & Permissions, PRD 6, S06.20).
 *
 * A job in Ready to close has had its review finished: every item was checked. When an UNUSUAL change then lands on it, by
 * M8's own rule (a deleted file, a price cut, a customer detail change), nothing unusual may be closed unseen, so the job
 * goes back to Office review on the SAME round: the finished round is opened again with its checks and customer decisions,
 * the changed item reads unchecked (its latest history entry is newer than its check), everything else stays checked, and
 * ONE history entry names the change. An ordinary change (a payment, an invoice send, a note, an upload, a line added at its
 * price) does not move the job; the panel lists it under "Since the review".
 *
 * Where it runs. Every change M8 flags is written to the job's history by one of three writers (lib/job-change-history for
 * lines, scopes, discounts and the job's invoices, lib/record-contact-history for the job's own contact entries, and the
 * attachment delete), so each of them calls `returnToReviewOnUnusualChange` right after it writes its entry, on the client
 * of the transaction the change itself is in. Nothing is sprinkled into the handlers.
 *
 * The decision is M8's (`unusualChangeOf` folds the item the entry belongs to exactly as the panel does) and the move is
 * M7's (`return_to_review`); the re-opening of the round and the History entry are the backward move's own writes
 * (lib/job-back-out, door `unusual_change`), so there is one way of re-opening a round.
 *
 * Cost. An entry that can never make an item unusual (`canBeUnusual`) costs no query at all. Any other entry costs ONE
 * indexed read of the jobs it touches that are in Ready to close; a job in any other status stops there. Only a job that is
 * in Ready to close pays for the rest.
 *
 * Several jobs. An invoice can belong to more than one job (it was made from an estimate attached to another job, see
 * `jobsHoldingInvoice`), so a change on it reaches every one of them that is in Ready to close. The job the entry was written
 * on already holds it; each other job gets the same entry on its own history first, so its panel shows the item the history
 * line names. A job in Office review, Done or any other status is left alone here.
 *
 * Idempotent: the second unusual change in a row finds the job already in Office review and only the new item reads unchecked. Concurrent: the status write is guarded by the status it read (a Mark Done that got there first wins
 * and the job is left Done).
 *
 * Every query goes through `db`, the transaction's client, helpers included: the hosted pool has one connection.
 * No automation comes from here (this is not a Complete).
 *
 * The Office review attention alert (S06.24). The same writers are the places a NEW unusual item lands, so the alert hangs here:
 *  - a job in Ready to close that this function sends back raises it (the alert rides the move), every time it moves;
 *  - a job already in Office review raises it when the landing makes an item unusual that was not unusual before, so a
 *    second edit of an item that is already flagged is not a repeat;
 *  - a job in any other status, a change that is ordinary, and a re-read of the page raise none (a Done job's deletes and
 *    detail changes raise it from their own writers).
 * It is only QUEUED here (services/notifications/reviewAttentionQueue): the request sends it once the change has committed, never
 * from inside this transaction. Several items landed by one request are one alert. The reads it needs (the round, the item's
 * history) are the ones the move already makes, and a job in Office review makes them only for an entry that can be unusual.
 */

type Db = Pick<Prisma.TransactionClient, 'job' | 'jobReview' | 'timelineEvent'>;

/** The entry a writer just wrote on the job's history. */
export interface LandedChange {
  /** The history entry's own id, when the writer has it: the fold before the landing leaves it out to tell a new item from a repeat. */
  id?: string;
  event_type: string;
  description: string;
  metadata: Record<string, unknown>;
}

/** A job the change sent back to Office review. */
export interface ReturnedJob {
  job_id: string;
  job_number: string;
  review_id: string | null;
  change: UnusualChange;
}

const asHistory = (e: { id: string; event_type: string; description: string; metadata: unknown; created_at: Date }): ReviewHistoryEntry => ({
  id: e.id, event_type: e.event_type, description: e.description, metadata: e.metadata, created_at: e.created_at, actor_name: null,
});

/** The sentence on the job's history: the move, then what sent it back, in the panel's own words for it. */
const sentence = (jobNumber: string, change: UnusualChange) =>
  `Job ${jobNumber} moved back from Ready to close to Office review. ${change.reason}: ${change.title}.`;

/**
 * The items that are unusual in a job's window right now, by M8's own fold: what a job brings with it when it ENTERS Office review.
 * ONE read of the window's entries of the families that can hold an unusual item, whatever the job holds; no other query.
 */
export async function unusualItemsInWindow(
  db: Pick<Prisma.TransactionClient, 'timelineEvent'>,
  orgId: string,
  jobId: string,
  windowStart: Date,
): Promise<UnusualChange[]> {
  const entries = await db.timelineEvent.findMany({
    where: {
      organization_id: orgId,
      entity_type: 'JOB',
      entity_id: jobId,
      created_at: { gt: windowStart },
      event_type: { in: [...UNUSUAL_RELEVANT_EVENT_TYPES] },
    },
    select: { id: true, event_type: true, description: true, metadata: true, created_at: true },
  });
  return unusualChangesOf(entries.map(asHistory));
}

const queueAttention = (orgId: string, actorId: string | null, jobId: string, change: UnusualChange) =>
  queueReviewAttention({ orgId, actorId, jobId, onlyIfDone: false, items: [{ reason: change.reason, title: change.title, invoiceIds: change.invoice_ids }] });

export async function returnToReviewOnUnusualChange(
  db: Db,
  args: {
    orgId: string;
    actorId: string | null;
    /** The job whose history the entry was written on; null for an invoice with no job of its own (no entry was written). */
    jobId: string | null;
    change: LandedChange;
  },
): Promise<ReturnedJob[]> {
  const { orgId, actorId, jobId, change } = args;
  if (!canBeUnusual(change.event_type)) return [];

  const invoiceId = invoiceIdsNamedBy(change)[0];
  const reach: Prisma.JobWhereInput[] = [...(jobId ? [{ id: jobId }] : []), ...(invoiceId ? [jobsHoldingInvoice(invoiceId)] : [])];
  if (reach.length === 0) return [];
  const touched = await db.job.findMany({
    where: {
      organization_id: orgId,
      status: { in: ['OFFICE_REVIEW', 'READY_TO_CLOSE'] },
      OR: reach,
    },
    select: { id: true, job_number: true, created_at: true, status: true },
    orderBy: { id: 'asc' },
  });
  if (touched.length === 0) return [];

  const returned: ReturnedJob[] = [];
  for (const job of touched) {
    // A job in Office review is only asked about the entry written on its own history.
    if (job.status === 'OFFICE_REVIEW' && job.id !== jobId) continue;
    // Another job that holds the invoice has no entry of this change yet: it gets the same one, so its panel lists the item.
    if (job.id !== jobId) {
      await db.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: job.id,
          event_type: change.event_type,
          description: change.description,
          metadata: { ...change.metadata, ...(jobId ? { also_on_job_id: jobId } : {}) } as Prisma.InputJsonValue,
          created_by: actorId,
        },
      });
    }

    const round = await db.jobReview.findFirst({
      where: { organization_id: orgId, job_id: job.id },
      orderBy: { created_at: 'desc' },
      select: { window_start: true },
    });
    const windowStart = round?.window_start ?? job.created_at;
    const sameItem = await db.timelineEvent.findMany({
      where: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: job.id,
        created_at: { gt: windowStart },
        event_type: { in: itemEventTypesOf(change.event_type) },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { id: true, event_type: true, description: true, metadata: true, created_at: true },
    });
    // The panel judges the same fold of the same entries (the one just written is among them: it is in this transaction).
    const history = sameItem.map(asHistory);
    const landed = asHistory({ id: '', ...change, created_at: new Date() });
    const unusual = unusualChangeOf(history, landed);
    if (!unusual) continue;

    if (job.status === 'OFFICE_REVIEW') {
      // Already in review: nothing moves. Tell the office only when this landing made the item unusual (a first sight, not a repeat).
      const before = history.filter((e) => e.id !== change.id);
      if (change.id && unusualChangeOf(before, landed)) continue;
      queueAttention(orgId, actorId, job.id, unusual);
      continue;
    }

    const decision = decideCloseOutMove({ move: 'return_to_review', status: 'READY_TO_CLOSE', switches: {} });
    if (!decision.allowed) continue;
    // The status the job was read in is the status it is moved from: a Mark Done that got in first leaves nothing to move.
    const moved = await db.job.updateMany({
      where: { id: job.id, organization_id: orgId, status: 'READY_TO_CLOSE' },
      data: { status: decision.next, ...subStatusClears('READY_TO_CLOSE', decision.next) },
    });
    if (moved.count !== 1) continue;

    // A job moved to Ready to close by the one-time upgrade has no round: it gets one, whose window is the job's whole history.
    if (!round) await openReviewRound(db, { orgId, jobId: job.id, jobCreatedAt: job.created_at });
    const { review_id } = await recordBackwardMove(db, {
      orgId,
      jobId: job.id,
      jobNumber: job.job_number,
      actorId,
      from: 'READY_TO_CLOSE',
      to: decision.next,
      door: 'unusual_change',
      description: sentence(job.job_number, unusual),
      detail: {
        change_kind: unusual.kind, change_reason: unusual.reason, item_key: unusual.key, item_title: unusual.title, change_event_type: change.event_type,
        // The invoices the item is about: the History sentence names the item, and a reader who cannot open them is not given it.
        ...(unusual.invoice_ids.length ? { invoice_ids: unusual.invoice_ids } : {}),
      },
    });
    returned.push({ job_id: job.id, job_number: job.job_number, review_id, change: unusual });
    // The alert rides the move back to Office review.
    queueAttention(orgId, actorId, job.id, unusual);
  }

  return returned;
}
