/**
 * terminalStale.ts — the multi-step engine's terminal staleness floor.
 *
 * Standalone extraction of `stalenessReason()` from the frozen legacy
 * `engine.ts` (lines 91-171). There, a stale entity SKIPS a single send; here,
 * the same checks TERMINATE the whole enrollment (a cancelled job must stop
 * every remaining step, not just the one about to fire). PURE — no prisma,
 * no I/O. The plain-English strings are product copy, kept verbatim.
 */

import { AutomationTriggerType } from '@prisma/client';
import type { EntityState } from './context';
import { LEAD_ANCHOR_SATISFIED_BY, type AnchorKey } from './anchors';
import { isTerminalTaskStatus, type TerminalTaskStatus } from '../../lib/tasks/status';
import { isTaskTransitionTrigger } from './taskTransitions';

/**
 * The plain-English reason each FINISHED task status makes an enrollment stale (Spec B slice 6,
 * stories 19 and 20). Product copy: it is written to the step run's detail and read by admins in
 * the activity tab, so it is a sentence rather than a code.
 *
 * Typed on `TerminalTaskStatus` rather than on `string`, so a future member of
 * `TERMINAL_TASK_STATUSES` reddens HERE and has to be given its own sentence instead of
 * inheriting a neighbour's. That matters more than usual in this file: the switch below ends in
 * a `default` returning null, so nothing else in this module fails loudly when a task case is
 * incomplete - it just goes on emailing people about work that is over.
 */
const TERMINAL_TASK_STALE_REASONS: Record<TerminalTaskStatus, string> = {
  DONE: 'The task was completed',
  CANCELLED: 'The task was cancelled',
};

/**
 * The finished-task floor shared by all five task triggers.
 *
 * Keyed off the STATUS PAIR through the shared helper, never off `completed_at`: cancelling a
 * task deliberately leaves that column null (it means the work FINISHED), so a timestamp check
 * would make a cancelled task look unfinished for ever. `BLOCKED` is deliberately not terminal -
 * blocked work is exactly the work a chase exists for.
 *
 * Returns null for an ABSENT status, which is what keeps the deleted-task email alive: see
 * `isPayloadSourcedTask` below.
 */
function terminalTaskReason(state: EntityState): string | null {
  // The cast is the price of `isTerminalTaskStatus` being a plain boolean rather than a type
  // predicate; the exhaustive Record above is what makes it safe, and what keeps a future
  // terminal status from silently borrowing CANCELLED's sentence.
  if (!isTerminalTaskStatus(state.taskStatus)) return null;
  return TERMINAL_TASK_STALE_REASONS[state.taskStatus as TerminalTaskStatus];
}

/**
 * True when this bundle was SYNTHESISED from the persisted event payload rather than read off a
 * live task row - Spec B slice 4's deletedTaskBundle, the one context in this engine built
 * without reading the entity it is about.
 *
 * A deleted task has no status and no due date, so that bundle carries an EMPTY EntityState on
 * purpose. The live task arm always writes `taskStatus`, so an absent one means exactly one
 * thing: there is no task left to judge.
 *
 * EVERY task case below returns null on it, and that is not tidiness. A case that read the
 * missing status as terminal, or ran the anchor-moved check against an undefined due date, would
 * silently stop the deleted-task email - the one task automation whose entire premise is that
 * the row is gone. The regression test that catches it lives in the deleted-task slice's
 * enrollment suite; the constraint is asserted directly in this module's own suite too.
 */
function isPayloadSourcedTask(state: EntityState): boolean {
  return state.taskStatus === undefined;
}

/**
 * Plain-English reason the enrollment is terminally stale (→ STOP the whole
 * flow), or null when still relevant. `occurrence` is the enrollment's
 * occurrence_key (ISO scheduled_start / completed_at / tech user id) — passed
 * directly, NOT parsed from a dedupe key (that parsing was engine.ts's
 * extractOccurrence; the new model stores occurrence_key explicitly).
 *
 * `direction` — 'before' | 'after' | undefined — is the 5th, OPTIONAL
 * parameter, read ONLY by the four unified date-anchored triggers (JOB/LEAD/
 * INVOICE/ESTIMATE_DATE_ANCHORED, Task A2). Those triggers fire on either
 * side of the SAME anchor date, so "the anchor already passed" is correct
 * staleness for direction:'before' (mirrors BEFORE_JOB_START) but WRONG for
 * direction:'after' — the anchor having passed is that direction's own
 * firing precondition (Task A5's anchorWindow only ever selects
 * already-past anchors for 'after'). Every legacy trigger case below ignores
 * this parameter outright: passing it, passing any value, or omitting it
 * entirely has zero effect on their behavior (see the regression tests).
 * `undefined` — e.g. a malformed trigger_config on an otherwise-new-type
 * trigger — is treated like 'after' for every already-passed-style check
 * (plain `direction === 'before'` guards, so anything else short-circuits
 * them): failing OPEN is the safer default, since misclassifying a genuine
 * 'after' enrollment as 'before' would permanently and silently kill every
 * after-direction reminder in the system, while the reverse mistake only
 * risks one borderline-late send (the same risk a send-window deferral
 * already carries).
 */
export function terminalStaleReason(
  trigger: AutomationTriggerType,
  occurrence: string | undefined,
  state: EntityState,
  now: Date,
  direction?: 'before' | 'after',
  /**
   * The 6th, OPTIONAL parameter, read ONLY by LEAD_DATE_ANCHORED (spec #1751 D8). That trigger
   * now covers four different anchors with genuinely different staleness rules — the original
   * walkthrough anchor, plus three lead stage clocks — so "which anchor is this" has to reach
   * this function. Every other case ignores it outright.
   *
   * `undefined` reproduces the pre-#1751 behaviour exactly: LEAD_DATE_ANCHORED falls through to
   * the walkthrough rules it has always applied. That is the right default for an enrollment
   * whose trigger_config is missing or malformed, because the walkthrough anchor was the only
   * lead anchor that existed when those enrollments were created.
   */
  anchor?: AnchorKey,
): string | null {
  // The task status-TRANSITION triggers ("Task is done") are exempt from the finished-task floor
  // below, and from every other check here. They are enrolled BECAUSE the task just finished, so
  // the floor would stop each of their runs on arrival with "The task was completed" and nothing
  // would ever send. Like JOB_COMPLETED/JOB_CANCELLED they report something that happened, which
  // stays true whatever the task does next - a reopen included. Read off the one registry
  // (taskTransitions.ts), so a transition trigger is exempt the day it is registered; every other
  // task trigger keeps the floor.
  if (isTaskTransitionTrigger(trigger)) return null;

  switch (trigger) {
    case 'BEFORE_JOB_START': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      // B-6 (Spec B1): the cron scan widens to include EN_ROUTE/ON_SITE/IN_PROGRESS so a
      // technician marking themselves en-route/on-site early no longer kills the reminder
      // outright -- but ON_SITE/IN_PROGRESS specifically means the tech is already there or
      // already working, so "your appointment is in 1 hour" would be messaging a customer whose
      // technician is at the door. EN_ROUTE is deliberately NOT included here: the tech is still
      // travelling, so the reminder is still useful.
      // S4 (D17): ON_SITE is gone from JobStatus, and a job whose crew is merely on site now
      // reads SCHEDULED - so this narrows to IN_PROGRESS alone. The comment above about EN_ROUTE
      // being deliberately excluded survives intact and is now true by construction: an en-route
      // visit leaves its job SCHEDULED, exactly the state this guard means to keep chasing.
      if (state.jobStatus === 'IN_PROGRESS') return 'Work has already started';
      if (!state.jobScheduledStart) return 'Job is no longer scheduled';
      if (occurrence && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled — this run was replaced by an updated reminder';
      }
      // A send-window deferral can push a reminder past the appointment itself
      // (e.g. a 1h reminder landing at 22:00 deferred to 08:00 next day). A
      // "reminder" after the fact is worse than silence.
      if (state.jobScheduledStart.getTime() <= now.getTime()) {
        return 'Job start time has already passed';
      }
      return null;
    }
    case 'AFTER_JOB_COMPLETED': {
      if (state.jobStatus !== 'COMPLETED') return 'Job is no longer marked completed';
      // Symmetry with BEFORE_JOB_START above. A job can be moved backward off COMPLETED and
      // re-completed (Spec B1's free transitions, and reopen() -> re-complete already today).
      // The new completed_at mints a NEW dedupe key, so a second run enrols -- correct, because
      // a job genuinely re-completed months later SHOULD re-arm its follow-up. What must not
      // happen is the FIRST run also firing: it belongs to a completion that no longer exists.
      if (occurrence && state.jobCompletedAt && state.jobCompletedAt.toISOString() !== occurrence) {
        return 'Job was re-completed — this run was replaced by an updated follow-up';
      }
      return null;
    }
    case 'INVOICE_OVERDUE': {
      const s = state.invoiceStatus;
      if (s === 'PAID') return 'Invoice was paid — nothing to chase';
      if (s && s !== 'SENT' && s !== 'PARTIAL') return `Invoice is ${s.toLowerCase()} — reminder not needed`;
      // A credit can zero the balance while leaving the invoice SENT/PARTIAL —
      // dunning a $0 balance would be a false alarm.
      if (state.invoiceAmountDue !== undefined && state.invoiceAmountDue <= 0) {
        return 'Invoice has no outstanding balance';
      }
      return null;
    }
    case 'ESTIMATE_FOLLOW_UP': {
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — follow-up not needed`;
      }
      return null;
    }

    // ── Unified date-anchored triggers (Task A2/A5b) — bidirectional around
    //    the SAME anchor date. The floor in each case mirrors its timed-
    //    trigger analogue directly above (dead/terminal entity states, plus —
    //    unlike those always-one-direction triggers — an occurrence-mismatch
    //    check, since Task A5's candidatesForAnchor sets occurrence to the
    //    anchor date for all four). Only the "already passed" check is
    //    direction-gated: see the function doc comment for why direction:
    //    'after' must NOT reuse it unmodified.
    case 'JOB_DATE_ANCHORED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      // Unlike BEFORE_JOB_START above, COMPLETED is only stale for 'before'.
      // Spec B1 removed the ordering guard on complete() entirely, so a job can be marked
      // COMPLETED from ANY active status (including SCHEDULED) with no scheduled_start guard
      // anywhere in job.controller.ts's complete() — so a job can be marked COMPLETED while
      // scheduled_start is still in the future, which the already-passed check below would NOT
      // catch. For 'after', COMPLETED is the expected, desired state at send time (that's the
      // whole point of an after-appointment reminder) and must NOT be treated as stale.
      if (direction === 'before' && state.jobStatus === 'COMPLETED') return 'Job was already completed';
      if (!state.jobScheduledStart) return 'Job is no longer scheduled';
      if (occurrence && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.jobScheduledStart.getTime() <= now.getTime()) {
        return 'Job start time has already passed';
      }
      return null;
    }

    case 'LEAD_DATE_ANCHORED': {
      const s = state.leadStatus;
      // ── Lead stage clocks (spec #1751 D8) ────────────────────────────────
      // These three anchors are stage clocks, not appointment times, so almost none of the
      // walkthrough reasoning below applies to them. Handled first and returned from, rather
      // than woven into the checks underneath, because the very first of those checks
      // (`if (!state.leadWalkthroughScheduledAt)`) would kill every one of them outright on a
      // lead that has no visit booked — which is the exact population an "uncontacted for two
      // days" alert exists to chase.
      const satisfiedBy = anchor ? LEAD_ANCHOR_SATISFIED_BY[anchor] : undefined;
      if (satisfiedBy) {
        // Terminal regardless of direction, exactly as below: a dead lead gets no alert.
        if (s === 'LOST') return 'Lead was marked as lost';
        if (s === 'CANCELLED') return 'Lead was cancelled';
        if (s === 'WON') return 'Lead was won — nothing to chase';
        // "…and it still has not happened", which the candidate sweep cannot express because it
        // selects purely on the anchor date. An owner asking to hear about a lead nobody
        // contacted within four hours does NOT want to hear about the one that was contacted in
        // three; alerting is about failure, not about volume (user story 35).
        //
        // 'after' only. A 'before' reminder on a stage clock counts down to a moment already
        // recorded, so there is nothing outstanding for it to go stale against.
        if (direction !== 'before' && state[satisfiedBy.field] != null) {
          return satisfiedBy.happened;
        }
        // OCCURRENCE MISMATCH — for the clocks that can MOVE after an enrollment was keyed on
        // them, which the registry names rather than this switch. The exemption of the third is a
        // property of that clock rather than an oversight: `lead.created_at` is written once, by
        // the database, and can never produce a second occurrence to compare against.
        //
        // The two that do move, move for opposite reasons. `lead.contacted_at` moves through the
        // correction door, because a human decided the recorded instant was wrong.
        // `lead.last_visit_completed_at` moves because another trip genuinely happened — no
        // correction, no disagreement, just later news.
        //
        // Either way an enrollment keyed on the OLD instant is counting a deadline the business
        // no longer holds anyone to, so it stops rather than firing late against a clock that has
        // moved underneath it — exactly what JOB_DATE_ANCHORED does with a rescheduled job.
        // Nothing is dropped: the new instant mints a new occurrence and the sweep re-enrols on
        // it, so a lead whose estimate is still outstanding two days after its SECOND trip is
        // chased on the second trip's clock instead of being alerted on the first trip's.
        const moves = satisfiedBy.moves;
        if (moves && occurrence) {
          const current = state[moves.field];
          if (current && current.toISOString() !== occurrence) return moves.superseded;
        }
        return null;
      }

      // LOST/CANCELLED are terminal regardless of direction (a dead lead gets
      // no reminder either way). NOTE: this is NOT redundant with the null-date
      // check below — a lead lost/cancelled AFTER the walkthrough already
      // completed (the realistic case for an 'after' reminder, which by
      // definition fires once time has moved past the walkthrough) keeps its
      // historical walkthrough date untouched, so only an explicit status check
      // catches that case. (Closing a lead cancels its open visits, but the
      // current-visit date above still reads the most recent trip.)
      if (s === 'LOST') return 'Lead was marked as lost';
      if (s === 'CANCELLED') return 'Lead was cancelled';
      if (!state.leadWalkthroughScheduledAt) return 'Walkthrough is no longer scheduled';
      if (occurrence && state.leadWalkthroughScheduledAt.toISOString() !== occurrence) {
        return 'Walkthrough was rescheduled — this reminder was replaced by an updated one';
      }
      // 'before' narrows further to the VISIT's own status being EXACTLY SCHEDULED, not
      // lead.status. The lead status (Walkthrough Scheduled / Walkthrough Completed) is derived
      // from ALL of the lead's visits together, so it cannot say whether THIS trip is still
      // pending: a lead is Walkthrough Scheduled while any one trip is open, and an Estimate
      // Sent lead is never moved by a visit at all. A before-reminder promises a STILL-pending
      // walkthrough, so a visit that is REQUESTED/COMPLETED/CANCELLED is stale for 'before'.
      // For 'after', those same visit states are normal forward progress (time moved past the
      // walkthrough, which is what an after-reminder expects) and must NOT be flagged —
      // applying this exact-match check unconditionally is the bug this task closes.
      if (direction === 'before') {
        const wt = state.leadVisitStatus;
        if (wt && wt !== 'SCHEDULED') {
          return `Walkthrough is ${wt.toLowerCase().replace(/_/g, ' ')} — reminder not needed`;
        }
        if (state.leadWalkthroughScheduledAt.getTime() <= now.getTime()) {
          return 'Walkthrough time has already passed';
        }
      }
      return null;
    }

    case 'INVOICE_DATE_ANCHORED': {
      // Direction-independent floor, identical to INVOICE_OVERDUE's above:
      // paying or voiding ends BOTH a pre-due reminder and a post-due chase,
      // and a due-date anchor is only ever meaningful while SENT/PARTIAL —
      // unlike JOB/LEAD's event-flavored anchors, "after due date" has no
      // desired-positive-status to protect (PAID is the desired outcome and
      // INVOICE_OVERDUE already unconditionally treats it as terminal).
      const s = state.invoiceStatus;
      if (s === 'PAID') return 'Invoice was paid — nothing to chase';
      if (s && s !== 'SENT' && s !== 'PARTIAL') return `Invoice is ${s.toLowerCase()} — reminder not needed`;
      if (state.invoiceAmountDue !== undefined && state.invoiceAmountDue <= 0) {
        return 'Invoice has no outstanding balance';
      }
      if (!state.invoiceDueDate) return 'Invoice no longer has a due date';
      if (occurrence && state.invoiceDueDate.toISOString() !== occurrence) {
        return 'Invoice due date was changed — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.invoiceDueDate.getTime() <= now.getTime()) {
        return 'Invoice due date has already passed';
      }
      return null;
    }

    case 'ESTIMATE_DATE_ANCHORED': {
      // Direction-independent floor, identical to ESTIMATE_FOLLOW_UP's above,
      // for the same reason INVOICE_DATE_ANCHORED's is: once answered
      // (WON/DECLINED/etc.) there's nothing left for either a
      // pre-expiration nudge or a post-expiration one to say — WON is the
      // desired outcome and is already unconditionally terminal here, exactly
      // like ESTIMATE_FOLLOW_UP treats it today. Note this is an allowlist of
      // still-open statuses, so it stays correct across EstimateStatus renames
      // (it survived APPROVED→WON in #886 untouched).
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — follow-up not needed`;
      }
      if (!state.estimateValidUntil) return 'Estimate no longer has an expiration date';
      if (occurrence && state.estimateValidUntil.toISOString() !== occurrence) {
        return 'Estimate expiration date was changed — this run was replaced by an updated reminder';
      }
      if (direction === 'before' && state.estimateValidUntil.getTime() <= now.getTime()) {
        return 'Estimate expiration date has already passed';
      }
      return null;
    }

    // ── Task (Spec B slice 6) ────────────────────────────────────────────────
    //    Stories 19 and 20: a reminder that lands after the work is done is worse than no
    //    reminder, and an overdue chase on a cancelled task is noise that teaches people to
    //    ignore the channel. Story 29 puts the rule HERE rather than in the builder: `done`
    //    and `cancelled` are not offered as stop-if conditions, because every admin would
    //    otherwise re-derive the same obvious rule for every task workflow they ever build.
    //    STOP_IF_CONDITIONS.task is empty for that reason and must stay empty.
    case 'TASK_DATE_ANCHORED': {
      // The payload-sourced exception, first and unconditional - see isPayloadSourcedTask.
      // Nothing below this line may run against a bundle with no task behind it: the
      // due-date checks in particular would read an absent date as "cleared" and stop the
      // deleted-task email with a reason that is not true of it.
      if (isPayloadSourcedTask(state)) return null;
      // Direction-independent, exactly as JOB_DATE_ANCHORED's cancellation is: a finished
      // task gets neither the before-reminder nor the after-chase. Unlike a job, there is no
      // desired-positive terminal state to protect for the 'after' direction - the overdue
      // chase exists precisely to reach work that is NOT finished.
      const finished = terminalTaskReason(state);
      if (finished) return finished;
      if (!state.taskDueAt) return 'The task no longer has a due date';
      // The anchor MOVED. The same rule the other three date-anchored triggers apply: this run
      // was enrolled for a date that no longer exists, so it stops rather than firing against a
      // clock that shifted underneath it. Nothing is dropped - the new due date mints a new
      // occurrence and the sweep re-enrols on it.
      if (occurrence && state.taskDueAt.toISOString() !== occurrence) {
        return 'The task due date was changed - this run was replaced by an updated reminder';
      }
      // Direction-gated, per this module's documented discipline: for 'after' the due date
      // having passed is the firing PRECONDITION, not staleness. `undefined` falls through to
      // the after behaviour (plain `=== 'before'`), which fails OPEN on purpose.
      if (direction === 'before' && state.taskDueAt.getTime() <= now.getTime()) {
        return 'The task due date has already passed';
      }
      return null;
    }

    // The four task EVENT triggers. A send window or a WAIT step can put hours or days between
    // the event and the send, so the same finished-task floor applies uniformly: a task created
    // and then completed inside a workflow's wait, or assigned and then cancelled before the
    // send, has nothing left worth mailing about.
    //
    // TASK_DELETED is in this list and is inert in it. Its bundle is always payload-sourced (the
    // row is hard-deleted before the workflow ever runs), so the payload guard inside this block
    // returns null and the deletion notice always sends. It is listed rather than omitted so the
    // four event triggers read as one rule with one exception, instead of one rule and one
    // silent gap.
    case 'TASK_CREATED':
    case 'TASK_ASSIGNED':
    case 'TASK_COMMENT_ADDED':
    case 'TASK_DELETED': {
      if (isPayloadSourcedTask(state)) return null;
      return terminalTaskReason(state);
    }

    // ── Event triggers can also be send-window-deferred (queued at 21:00, sent
    //    at 08:00), so re-verify the entity at send time — the same guarantee the
    //    time triggers give. Only the "state-of-being" events (JOB_COMPLETED,
    //    JOB_CANCELLED, INVOICE_PAID, ESTIMATE_APPROVED/DECLINED, LEAD_CREATED)
    //    stay message-valid regardless of later changes and fall through to null.
    case 'JOB_SCHEDULED':
    case 'TECH_ASSIGNED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      return null;
    }
    case 'JOB_RESCHEDULED': {
      if (state.jobStatus === 'CANCELLED') return 'Job was cancelled';
      if (state.jobStatus === 'COMPLETED') return 'Job was already completed';
      if (occurrence && state.jobScheduledStart && state.jobScheduledStart.toISOString() !== occurrence) {
        return 'Job was rescheduled again — a newer notice replaced this one';
      }
      return null;
    }
    case 'INVOICE_SENT': {
      const s = state.invoiceStatus;
      if (s === 'VOIDED') return 'Invoice was voided';
      if (s === 'PAID') return 'Invoice was already paid';
      return null;
    }
    case 'ESTIMATE_SENT': {
      const s = state.estimateStatus;
      if (s && s !== 'SENT' && s !== 'PENDING') {
        return `Estimate was ${s.toLowerCase()} — no longer awaiting a response`;
      }
      return null;
    }
    case 'WALKTHROUGH_SCHEDULED':
    case 'WALKTHROUGH_RESCHEDULED': {
      // Keys off the VISIT's own status (leadVisitStatus), not lead.status. The lead's status
      // does now move to Walkthrough Scheduled when a trip is booked, but it is derived from ALL
      // the lead's trips (and an Estimate Sent lead is never moved by a visit), so it cannot
      // answer "is THIS trip still pending". The automation trigger WALKTHROUGH_SCHEDULED is an
      // event, not the lead status of the same name.
      const wt = state.leadVisitStatus;
      if (wt && wt !== 'SCHEDULED') {
        return `Walkthrough is ${wt.toLowerCase().replace(/_/g, ' ')} — reminder not needed`;
      }
      if (!state.leadWalkthroughScheduledAt) return 'Walkthrough is no longer scheduled';
      if (state.leadWalkthroughScheduledAt.getTime() <= now.getTime()) return 'Walkthrough time has already passed';
      if (occurrence && state.leadWalkthroughScheduledAt.toISOString() !== occurrence) {
        return 'Walkthrough was rescheduled — this reminder was replaced by an updated one';
      }
      return null;
    }
    default:
      return null;
  }
}
