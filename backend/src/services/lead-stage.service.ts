/**
 * lead-stage.service.ts — the lead's pipeline clocks and the single writer that moves its status.
 *
 * Spec: GitHub issue #1751 ("Lead stage clocks"), decisions D2, D3, D6 and D7.
 *
 * WHY THIS MODULE EXISTS
 *
 * A business owner wants three durations: lead-in to first contact, first contact to a booked
 * walkthrough, and completed walkthrough to sent estimate. None was computable, because the
 * platform recorded no moment at which a lead reached a stage — a status edit wrote an audit row
 * naming which FIELDS changed and nothing else, with no from and no to.
 *
 * Two rules run through everything below.
 *
 *   FIRST TOUCH WINS. Every clock here except one is set once and never moved. Following a lead up
 *   five times must not keep resetting "when did we first reach out"; a second estimate must not
 *   restart the estimate clock. The rule is enforced by a conditional write — UPDATE ... WHERE the
 *   column IS NULL — which is atomic in Postgres and therefore correct under concurrency, unlike a
 *   read-then-write.
 *
 *   NOTHING IS EVER UN-SET. The single exception, `last_visit_completed_at`, is a deliberate
 *   re-anchoring mirror and is documented as such where it is written. An earlier design had the
 *   completion clock CLEAR when a late visit was booked; that would have erased the evidence of a
 *   breach that had already occurred. D3 splits the questions instead, so no destructive write is
 *   needed anywhere. Ratified by the product owner: a recorded breach stands. Booking a later
 *   visit stops the clock going forward; it does not forgive the miss.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * The enum is NOT ordered, and this codebase has been burned repeatedly by code that assumed it
 * was. The clocks, not the status, are what yield a duration. (The statuses Walkthrough Scheduled
 * and Walkthrough Completed exist and are moved by `syncLeadWalkthroughStatus` below, but they sit
 * beside these clocks and never replace them.)
 */
import { Prisma, type LeadStatus } from '@prisma/client';
import { LIVE_VISIT_STATUSES } from '../lib/visit-status';

type Tx = Prisma.TransactionClient;

/**
 * The monotonic clocks — the ones this module will only ever set, never move.
 *
 * `last_visit_completed_at` is NOT in this union, on purpose: it re-anchors, so it must not be
 * reachable through `stampLeadClock`, whose whole contract is that it cannot overwrite.
 */
export type LeadStageClock =
  | 'contacted_at'
  | 'walkthrough_first_booked_at'
  | 'walkthrough_first_completed_at'
  | 'first_estimate_sent_at'
  | 'won_at';

/**
 * Set a stage clock if — and only if — it has never been set.
 *
 * Returns true when this call was the first touch, which is what a caller needs in order to decide
 * whether to also write a one-time ledger entry.
 *
 * `updateMany` rather than `update`, and the null test lives in the WHERE clause rather than in a
 * preceding read, so that two concurrent writers cannot both observe null and both write. Postgres
 * settles it; the loser updates zero rows and truthfully reports that it was not first. `update`
 * would additionally throw P2025 on a no-match, turning "somebody beat me to it" into an error.
 */
export async function stampLeadClock(
  tx: Tx,
  leadId: string,
  orgId: string,
  clock: LeadStageClock,
  at: Date,
): Promise<boolean> {
  const { count } = await tx.lead.updateMany({
    // `organization_id` is REQUIRED rather than optional, and that is the point: this is a shared
    // writer reached from five doors across three modules, and the argument `transitionLeadStatus`
    // makes below — that a single writer must not rely on all of its callers continuing to scope
    // their reads — applies here identically. Every current caller does hold an id it resolved
    // under a tenant-scoped read, so this changes no behaviour today; making the parameter
    // mandatory is what stops the sixth caller from being the one that does not.
    where: { id: leadId, organization_id: orgId, [clock]: null },
    data: { [clock]: at },
  });
  if (count > 0 && clock === 'contacted_at') {
    if ((tx as any).notificationRecipient?.updateMany) {
      await (tx as any).notificationRecipient.updateMany({
        where: {
          organization_id: orgId,
          notification: {
            verb: 'spider.alert',
            object_id: leadId,
          },
          read_at: null,
        },
        data: { read_at: new Date() },
      });
    }
  }
  return count > 0;
}

/**
 * The RE-ANCHORING clock column a lead-facing door should write, given what it already knows.
 *
 * Returns a PATCH — empty unless a visit just completed — that the caller merges into the
 * `lead.update` it was going to make anyway. That shape is deliberate. Every door here has already
 * loaded the lead in order to authorize the request and has to write it back for the response, so
 * folding this column into that one statement means it adds no query to any request path, and no
 * new call for a caller (or a test double) to know about.
 *
 * WHY ONLY THE RE-ANCHORING COLUMN LIVES HERE.
 *
 * This helper used to carry the two MONOTONIC clocks as well, deciding first-touch-wins by reading
 * the current value off the row the door had loaded OUTSIDE the transaction and writing inside it.
 * That is a read-then-write across a transaction boundary: two concurrent completions of the same
 * lead can both observe null and both write, and the later one moves a clock the spec says can
 * never move. `stampLeadClock` exists precisely to avoid that — its `WHERE ... IS NULL` makes the
 * decision atomically in Postgres — so the monotonic pair goes through it and this helper keeps
 * only the column that has no invariant to protect.
 *
 * `last_visit_completed_at` RE-ANCHORS by design: every completion overwrites it, so there is
 * nothing for a concurrent writer to corrupt. The worst a race can do is leave the later of two
 * near-simultaneous completions in the column, which is what the column means.
 */
export function leadClockPatch(event: { visitCompletedAt?: Date }): Prisma.LeadUncheckedUpdateInput {
  const patch: Prisma.LeadUncheckedUpdateInput = {};
  if (event.visitCompletedAt) {
    // RE-ANCHORS, and it is assigned outright rather than computed as MAX over the visit rows.
    // A completion instant is always `new Date()` at the door, so the visit just completed is by
    // construction the latest this lead has; a MAX query would ask the database to confirm what
    // the call site already guarantees.
    //
    // That guarantee is the DOOR's, not this column's. A backfill, or any repair that has to
    // derive the value from rows already written, cannot assume it and must run the real
    // MAX(completed_at) over the lead's non-cancelled visits — including the
    // `completed_at IS NOT NULL` filter, because Postgres sorts NULLs FIRST on a DESC order and a
    // COMPLETED row carrying no instant would otherwise win and mask the true latest one.
    patch.last_visit_completed_at = event.visitCompletedAt;
  }
  return patch;
}

/** The three statuses from which a lead never moves on automatically. */
export const TERMINAL_LEAD_STATUSES: readonly LeadStatus[] = ['WON', 'LOST', 'CANCELLED'] as const;

/**
 * The words a person reads for each lead status (History lines, anything else written for a
 * human). `Record<LeadStatus, string>` makes a new enum value a compile error here until it has a
 * label. Mirrors the frontend registry (design-system/status-registry.ts), which a guard test
 * keeps in step with the enum.
 */
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  WALKTHROUGH_SCHEDULED: 'Walkthrough Scheduled',
  WALKTHROUGH_COMPLETED: 'Walkthrough Completed',
  ESTIMATED: 'Estimate Sent',
  WON: 'Won',
  LOST: 'Lost',
  CANCELLED: 'Cancelled',
};

export interface LeadTransitionResult {
  /** False when the guard refused the move, or when the lead was already in the target status. */
  changed: boolean;
}

export interface LeadTransitionOptions {
  leadId: string;
  orgId: string;
  to: LeadStatus;
  /**
   * The status the caller has already read off the lead. Supplied rather than re-read here, and
   * that is a deliberate design point rather than a shortcut: every door that changes a lead's
   * status has already loaded the row to authorize the request, so a read inside this helper
   * would be a second query per transition whose only consumer is the ledger's `from` field.
   *
   * It is NOT what enforces the guard — `notFrom` / `onlyFrom` go into the WHERE clause of the
   * write itself, so the decision is settled atomically by the database and a stale `from` can
   * never let a forbidden transition through.
   */
  from: LeadStatus;
  /** The user who caused the transition; null for a webhook or other system path. */
  actorId?: string | null;
  /**
   * Statuses this transition must refuse to overwrite. Defaults to the three terminal ones, which
   * is what all nine of the scattered lead-to-WON writers already hand-rolled as
   * `status: { notIn: ['WON', 'LOST', 'CANCELLED'] }`. Pass an empty array for a door that has
   * already run its own, stricter check and answered the caller with a 400.
   */
  notFrom?: readonly LeadStatus[];
  /**
   * When set, the transition applies ONLY from one of these statuses. The demotion doors (a win
   * being voided hands the lead back to ESTIMATED) are conditional in exactly this direction, and
   * expressing them through `notFrom` would mean enumerating every other value in the enum — a
   * list that silently becomes wrong the day someone adds a status.
   */
  onlyFrom?: readonly LeadStatus[];
  /** Ledger prose. Printed verbatim in the Activity panel, so no instants in it (MV-TZ-07). */
  description: string;
  /** Merged into the ledger entry's metadata alongside the mandatory `from` / `to`. */
  metadata?: Prisma.JsonObject;
  /** Columns to write in the SAME statement as the status, e.g. `lost_reason`. */
  data?: Prisma.LeadUncheckedUpdateManyInput;
}

/**
 * THE single path that changes a lead's status (D6).
 *
 * This is not tidiness. Lead-to-WON alone is written today from nine separate call sites across
 * the estimate, invoice and webhook controllers, each a bare status update behind its own guard.
 * Stamping a timestamp at nine sites guarantees drift — the tenth writer added next quarter will
 * forget — and a clock that is right eight times out of nine is not reportable. Routing them
 * through one helper is what makes the ledger trustworthy enough to report from.
 *
 * Three things happen here, in the caller's transaction:
 *
 *   1. the status moves, subject to `notFrom` / `onlyFrom`, decided in the WHERE clause;
 *   2. the stage clock for the new status is stamped, first-touch-wins;
 *   3. a ledger entry is written carrying `from`, `to` and the actor — but ONLY if the status
 *      actually moved. The ledger records what OCCURRED, and a write the guard refused did not.
 *
 * D7: the ledger is a timeline event, NOT a new table. The columns on the lead are a live cache
 * answering "where is this lead now"; the timeline is the immutable record of what occurred,
 * which is what makes re-entry analysis and after-the-fact policy changes possible (Salesforce's
 * opportunity-history pattern). The timeline model already has the shape, the tenant scoping and
 * the indexes, so preferring it keeps the number of new seams at zero.
 *
 * NOTE ON `contacted_at`: it is NOT stamped by a move to CONTACTED, and that is deliberate rather
 * than an omission. Booking a walkthrough moves a New or Contacted lead to Walkthrough Scheduled
 * in the same transaction, so if a status move wrote the contact clock, the "first contact to
 * walkthrough booked" interval would be structurally zero for exactly the leads it is meant to
 * measure. The contact clock has its own writers, driven by human-originated outbound activity
 * (D5).
 */
export async function transitionLeadStatus(
  tx: Tx,
  opts: LeadTransitionOptions,
): Promise<LeadTransitionResult> {
  const { leadId, orgId, to, from, actorId = null, description, metadata, data } = opts;
  const notFrom = opts.notFrom ?? TERMINAL_LEAD_STATUSES;

  // A re-assertion of the status the lead is already in is not a transition. Returning early
  // keeps the ledger free of entries for events that did not occur, and keeps a repeated webhook
  // (which is idempotent by design) from filing a second identical row every time it retries.
  if (from === to) return { changed: false };
  if (notFrom.includes(from)) return { changed: false };
  if (opts.onlyFrom && !opts.onlyFrom.includes(from)) return { changed: false };

  // The guard is repeated in the WHERE clause rather than trusted from `from` alone. `from` is
  // whatever the caller read a few statements ago; this is what the database sees now, so a
  // concurrent writer cannot slip a lead into a terminal status between the two and have this
  // transition overwrite it. `organization_id` is here for the same reason — the helper is the
  // single writer and must not rely on all ten doors above it continuing to scope their reads.
  //
  // BOTH halves apply when both are given. `onlyFrom` used to REPLACE `notFrom` outright, which
  // is harmless today — all four `onlyFrom` callers pass `notFrom: []` — but a future caller
  // passing both would have got a WHERE clause weaker than its own call site reads, and the
  // in-memory checks immediately above would have been the only thing enforcing the half the SQL
  // dropped. Prisma ANDs `in` and `notIn` inside one enum filter, so the two compose with no
  // special case.
  const guard: Prisma.EnumLeadStatusFilter = {};
  if (opts.onlyFrom) guard.in = [...opts.onlyFrom];
  if (notFrom.length) guard.notIn = [...notFrom];

  const { count } = await tx.lead.updateMany({
    where: { id: leadId, organization_id: orgId, ...(Object.keys(guard).length > 0 ? { status: guard } : {}) },
    data: {
      status: to,
      // First touch wins. `won_at: null` in the WHERE would over-narrow the statement (it would
      // also block the status write on a re-won lead), so the clock is stamped by its own
      // conditional write below instead.
      ...data,
    },
  });

  // Zero rows means the database disagreed with `from` — the lead was deleted, moved org, or was
  // put into a guarded status by a concurrent writer. Nothing happened, so nothing is recorded.
  if (count === 0) return { changed: false };

  if (to === 'WON') await stampLeadClock(tx, leadId, orgId, 'won_at', new Date());
  if (to === 'CONTACTED' || to === 'WALKTHROUGH_SCHEDULED' || to === 'ESTIMATED') {
    if ((tx as any).notificationRecipient?.updateMany) {
      await (tx as any).notificationRecipient.updateMany({
        where: {
          organization_id: orgId,
          notification: {
            verb: 'spider.alert',
            object_id: leadId,
          },
          read_at: null,
        },
        data: { read_at: new Date() },
      });
    }
  }

  await tx.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: 'LEAD',
      entity_id: leadId,
      event_type: 'STATUS_CHANGE',
      description,
      // `from` and `to` are the entire point: without them no time-in-stage is computable, even
      // retroactively, which is the defect that made this spec necessary. The two lead status
      // events that existed before this (cancel, mark-lost) recorded neither.
      metadata: { from, to, ...metadata },
      created_by: actorId,
    },
  });

  return { changed: true };
}

/**
 * The statuses a visit change is allowed to move a lead between (PRD D3). Estimate Sent, Won, Lost
 * and Cancelled are further along than any walkthrough step, so a visit never moves them.
 */
export const WALKTHROUGH_DRIVEN_FROM_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
] as const;

/**
 * THE rule for where a lead's visits say it should be (walkthrough lead-statuses PRD 6.1). Pure:
 * the transactional wrapper below only gathers the two counts and writes the answer.
 *
 * Derived from the WHOLE set of the lead's visits, never from one (D2): a lead can hold several,
 * and "is anything still booked?" and "has anything finished?" are the only two questions that
 * stay true when there is more than one.
 *
 *   - Estimate Sent, Won, Lost, Cancelled: never moved by a visit change (D3).
 *   - any visit still open: Walkthrough Scheduled. That covers the first booking, a further
 *     booking, and a Walkthrough Completed lead that gets another visit (D4, D5).
 *   - nothing open, at least one finished: Walkthrough Completed. "Completed" means the
 *     walkthrough is done, not that one trip of several is (D4), and it is also where a lead lands
 *     when its last open visit is cancelled after a visit already finished (D6).
 *   - nothing open, nothing finished: a lead that was Walkthrough Scheduled or Completed goes back
 *     to Contacted (D6); a New or Contacted lead with no visits at all stays where it is.
 *
 * @param openVisits     visits of the lead with a status in LIVE_VISIT_STATUSES
 * @param finishedVisits visits of the lead with status COMPLETED
 */
export function walkthroughDrivenStatus(
  current: LeadStatus,
  openVisits: number,
  finishedVisits: number,
): LeadStatus {
  if (!WALKTHROUGH_DRIVEN_FROM_STATUSES.includes(current)) return current;
  if (openVisits > 0) return 'WALKTHROUGH_SCHEDULED';
  if (finishedVisits > 0) return 'WALKTHROUGH_COMPLETED';
  if (current === 'WALKTHROUGH_SCHEDULED' || current === 'WALKTHROUGH_COMPLETED') return 'CONTACTED';
  return current;
}

/** Which visit door asked for the sync. Recorded on the History row as `metadata.via`. */
export type WalkthroughSyncVia =
  | 'walkthrough_scheduled'
  | 'visit_created'
  | 'walkthrough_completed'
  | 'walkthrough_unscheduled'
  | 'walkthrough_cancelled';

/**
 * The plain-words History line for a walkthrough-driven move (PRD 11.2). No instants in it
 * (MV-TZ-07): the Activity panel prints it verbatim to every viewer in every zone.
 */
export function walkthroughMoveDescription(
  from: LeadStatus,
  to: LeadStatus,
  via: WalkthroughSyncVia,
): string {
  if (to === 'WALKTHROUGH_SCHEDULED') {
    return from === 'WALKTHROUGH_COMPLETED'
      ? `Lead moved back to ${LEAD_STATUS_LABEL.WALKTHROUGH_SCHEDULED}: another walkthrough was booked`
      : `Lead moved to ${LEAD_STATUS_LABEL.WALKTHROUGH_SCHEDULED}: a walkthrough was booked`;
  }
  if (to === 'WALKTHROUGH_COMPLETED') {
    return via === 'walkthrough_completed'
      ? `Lead moved to ${LEAD_STATUS_LABEL.WALKTHROUGH_COMPLETED}: the walkthrough is done`
      : `Lead moved to ${LEAD_STATUS_LABEL.WALKTHROUGH_COMPLETED}: the remaining walkthrough was cancelled`;
  }
  if (to === 'CONTACTED') {
    return `Lead moved back to ${LEAD_STATUS_LABEL.CONTACTED}: its walkthrough was cancelled`;
  }
  return `Lead status changed to ${LEAD_STATUS_LABEL[to]}`;
}

/**
 * Bring a lead's status in line with its visits, in the caller's transaction. Call it after EVERY
 * write to a lead's visits (book, add, complete, unschedule, cancel); a reschedule may call it
 * too, because it changes nothing when nothing needs to change.
 *
 * LOCK ORDER. The lead row is locked FIRST, and the caller must have already written its visit:
 * visit, then lead, the order every other lead writer uses (markLost, cancelLead and the schedule
 * doors all write the visit and then the lead; the reverse could deadlock against them).
 * `FOR NO KEY UPDATE` for the reason the lead renumber door gives: `leads` is a numbering anchor
 * and an FK target, and a plain FOR UPDATE would also block unrelated FK-carrying inserts.
 *
 * The lock is what makes the two counts trustworthy. Two requests finishing the last two open
 * visits at the same moment each hold their own uncommitted write, so each one's count on its own
 * snapshot still sees the other visit open. The second to take the lock waits for the first to
 * commit, and under READ COMMITTED its next statement takes a fresh snapshot and sees both visits
 * done. Exactly one of them therefore makes the move to Walkthrough Completed.
 *
 * The lead's current status is RE-READ after the lock rather than trusted from the door's earlier
 * read, which ran before the transaction opened. `onlyFrom` repeats D3 in the SQL WHERE, so a
 * concurrent move to Estimate Sent or Won cannot be overwritten either.
 *
 * The move goes through `transitionLeadStatus`, so it leaves the History row and the
 * time-in-status record, and it does NOT stamp `contacted_at` (booking a walkthrough is not
 * reaching out to the customer; see the note on `transitionLeadStatus`).
 *
 * A visit with no time set but a live status still counts as open.
 */
export async function syncLeadWalkthroughStatus(
  tx: Tx,
  args: { leadId: string; orgId: string; actorId: string | null; via: WalkthroughSyncVia },
): Promise<LeadTransitionResult> {
  await tx.$executeRaw`SELECT id FROM leads WHERE id = ${args.leadId}::uuid AND organization_id = ${args.orgId}::uuid FOR NO KEY UPDATE`;
  const lead = await tx.lead.findFirst({
    where: { id: args.leadId, organization_id: args.orgId },
    select: { status: true },
  });
  // Gone, or not this organisation's: nothing to move.
  if (!lead) return { changed: false };
  const from = lead.status;

  const openVisits = await tx.visit.count({
    where: { organization_id: args.orgId, lead_id: args.leadId, status: { in: [...LIVE_VISIT_STATUSES] } },
  });
  const finishedVisits = await tx.visit.count({
    where: { organization_id: args.orgId, lead_id: args.leadId, status: 'COMPLETED' },
  });

  const to = walkthroughDrivenStatus(from, openVisits, finishedVisits);
  if (to === from) return { changed: false };

  return transitionLeadStatus(tx, {
    leadId: args.leadId,
    orgId: args.orgId,
    to,
    from,
    actorId: args.actorId,
    onlyFrom: WALKTHROUGH_DRIVEN_FROM_STATUSES,
    notFrom: [],
    description: walkthroughMoveDescription(from, to, args.via),
    metadata: { via: args.via },
  });
}
