/**
 * The texts a lead's or a job's Communication tab lists besides the ones tied to it (#3022, Q39).
 *
 * The tab lists every text tied to the record, at any time, plus the texts whose other number is one of the record's
 * numbers (those its contact card shows, `recordTabNumbers`) from the record's creation until it closes. The card is read as
 * it is now: a changed number counts, and so does the customer phone it replaced, which the card still shows as "Customer
 * record" (Ran, 2026-11-06).
 *
 * Closed (Ran, 2026-11-05): a lead when it is converted (Won) or lost; a job when it is Done or Cancelled. Completed, Office
 * review and Ready to close are still open. A closed record's window ends on the day it closed (`won_at`, `lost_at`,
 * `closed_at`, `cancelled_at`); one that closed before that day was recorded ends on its last update, as the Close Rate
 * reads it (lib/leadClosed.ts). An open record's window has no end.
 *
 * Only a conversation with a customer or with an unknown number counts: a conversation with a member of staff, a vendor or
 * a group is never a record's, whatever its number. The number match rides the messages' (organization, other party, time)
 * index (#3014); the caller adds the organization and the person's row filter, as for every other row of the tab.
 */
import type { Prisma } from '@prisma/client';
import { TERMINAL_LEAD_STATUSES } from '../../services/lead-stage.service';
import { DONE_OR_CANCELLED_JOB_STATUSES } from '../job-status-order';
import { recordTabNumbers, type TextAnchor } from './recordTextDestination';

/** The record's dates, and what `recordTabNumbers` reads the card with (the record's entries are read only there). */
type Db = Pick<Prisma.TransactionClient, 'lead' | 'job'> & Parameters<typeof recordTabNumbers>[0];

type Dated = { status: string; created_at: Date; updated_at: Date };

/** The day a closed record closed on, by its status; null while it is open. */
function closedOn(record: Dated, closeDates: Record<string, Date | null>, closed: readonly string[]): Date | null {
  if (!closed.includes(record.status)) return null;
  return closeDates[record.status] ?? record.updated_at;
}

/** When the record was made and when it closed (null while open); null for a record not in the company. */
async function recordSpan(db: Db, orgId: string, anchor: TextAnchor): Promise<{ from: Date; to: Date | null } | null> {
  const where = { id: anchor.id, organization_id: orgId };
  if (anchor.kind === 'lead') {
    const lead = await db.lead.findFirst({
      where, select: { status: true, created_at: true, updated_at: true, won_at: true, lost_at: true },
    });
    if (!lead) return null;
    return { from: lead.created_at, to: closedOn(lead, { WON: lead.won_at, LOST: lead.lost_at }, TERMINAL_LEAD_STATUSES) };
  }
  const job = await db.job.findFirst({
    where, select: { status: true, created_at: true, updated_at: true, closed_at: true, cancelled_at: true },
  });
  if (!job) return null;
  return { from: job.created_at, to: closedOn(job, { DONE: job.closed_at, CANCELLED: job.cancelled_at }, DONE_OR_CANCELLED_JOB_STATUSES) };
}

/** A conversation with a customer or an unknown number: not staff, vendor or group (kind is nullable on older rows). */
const CUSTOMER_CONVERSATION: Prisma.MessageThreadWhereInput = {
  OR: [{ kind: null }, { kind: 'customer' }],
  user_id: null,
  vendor_id: null,
};

/**
 * The record's text window: `texts`, the `where` for the texts the record's numbers bring onto its tab (without the
 * organization and the row filter, which the tab's read adds), and `numbers`, the record's numbers it matches (E.164). The
 * record's customer carries each of them, so they open the record's untied texts for a person who can open that customer or
 * holds Communication "All" (`recordNumbersOpenedForReq`, #3013 decision 4). Undefined when the record has no number. Three
 * reads, whatever the number of numbers or texts.
 */
export async function recordTextWindow(
  db: Db,
  orgId: string,
  anchor: TextAnchor,
): Promise<{ texts: Prisma.MessageWhereInput; numbers: string[] } | undefined> {
  const [span, numbers] = await Promise.all([recordSpan(db, orgId, anchor), recordTabNumbers(db, orgId, anchor)]);
  if (!span || numbers.length === 0) return undefined;
  return {
    texts: {
      other_party_e164: { in: numbers },
      ts: { gte: span.from, ...(span.to ? { lte: span.to } : {}) },
      thread: CUSTOMER_CONVERSATION,
    },
    numbers,
  };
}
