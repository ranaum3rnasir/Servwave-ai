/**
 * lead-contact.service.ts — the one rule that decides whether an outbound message counts as
 * "somebody reached out to this lead".
 *
 * Spec: GitHub issue #1751 ("Lead stage clocks"), decision D5.
 *
 * THE RULE, in the business owner's words: an outbound CALL, an outbound TEXT, or a HUMAN-WRITTEN
 * EMAIL marks the lead contacted, at the moment it happened. Automatic notifications the platform
 * sends on the company's behalf NEVER count — the response-time metric measures the owner's people,
 * not their software (user stories 12 and 13). An INBOUND call or text from the customer does not
 * mark the lead contacted by us either: the metric is our effort, not theirs (user story 15).
 * First qualifying event wins; a fifth follow-up does not keep resetting the clock (story 14).
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * Three unrelated controllers write the three channels, and the rule has to be identical in all
 * three or the metric is unreportable. The specific way it goes wrong is silent: a channel whose
 * filter is subtly wrong does not fail, it just reports a fleet of leads as contacted the instant
 * they were created, which reads as excellent response time. Nothing on any screen shows it.
 *
 * PROVENANCE IS READ, NEVER INFERRED
 *
 * Each channel states its provenance outright and this module reads it:
 *
 *   TEXT   `messages.automated`, which already existed — the automation SMS writer
 *          (services/automations/smsRecord.ts) sets it true, the composer sets it false.
 *   EMAIL  `emails.automated`, added by this spec. `persistTransactionalEmail` (every
 *          estimate/invoice/PO notice) writes true; the compose/reply door writes false.
 *   CALL   nothing to read: every outbound call in the product today is a person pressing dial.
 *          There is no automated dialer, so there is no flag, and inventing a column with one
 *          possible value would be a worse lie than the absence. WHOEVER BUILDS AN AUTODIALER OR A
 *          POWER DIALER MUST ADD THE FLAG AND PASS IT HERE — the call site names `automated`
 *          explicitly for exactly that reason, rather than letting the default carry it.
 *
 * The email channel had a tempting structural proxy and it is REJECTED, not merely unused:
 * transactional mirrors happen to be written with no `thread_id` while the compose path always
 * populates one. That is a consequence of which code path writes the row — documented as such on
 * `Email.thread_id` in schema.prisma — not a contract. `persistTransactionalEmail` already ACCEPTS
 * a `threadId`, so the first sender to pass one would silently mark every lead in the system
 * contacted, with no failure anywhere to notice it by.
 *
 * NEVER FAILS THE USER'S SEND
 *
 * Deep module, same discipline as lib/comm-persist.ts's `persistTransactionalEmail`: the message
 * has already left, so a bookkeeping failure must not turn a send that plainly happened into a 500.
 * It is nonetheless AWAITED at every call site and logs at error level — a swallowed failure that
 * also went unlogged would be the fire-and-forget shape that fakes a green result.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import {
  LEAD_STATUS_LABEL,
  stampLeadClock,
  transitionLeadStatus,
  type LeadTransitionResult,
} from './lead-stage.service';

/**
 * Where the service runs its writes, STATED by the caller rather than sniffed (#2618).
 *
 *   `{ tx }`      the caller already holds a transaction: the clock stamp and the status move run
 *                 inside it and commit or roll back with the caller's own writes.
 *   `{ client }`  the caller holds the plain client: the stamp and the move run in ONE transaction
 *                 of their own, so a lead can never be left stamped-but-New by a half-done write.
 *
 * Why a tag and not a `typeof db.$transaction === 'function'` test: that test reads a property
 * Prisma happens to hide on an interactive-transaction client, and any wrapper or test double that
 * exposes one (the manual-log tx double does, to refuse nesting) would flip it into opening a
 * nested transaction, which Prisma rejects - the error would be swallowed below and the contact
 * silently lost. The tag is checked by the compiler in the direction that matters:
 * `{ client: tx }` does not type-check (a TransactionClient has no `$transaction`). `{ tx: prisma }`
 * does type-check but is WRONG: the `{ tx }` path opens a SAVEPOINT, which Postgres refuses outside
 * a transaction block, so the contact would be logged as failed and not recorded. Hand the plain
 * client over as `{ client }`.
 */
export type LeadContactDb =
  | { tx: Prisma.TransactionClient }
  | { client: PrismaClient };

export type LeadContactChannel = 'call' | 'text' | 'email';

export interface LeadOutboundTouch {
  /**
   * The lead this message is attributed to. Null/undefined on the overwhelming majority of sends
   * (a text to a customer about a job is not lead outreach) and handled as a no-op rather than a
   * caller-side `if` repeated three times.
   *
   * It must already be org-scoped by the caller. Every door that passes one resolved it under
   * `tenantWhere(req)` or through the org-scoped phone matcher.
   */
  leadId: string | null | undefined;
  /** The org the message was written in. Required by `stampLeadClock` — see its own note. */
  orgId: string;
  channel: LeadContactChannel;
  /**
   * The canonical comm vocabulary is `'in' | 'out'` — never `inbound`/`outbound`. Typed as a bare
   * string because that is what the three models store (`Message.direction`, `Email.direction`,
   * `CallSession.direction` are all `String`), and narrowing it here would only move the cast.
   */
  direction: string | null | undefined;
  /**
   * True when the platform generated this message on the company's behalf. Falsy — including the
   * null that historical rows carry — reads as human, matching the column defaults on both
   * `messages.automated` and `emails.automated`.
   */
  automated?: boolean | null;
  /** When the outreach happened. The row's own instant, never `new Date()` re-read downstream. */
  at: Date;
  /**
   * The user who reached out, when the channel knows it (#2618): written as the actor of the
   * New -> Contacted History row. Null/undefined for a contact with no known user (a phone-system
   * text sent from the vendor console), which records the move as a system move.
   */
  actorId?: string | null;
}

/**
 * Does this message count as us reaching out? Pure, and exported so a test can state the rule
 * as an invariant rather than re-deriving it from three separate doors.
 */
export function isHumanOutboundTouch(touch: {
  direction: string | null | undefined;
  automated?: boolean | null;
}): boolean {
  // `=== 'out'` rather than a truthiness or an `!== 'in'` test: a row whose direction was never
  // written (null, which every pre-slice-8b Email row carries) is of UNKNOWN direction, and an
  // unknown direction must not be read as outreach.
  if (touch.direction !== 'out') return false;
  return touch.automated !== true;
}

/**
 * Why a lead moved New -> Contacted: a qualifying contact on one of the three channels, or the
 * hand correction of its contact time (`POST /api/leads/:id/contact`).
 */
export type LeadContactedReason = LeadContactChannel | 'hand_correction';

/** The History `via` and the reason printed after "Lead moved to Contacted:". Stored and rendered, so vendor-neutral. */
const CONTACTED_REASON: Record<LeadContactedReason, { via: string; prose: string }> = {
  call: { via: 'first_outbound_call', prose: 'first outbound call' },
  text: { via: 'first_outbound_text', prose: 'first outbound text' },
  email: { via: 'first_outbound_email', prose: 'first outbound email' },
  hand_correction: { via: 'contact_set_by_hand', prose: 'contact time set by hand' },
};

/**
 * THE New -> Contacted move (#2618), shared by every contact door and the hand correction, so the
 * guard and the History row cannot drift between them. It goes through the single status writer
 * (D6) with "only from New" in the WHERE (`onlyFrom: ['NEW']`): a concurrent move to any other
 * status is never overwritten and a lead already past New writes no History row. `notFrom: []`
 * because `onlyFrom` is strictly narrower than the terminal default. `from` is supplied rather
 * than read: the WHERE makes it true whenever the write lands.
 *
 * It never writes the contact clock (D6, kept): the contact writes the clock, the status follows.
 * `at` dates the History row; omitted, it is dated now.
 */
export function moveNewLeadToContacted(
  tx: Prisma.TransactionClient,
  move: { leadId: string; orgId: string; reason: LeadContactedReason; actorId?: string | null; at?: Date },
): Promise<LeadTransitionResult> {
  const { via, prose } = CONTACTED_REASON[move.reason];
  return transitionLeadStatus(tx, {
    leadId: move.leadId,
    orgId: move.orgId,
    from: 'NEW',
    to: 'CONTACTED',
    onlyFrom: ['NEW'],
    notFrom: [],
    actorId: move.actorId ?? null,
    description: `Lead moved to ${LEAD_STATUS_LABEL.CONTACTED}: ${prose}`,
    metadata: { via },
    at: move.at,
  });
}

/**
 * Run `fn` inside a SAVEPOINT of the caller's transaction, so a failed statement is rolled back to
 * the savepoint instead of aborting the whole transaction (Postgres refuses every later statement
 * in an aborted transaction, 25P02). That is what lets a failed status move inside `{ tx }` leave
 * the caller's own writes (the logged entry, the phone-system call or text row) to commit: spec
 * #2618 story 19, a bookkeeping failure never fails the message. The name is fixed: savepoints
 * nest by name in Postgres, and ROLLBACK TO / RELEASE address the most recent one of that name.
 */
async function inSavepoint<T>(
  tx: Prisma.TransactionClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  await tx.$executeRawUnsafe('SAVEPOINT lead_outbound_contact');
  try {
    const result = await fn(tx);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT lead_outbound_contact');
    return result;
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT lead_outbound_contact');
    throw err;
  }
}

/**
 * Record a human-originated outbound contact on a lead. Two effects, in this order:
 *
 *   1. stamp `leads.contacted_at` if the clock has never been set (first touch wins, #1751 D5);
 *   2. move the lead NEW -> CONTACTED through the single status writer (#2618), with a History row
 *      carrying from / to / the actor / the channel.
 *
 * The move applies whenever a qualifying contact lands on a NEW lead, not only on the first contact
 * ever: a lead set back to New by hand moves again on its next contact. The guard is described on
 * `moveNewLeadToContacted`.
 *
 * The move never writes the contact clock (D6, kept): the contact writes the clock and the status
 * follows the contact. Returns true only when this call was the first touch on the clock.
 *
 * Never throws (see the module header). A failure rolls back BOTH writes and is logged: with
 * `{ client }` by rolling back the service's own transaction, with `{ tx }` by rolling back to a
 * savepoint, so the caller's transaction is not aborted and its own writes still commit.
 * `contacted_set_by` is deliberately NOT written: it is the marker for a HAND correction, so
 * leaving it null here is what keeps the automatic stamp and the human one distinguishable.
 */
export async function recordLeadOutboundContact(
  db: LeadContactDb,
  touch: LeadOutboundTouch,
): Promise<boolean> {
  const leadId = touch.leadId;
  if (!leadId) return false;
  if (!isHumanOutboundTouch(touch)) return false;

  const write = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    const first = await stampLeadClock(tx, leadId, touch.orgId, 'contacted_at', touch.at);
    await moveNewLeadToContacted(tx, {
      leadId,
      orgId: touch.orgId,
      reason: touch.channel,
      actorId: touch.actorId,
      // Dated at the contact, like the one-time update dates its rows at `contacted_at`: a call
      // logged by hand days later must not start "time in Contacted" on the day it was typed in.
      at: touch.at,
    });
    return first;
  };

  try {
    return 'tx' in db ? await inSavepoint(db.tx, write) : await db.client.$transaction(write);
  } catch (err) {
    logger.error(
      `Failed to record lead outbound contact (lead ${leadId}, ${touch.channel}):`,
      err,
    );
    return false;
  }
}
