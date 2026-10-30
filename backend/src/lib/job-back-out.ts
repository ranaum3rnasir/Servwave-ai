import { Prisma, type JobStatus } from '@prisma/client';

/**
 * The records of a backward move out of Office review or Ready to close (Roles & Permissions, PRD 6, S06.18).
 *
 * M7 (`statusDoorAnswer`) decides whether the move is allowed; the doors (the status door, the calendar drag and reschedule,
 * unschedule, job-level Start) write the job's status and the stamps their own way. What every one of them owes the same
 * way is here, and it runs on the TRANSACTION's client for every query, so the hosted database's one-connection pool never
 * waits on a second connection:
 *
 *  - `lockForBackwardMove` takes the job's row first and checks the job is still where the door read it, so two people
 *    moving the same job at once are served one after the other and a job that was finished or sent back in between is
 *    refused instead of written over;
 *  - `recordBackwardMove` keeps the review round and its checks and customer decisions, writes the ONE history entry for the
 *    move (the door's own milestone entry is not written for a backward move), and nothing else. No alert and no automation
 *    comes from here (the Office review attention alert that rides the `unusual_change` move is queued by lib/job-review-return
 *    and sent after the request commits); the job-completed automation fires at each Complete, so a job sent back and completed again fires it
 *    again exactly once.
 *
 * The lock lifts with the status (it follows the status; nothing is edited for it), and the next Complete finds the open
 * round and returns the job to Office review on it (`openReviewRound` reuses an open round).
 *
 * From Ready to close the round was already finished (Finish review marks it so). A backward move re-opens that round: it is
 * the round the job comes back to, with every check and customer decision it holds. A decision already applied to the
 * customer stays applied (the customer's data is not rewound), and finishing the round again skips it.
 */

/** The history entry on the job when it is moved back out of Office review or Ready to close. */
export const JOB_MOVED_BACK_EVENT = 'JOB_MOVED_BACK';

/** The refusal when the job changed under the person between the moment the door read it and the write. */
export const BACK_OUT_RACED_MESSAGE = 'This job just changed. Check where it stands and try again.';

/** A backward move that found the job somewhere else than the door read it. Thrown inside the transaction so nothing is left behind. */
export class BackwardMoveRaced extends Error {
  constructor() {
    super(BACK_OUT_RACED_MESSAGE);
  }
}

const STATUS_WORDS: Partial<Record<JobStatus, string>> = {
  OFFICE_REVIEW: 'Office review',
  READY_TO_CLOSE: 'Ready to close',
  UNSCHEDULED: 'Unscheduled',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In Progress',
};

const words = (status: JobStatus) => STATUS_WORDS[status] ?? status;

/**
 * The door a backward move came through, as the history entry names it. `unusual_change` is not a door a person opens: it is
 * the move a Ready to close job makes back to Office review when an unusual change lands on it (S06.20, lib/job-review-return),
 * the same re-opening of the same round with a different cause.
 */
export type BackOutDoorName = 'start' | 'schedule' | 'unschedule' | 'unusual_change';

/**
 * Take the job's row and check it is still in the status the door read. Run it first in the transaction, before any write.
 * Returns the job's number for the history entry.
 */
export async function lockForBackwardMove(
  tx: Prisma.TransactionClient,
  args: { orgId: string; jobId: string; from: JobStatus },
): Promise<{ job_number: string }> {
  const [locked] = await tx.$queryRaw<{ status: JobStatus; job_number: string }[]>(
    Prisma.sql`SELECT status::text AS status, job_number FROM jobs WHERE id = ${args.jobId}::uuid AND organization_id = ${args.orgId}::uuid FOR UPDATE`,
  );
  if (!locked || locked.status !== args.from) throw new BackwardMoveRaced();
  return { job_number: locked.job_number };
}

/**
 * Keep the round and write the history entry. Run it in the same transaction as the job's status write, after it.
 * `detail` is what the door adds to the entry's metadata (the window it moved, for a reschedule).
 */
export async function recordBackwardMove(
  tx: Pick<Prisma.TransactionClient, 'jobReview' | 'timelineEvent'>,
  args: {
    orgId: string;
    jobId: string;
    jobNumber: string;
    /** Who made the move; null when nobody signed in made the change that caused it. */
    actorId: string | null;
    from: JobStatus;
    to: JobStatus;
    door: BackOutDoorName;
    detail?: Record<string, unknown>;
    /** The entry's sentence when the move has a cause worth naming (the change that sent the job back); else the plain "moved back from X to Y". */
    description?: string;
  },
): Promise<{ review_id: string | null }> {
  const { orgId, jobId, from } = args;
  let reviewId: string | null = null;

  const open = await tx.jobReview.findFirst({
    where: { organization_id: orgId, job_id: jobId, state: 'OPEN' },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  });
  if (open) {
    reviewId = open.id;
  } else if (from === 'READY_TO_CLOSE') {
    // The round Finish review closed is the one the job returns to: open it again, checks and decisions untouched.
    const finished = await tx.jobReview.findFirst({
      where: { organization_id: orgId, job_id: jobId, state: 'FINISHED', finished_at: { not: null } },
      orderBy: { finished_at: 'desc' },
      select: { id: true },
    });
    if (finished) {
      await tx.jobReview.updateMany({
        where: { id: finished.id, organization_id: orgId, state: 'FINISHED' },
        data: { state: 'OPEN', finished_by_id: null, finished_at: null },
      });
      reviewId = finished.id;
    }
  }

  await tx.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: 'JOB',
      entity_id: jobId,
      event_type: JOB_MOVED_BACK_EVENT,
      description: args.description ?? `Job ${args.jobNumber} moved back from ${words(from)} to ${words(args.to)}`,
      metadata: { from, to: args.to, door: args.door, review_id: reviewId, ...(args.detail ?? {}) } as Prisma.InputJsonValue,
      created_by: args.actorId,
    },
  });

  return { review_id: reviewId };
}

// ─── Reading the entry back ─────────────────────────────────────────────────

/** Stands in for an invoice an old entry names but cannot be traced to: it opens for nobody, and is never asked about. */
export const UNKNOWN_INVOICE = 'unknown-invoice';

/**
 * The invoices the item that sent a job back is about. New entries carry them (`invoice_ids`); an entry written before that
 * names its invoice only in the item's key ("invoice-line:<invoice>:<line>", "invoice-discount:<invoice>") or, for a file on an
 * invoice, in its title ("Invoice 123 file: ..."). That last one cannot be traced to an invoice id, so it counts as an invoice
 * nobody can open (the item is left out for everyone, which is the safe side).
 */
export function invoiceIdsOfMovedBack(metadata: unknown): string[] {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  if (Array.isArray(m.invoice_ids)) return m.invoice_ids.filter((id): id is string => typeof id === 'string');
  const key = typeof m.item_key === 'string' ? m.item_key : '';
  const fromKey = /^invoice-(?:line|discount):([^:]+)/.exec(key)?.[1];
  if (fromKey) return [fromKey];
  return typeof m.item_title === 'string' && m.item_title.startsWith('Invoice ') ? [UNKNOWN_INVOICE] : [];
}

/**
 * The job's history, for a reader who may not open every invoice. The entry of a job sent back to Office review by an unusual
 * change names the item ("... moved back from Ready to close to Office review. A price was lowered: Invoice 123 line:
 * Door.") and keeps its key and title. When the item is about an invoice the reader cannot open, the reader gets the move
 * without the item, the same rule the review panel applies to the item itself.
 */
export function withoutInvoiceItems<T extends { event_type: string; description: string; metadata?: unknown }>(
  events: T[],
  openable: ReadonlySet<string>,
): T[] {
  return events.map((ev) => {
    if (ev.event_type !== JOB_MOVED_BACK_EVENT) return ev;
    const ids = invoiceIdsOfMovedBack(ev.metadata);
    if (ids.every((id) => openable.has(id))) return ev;
    const { door, from, to, review_id } = (ev.metadata ?? {}) as Record<string, unknown>;
    return { ...ev, description: ev.description.split('. ')[0]!, metadata: { door, from, to, review_id } };
  });
}
