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
 * THE RULE RUNS BOTH WAYS (SPEC-4 D7, Ran 24 Oct). A lead counts as Contacted only while an entry
 * that would have released it is still on it. When a person's change takes the last such entry off
 * a Contacted lead (a detach, a move to another lead or a job, a logged entry deleted or flipped to
 * inbound), `reconsiderLeadContact` moves the lead back to New and clears `contacted_at`: the one
 * case in which the first contact time is unwound. "Would have released" is one predicate,
 * `rowWouldRelease`, read by the release (`contactFromLeadLink`) and, as `HOLDS_LEAD_WHERE`, by the
 * hold, so the two cannot drift.
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
import { Prisma, type EmailDeliveryStatus, type PrismaClient } from '@prisma/client';
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
    // Lock the lead row first, the lock `reconsiderLeadContact` takes (SPEC-4 D7). Without it a
    // contact landing while a move-away reconsiders the same lead could be lost: the stamp's
    // `WHERE contacted_at IS NULL` and the move's "only from New" are read off a snapshot in which
    // the lead is still Contacted, so neither waits for the move back and both match nothing; the
    // move back then commits and leaves the lead New with this contact on it. Waiting on the lock
    // means the two statements below read the lead as the move back left it. The communication row
    // was written first and the lead second, the order every lead writer uses.
    await tx.$executeRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid AND organization_id = ${touch.orgId}::uuid FOR NO KEY UPDATE`;
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

// ─── Linking an existing communication to a lead (SPEC-4 §6.1) ───────────────────────────────

/** Statuses that mean a text left: sendCtmSms settles `sent`, the carrier promotes it to `delivered`. */
export const TEXT_WENT_OUT: readonly string[] = ['sent', 'delivered'];
/** Statuses that mean an email left: accepted by the provider, or confirmed delivered. */
export const EMAIL_WENT_OUT: readonly string[] = ['SENT', 'DELIVERED'];

/** The stored fields of a communication row that decide whether it holds its lead. */
export interface LeadEntryRow {
  /** In the row's own case: 'out' / 'in' on texts, emails and calls, 'OUT' / 'IN' on logged entries. */
  direction: string | null;
  automated: boolean | null;
  /** messages.status (text) or emails.delivery_status (email). Ignored for calls and logs. */
  deliveryStatus?: string | null;
}

/**
 * D1 + D7: does this stored row count as an outbound contact on its lead? The release rule read off
 * one row: human, outbound, and for a text or an email, gone out. A call has no went-out gate, and an
 * outbound logged entry is a person stating a conversation happened. WhatsApp is not a source: it
 * never released a lead, so it never holds one either.
 */
export function rowWouldRelease(source: LeadLink['source'], row: LeadEntryRow): boolean {
  if (!isHumanOutboundTouch({ direction: row.direction?.toLowerCase(), automated: row.automated })) return false;
  if (source === 'text') return TEXT_WENT_OUT.includes(row.deliveryStatus ?? '');
  if (source === 'email') return EMAIL_WENT_OUT.includes(row.deliveryStatus ?? '');
  return true;
}

/**
 * A communication that one attach or move door has just written, described by its stored row
 * BEFORE and AFTER that write. Only the stored row can tell a move from a correction: the edit
 * form sends the same body shape for both.
 */
export interface LeadLink {
  /** Which table the row lives in. Decides the went-out rule. */
  source: 'text' | 'email' | 'call' | 'log';
  /** The contact channel, for the History reason (`CONTACTED_REASON`). */
  channel: LeadContactChannel;
  orgId: string;
  /** `lead_id` on the stored row before this write, and after it. */
  leadIdBefore: string | null;
  leadIdAfter: string | null;
  /** Direction on the stored row before and after, in the row's own case ('out' or 'OUT'). */
  directionBefore: string | null;
  directionAfter: string | null;
  automated: boolean | null;
  /** messages.status (text) or emails.delivery_status (email). Ignored for calls and logs. */
  deliveryStatus?: string | null;
  /** The contact's own instant. */
  at: Date;
  /** Who reached out: sender, agent or performer. Null records a system move. */
  actorId: string | null;
}

/**
 * Pure: the contact a new link amounts to, or null. THE rule for every attach and move door
 * (SPEC-4 D1, D6), exported so it is tested once as a table rather than once per door:
 *
 *   - a NEW link only: a detach, a re-attach to the same lead and an edit on the same lead are
 *     corrections, not contacts;
 *   - outbound before AND after: a direction flip never counts, even inside a move (D6);
 *   - human: an automated text or email (reminders, estimate and invoice notices) never counts;
 *   - went out: a text that was sent or delivered, an email that was sent or delivered. A call has
 *     no such gate at any door, and a logged entry is a person stating a conversation happened.
 *
 * First contact wins and a lead past New keeps its status: both inherited from
 * `recordLeadOutboundContact`, which the writer below delegates to. The lead a move LEFT is not this
 * rule's business; D7 reconsiders it (`reconsiderLeadLeftBehind`).
 */
export function contactFromLeadLink(link: LeadLink): LeadOutboundTouch | null {
  if (!link.leadIdAfter || link.leadIdAfter === link.leadIdBefore) return null;
  if (link.directionBefore?.toLowerCase() !== 'out') return null;
  // Outbound after, human and went out: the same predicate D7 reads to decide what still holds a
  // lead, so the release and the hold cannot drift.
  if (!rowWouldRelease(link.source, { direction: link.directionAfter, automated: link.automated, deliveryStatus: link.deliveryStatus })) {
    return null;
  }
  return {
    leadId: link.leadIdAfter,
    orgId: link.orgId,
    channel: link.channel,
    // The canonical comm vocabulary: a logged entry stores 'OUT', and `isHumanOutboundTouch`
    // reads only 'out'.
    direction: 'out',
    automated: link.automated,
    at: link.at,
    actorId: link.actorId,
  };
}

/**
 * Record the contact a new link amounts to, if any. Never throws: it delegates to
 * `recordLeadOutboundContact`, which runs in a savepoint (`{ tx }`) or its own transaction
 * (`{ client }`) and logs a failure, so a bookkeeping failure never fails the attach or the move.
 */
export async function recordLeadContactOnLink(db: LeadContactDb, link: LeadLink): Promise<boolean> {
  const touch = contactFromLeadLink(link);
  return touch ? recordLeadOutboundContact(db, touch) : false;
}

// ─── D7: a lead stays Contacted only while an outbound contact is on it (SPEC-4 §6.12) ────────

/** One door's change to a stored communication row, before and after its write. */
export interface LeadEntryChange {
  source: LeadLink['source'];
  /** The stored row before the write. */
  before: LeadEntryRow & { leadId: string | null };
  /** The row after the write; null when the entry was deleted. */
  after: (LeadEntryRow & { leadId: string | null }) | null;
}

/**
 * Pure: the lead this change took a holding entry off, or null. Exported so the trigger rule is
 * tested once as a table. A row that never held its lead (inbound, automated, not sent, or on no
 * lead) changes nothing; a row that still holds the same lead after the edit changes nothing;
 * anything else (moved, detached, deleted or flipped to inbound) leaves its lead to be reconsidered.
 */
export function leadLeftBehind(c: LeadEntryChange): string | null {
  const from = c.before.leadId;
  if (!from || !rowWouldRelease(c.source, c.before)) return null;
  if (c.after && c.after.leadId === from && rowWouldRelease(c.source, c.after)) return null;
  return from;
}

/**
 * The release rule as a WHERE, per table: the rows that hold a lead in Contacted. A real-database
 * test (lead-contact-moves-new-to-contacted-db.test.ts, "the drift grid") proves each one agrees
 * with `rowWouldRelease` row by row, so the two stay one rule.
 *
 * `automated` is `false OR NULL`, never `{ not: true }`: that is SQL `<> true`, which drops NULL
 * rows, and NULL reads as human in `isHumanOutboundTouch` (historical rows carry it).
 */
const OUT = { equals: 'out', mode: 'insensitive' } as const;
const HUMAN = { OR: [{ automated: false }, { automated: null }] };
export const HOLDS_LEAD_WHERE = {
  text: { direction: OUT, status: { in: [...TEXT_WENT_OUT] }, ...HUMAN } satisfies Prisma.MessageWhereInput,
  email: {
    direction: OUT,
    delivery_status: { in: [...EMAIL_WENT_OUT] as EmailDeliveryStatus[] },
    ...HUMAN,
  } satisfies Prisma.EmailWhereInput,
  // call_sessions has no provenance column: every call is a person dialling (see the module header).
  call: { direction: OUT } satisfies Prisma.CallSessionWhereInput,
  log: { direction: 'OUT' } satisfies Prisma.ManualCommunicationLogWhereInput,
} as const;

export interface LeadReconsider {
  leadId: string;
  orgId: string;
  /** The person whose change took the entry off the lead: the History row's actor. */
  actorId: string | null;
  /** The entry that left. Kept on the History row's metadata (ids only, never rendered). */
  entry: { source: LeadLink['source']; id: string };
  /** The moment of the change: the History row's date and the start of the fresh New stay. */
  now: Date;
}

/** `via` of a move into Contacted that an outbound contact made (`CONTACTED_REASON`'s channel rows). */
const OUTBOUND_CONTACT_VIA_PREFIX = 'first_outbound_';

/** Which name a thrown value carries, never its message or any row content (the sweep's rule). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * D7 (SPEC-4 §6.12.3, Ran 24 Oct): an entry that held this lead has just been taken off it (the
 * door asked `leadLeftBehind`). If the lead is still Contacted because an outbound contact made it
 * so, and nothing that would have released it is left on it, move it back to New: status New, the
 * first contact time cleared, `returned_to_new_at` set to `now` (Spider's fresh New stay), and one
 * History row "Lead moved back to New: no outbound contact left" credited to the person. Nothing is
 * written to any communication table, so the Communication tab shows nothing new.
 *
 * In order, inside one transaction (`{ client }`) or a savepoint of the caller's (`{ tx }`):
 *   1. lock the lead row (FOR NO KEY UPDATE, as `syncLeadWalkthroughStatus` does). The door wrote
 *      the communication first and the lead second, the order every lead writer uses;
 *   2. re-read it under the lock: not Contacted, or a contact time set by hand -> stop;
 *   3. count what still holds it: the company's own rows on the lead in each table, whoever may
 *      read them (the conservative direction), stopping at the first;
 *   4. the newest move into Contacted must have been made by an outbound contact (statement 33: a
 *      Contacted a person set is never undone, and older data with no move recorded is kept);
 *   5. one status write through `transitionLeadStatus`, `onlyFrom: ['CONTACTED']` in its WHERE,
 *      with the cleared clock and the new stay's instant in the same UPDATE.
 *
 * The lock is what makes step 3 trustworthy against a concurrent attach to the same lead: either
 * the count sees its row, or its clock stamp (`WHERE contacted_at IS NULL`) waits for this to
 * commit, then finds the clock empty and releases the lead again.
 *
 * Never throws (same contract as `recordLeadOutboundContact`): a failure is rolled back, logged
 * with the lead and entry ids and the error's name only, and the person's change still stands.
 * Returns true only when the lead moved back to New.
 */
export async function reconsiderLeadContact(db: LeadContactDb, r: LeadReconsider): Promise<boolean> {
  const write = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    await tx.$executeRaw`SELECT id FROM leads WHERE id = ${r.leadId}::uuid AND organization_id = ${r.orgId}::uuid FOR NO KEY UPDATE`;
    const lead = await tx.lead.findFirst({
      where: { id: r.leadId, organization_id: r.orgId },
      select: { status: true, contacted_set_by: true },
    });
    if (!lead || lead.status !== 'CONTACTED' || lead.contacted_set_by) return false;

    const onLead = { organization_id: r.orgId, lead_id: r.leadId };
    const holding =
      (await tx.message.findFirst({ where: { ...onLead, ...HOLDS_LEAD_WHERE.text }, select: { id: true } })) ??
      (await tx.email.findFirst({ where: { ...onLead, ...HOLDS_LEAD_WHERE.email }, select: { id: true } })) ??
      (await tx.callSession.findFirst({ where: { ...onLead, ...HOLDS_LEAD_WHERE.call }, select: { id: true } })) ??
      (await tx.manualCommunicationLog.findFirst({ where: { ...onLead, ...HOLDS_LEAD_WHERE.log }, select: { id: true } }));
    if (holding) return false;

    const intoContacted = await tx.timelineEvent.findFirst({
      where: {
        organization_id: r.orgId,
        entity_type: 'LEAD',
        entity_id: r.leadId,
        event_type: 'STATUS_CHANGE',
        metadata: { path: ['to'], equals: 'CONTACTED' },
      },
      orderBy: { created_at: 'desc' },
      select: { metadata: true },
    });
    const via = (intoContacted?.metadata as Prisma.JsonObject | null | undefined)?.via;
    if (typeof via !== 'string' || !via.startsWith(OUTBOUND_CONTACT_VIA_PREFIX)) return false;

    const moved = await transitionLeadStatus(tx, {
      leadId: r.leadId,
      orgId: r.orgId,
      from: 'CONTACTED',
      to: 'NEW',
      onlyFrom: ['CONTACTED'],
      notFrom: [],
      actorId: r.actorId,
      description: `Lead moved back to ${LEAD_STATUS_LABEL.NEW}: no outbound contact left`,
      metadata: { via: 'no_outbound_contact_left', entry_source: r.entry.source, entry_id: r.entry.id },
      data: { contacted_at: null, returned_to_new_at: r.now },
      at: r.now,
    });
    return moved.changed;
  };

  try {
    return 'tx' in db ? await inSavepoint(db.tx, write) : await db.client.$transaction(write);
  } catch (err) {
    logger.error(
      `Failed to reconsider lead contact (lead ${r.leadId}, ${r.entry.source} ${r.entry.id}): ${errorName(err)}`,
    );
    return false;
  }
}

/**
 * The one call every door makes after its write (SPEC-4 §6.12.5): if the change took a holding
 * entry off a lead (`leadLeftBehind`), reconsider that lead. Never throws; returns true only when a
 * lead moved back to New. `actorId` is the person who made the change, never the entry's sender.
 */
export async function reconsiderLeadLeftBehind(
  db: LeadContactDb,
  change: LeadEntryChange,
  ctx: { orgId: string; actorId: string | null; entryId: string; now?: Date },
): Promise<boolean> {
  const leadId = leadLeftBehind(change);
  if (!leadId) return false;
  return reconsiderLeadContact(db, {
    leadId,
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    entry: { source: change.source, id: ctx.entryId },
    now: ctx.now ?? new Date(),
  });
}
