/**
 * resolveRecipients — pure function
 *
 * Encodes the §3 routing matrix from the in-app-notifications design spec.
 * All DB reads happen in the caller (`emit`) and are passed via `entity`.
 * The function drops the actor (ctx.actorId) from the final result, then de-duplicates
 * by userId merging priority (INTERRUPT wins) and needs_action (OR).
 *
 * Deferred verbs (estimate.viewed, estimate.delivery_failed, invoice.delivery_failed,
 * billing.payment_failed, service_plan.*) are intentionally NOT encoded here — they fall
 * through to the empty-array default. `task.*` is no longer among them: the five verbs of
 * the multi-assignee design §5, plus `task.cancelled` (issue 03), are routed below
 * (task.due_soon / task.overdue stay deferred — they need a cron that does not exist).
 *
 * Rule 0 - never tell someone about their own action - is implemented ONCE, at the single
 * dedupe() call at the bottom. `self`-family verbs (VERB_RULES in templates.ts) are the one
 * named exception and skip the drop. Nothing in the switch below reads the family, and no
 * case needs to: a verb whose emit sites never carry an actor is unaffected either way.
 */

import { ruleForVerb } from './templates';

export type RecipientSpec = {
  userId: string;
  priority: 'INTERRUPT' | 'FEED';
  needs_action: boolean;
};

export interface ResolveContext {
  verb: string;
  organizationId: string;
  actorId: string | null;
  /** Pre-loaded entity + relations (assignees, owner, customer.owner, performers). */
  entity: Record<string, unknown>;
}

// ── small helpers ──────────────────────────────────────────────────────────────

const INTERRUPT = 'INTERRUPT' as const;
const FEED = 'FEED' as const;

function spec(userId: string, priority: typeof INTERRUPT | typeof FEED, needs_action = false): RecipientSpec {
  return { userId, priority, needs_action };
}

/**
 * De-duplicate by userId.
 * Merging rule: INTERRUPT wins over FEED; needs_action is ORed.
 * Then drop the actor - Rule 0, and the only place it is enforced for the bell.
 *
 * A null actorId means "there is nobody to drop", which covers three different situations
 * that all behave identically here: a sweep (`timing: 'time'`), an event whose cause was a
 * webhook or a system detector, and a `self` verb whose caller has exempted it. That is why
 * the caller passes null rather than this function branching on the family.
 */
function dedupe(raw: RecipientSpec[], actorId: string | null): RecipientSpec[] {
  const map = new Map<string, RecipientSpec>();
  for (const r of raw) {
    const existing = map.get(r.userId);
    if (!existing) {
      map.set(r.userId, { ...r });
    } else {
      // Merge: higher priority wins; needs_action ORs
      const priority = existing.priority === INTERRUPT || r.priority === INTERRUPT ? INTERRUPT : FEED;
      const needs_action = existing.needs_action || r.needs_action;
      map.set(r.userId, { userId: r.userId, priority, needs_action });
    }
  }
  const result = Array.from(map.values());
  if (actorId != null) {
    return result.filter(r => r.userId !== actorId);
  }
  return result;
}

// ── verbs and role lists ──────────────────────────────────────────────────────

/**
 * The verbs whose recipients come from the caller's walk of M6's two-lane chain (or are named by the caller outright), never from
 * "everyone on the Admin role" or "everyone on the Dispatcher role". The resolver is never handed a role list at all: S06.29 closed
 * the sweep, S07.9 moved a logistic order submitted and S10.10 moved the last one, a customer's email reply, so every verb is here.
 */
export const VERBS_WITHOUT_ROLE_LISTS: ReadonlySet<string> = new Set([
  'lead.assigned', 'lead.reassigned_away', 'lead.unassigned_created', 'lead.walkthrough_scheduled',
  'estimate.approved', 'estimate.deposit_paid', 'estimate.declined', 'estimate.cancelled',
  'estimate.deposit_waived', 'estimate.approval_voided', 'estimate.status_corrected',
  'dispatch.job_created', 'dispatch.job_assigned', 'dispatch.job_unassigned', 'dispatch.job_rescheduled',
  'job.started', 'job.reopened', 'job.cancelled', 'job.completed', 'job.ready_to_close', 'job.review_attention', 'job.visit_finished',
  'inventory.staging_ready', 'inventory.stock_approval_requested', 'inventory.low_stock', 'inventory.backorder',
  'inventory.staging_no_area', 'inventory.po_partial',
  'billing.payment_received', 'billing.partial_payment', 'billing.invoice_overdue', 'billing.invoice_due_soon', 'billing.refunded',
  'billing.disputed', 'billing.chargeback', 'billing.payment_unrecorded', 'billing.voided', 'billing.credit_applied',
  'billing.bank_payment_started', 'billing.bank_payment_cleared', 'billing.bank_payment_failed', 'billing.dispute_closed',
  'billing.refund_failed',
  'billing.payments_activated', 'billing.payouts_activated', 'billing.payments_action_needed', 'billing.payments_paused',
  'billing.payments_disconnected', 'billing.payouts_pending_first_payment',
  'team.invite_accepted',
  'task.assigned', 'task.watching', 'task.completed', 'task.cancelled', 'task.removed', 'task.commented', 'task.deleted',
  'calendar_entry.scheduled', 'calendar_entry.moved', 'calendar_entry.cancelled',
  'automation.message', 'mailbox.address_needed', 'mailbox.address_needed_admin', 'spider.alert', 'spider.starting_summary',
  'lo.submitted', 'lo.approved',
  'security.new_signin', 'security.password_changed', 'security.mfa_enabled', 'security.mfa_disabled',
  'communication.call_missed', 'communication.sms_inbound', 'communication.email_inbound',
]);

// ── main function ──────────────────────────────────────────────────────────────

export function resolveRecipients(ctx: ResolveContext): RecipientSpec[] {
  const { verb, entity, actorId } = ctx;

  /** Safely read a string field from entity. */
  function str(key: string): string | undefined {
    const v = entity[key];
    return typeof v === 'string' ? v : undefined;
  }

  /** Safely read a string[] field from entity, falling back to []. */
  function strArr(key: string): string[] {
    const v = entity[key];
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** Everyone the caller's walk of M6's two-lane chain found: the record's people, who must act, and the copies. */
  function chainIds(): string[] {
    return [...strArr('lane_one_ids'), ...strArr('lane_two_ids'), ...strArr('copy_ids')];
  }

  let raw: RecipientSpec[] = [];

  switch (verb) {
    // ── LEAD ────────────────────────────────────────────────────────────────────
    case 'lead.assigned': {
      // Sales: assigned owner → INTERRUPT; no admin/dispatcher recipients
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, INTERRUPT));
      break;
    }

    // New lead with no owner (S06.26): on M6's two-lane chain. The caller (leadEstimateAlerts.ts) has already walked the lanes, so
    // every id here is active, can open the lead and is not the person who made it. FEED for everyone, nobody is asked to act.
    case 'lead.unassigned_created': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'lead.reassigned_away': {
      // Previous owner → FEED
      const prev = str('previous_owner_id');
      if (prev) raw.push(spec(prev, FEED));
      break;
    }

    // Walkthrough scheduled (S06.26): on the chain, with the priorities it always had: the people booked on it are interrupted
    // (`performer_ids`, whichever lane found them) and everyone else is told on the feed.
    case 'lead.walkthrough_scheduled': {
      const performers = new Set(strArr('performer_ids'));
      chainIds().forEach(id => raw.push(spec(id, performers.has(id) ? INTERRUPT : FEED)));
      break;
    }

    // ── ESTIMATE ────────────────────────────────────────────────────────────────
    // The estimate alerts (S06.26) are on M6's two-lane chain: the caller (leadEstimateAlerts.ts) has already walked the lanes, so
    // every id here is active, can open the estimate and its lead or job, and is not the person who did it. Bell only. The
    // priorities are what each verb always had: the estimate's Owner (`commission_owner_id`, whichever lane found them) is
    // interrupted by a win, a decline and a deposit, everyone else is told on the feed. Won and Deposit paid are "schedule the
    // job": the people who must act (lane 2) are asked to, the record's own people and the copies are only told.
    case 'estimate.approved':
    case 'estimate.deposit_paid': {
      const owner = str('commission_owner_id');
      const priorityOf = (id: string) => (id === owner ? INTERRUPT : FEED);
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, priorityOf(id))));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, priorityOf(id), true))); // needs_action = SCHEDULE_JOB
      strArr('copy_ids').forEach(id => raw.push(spec(id, priorityOf(id))));
      break;
    }

    case 'estimate.declined': {
      const owner = str('commission_owner_id');
      chainIds().forEach(id => raw.push(spec(id, id === owner ? INTERRUPT : FEED)));
      break;
    }

    case 'estimate.cancelled':
    case 'estimate.deposit_waived':
    case 'estimate.approval_voided':
    case 'estimate.status_corrected': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── DISPATCH ────────────────────────────────────────────────────────────────
    // Job created, assigned and rescheduled (S06.27) are on M6's two-lane chain. The caller (jobSchedulingAlerts.ts) has already
    // walked the lanes, so every id here is active, can open the job and is not the person who did it. Bell only, nobody is
    // asked to act, and the priorities are what each verb always had: the people it is about are interrupted, whichever lane found
    // them, and everyone else is told on the feed.
    //   created      the job's crew and the people who must act (the Dispatcher placing it): `crew_ids`, lane 2
    //   assigned     the people just named (`named_ids`): their alert is the "you" form; the others' names them
    //   rescheduled  the job's crew (`crew_ids`)
    case 'dispatch.job_created': {
      const crew = new Set(strArr('crew_ids'));
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, crew.has(id) ? INTERRUPT : FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, crew.has(id) ? INTERRUPT : FEED)));
      break;
    }

    case 'dispatch.job_assigned': {
      const named = new Set(strArr('named_ids'));
      chainIds().forEach(id => raw.push(spec(id, named.has(id) ? INTERRUPT : FEED)));
      break;
    }

    case 'dispatch.job_rescheduled': {
      const crew = new Set(strArr('crew_ids'));
      chainIds().forEach(id => raw.push(spec(id, crew.has(id) ? INTERRUPT : FEED)));
      break;
    }

    // "Unassigned from you" (S06.27) is personal: the people taken off the job, and nobody else (no lanes, no copies). INTERRUPT.
    case 'dispatch.job_unassigned': {
      strArr('assignee_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── JOB ─────────────────────────────────────────────────────────────────────
    // Job started, cancelled and reopened (S06.25), on M6's two-lane chain like the job completed alert below. The caller
    // (jobLifecycleAlerts.ts) has already walked the lanes, so every id here is active, can open the job and is not the
    // person who did it. Bell only, nobody is asked to act, and the priorities are what each verb always had: FEED for
    // everyone, except that a cancelled job interrupts its crew (`crew_ids`, the job's crew, whichever lane found them).
    case 'job.started':
    case 'job.reopened': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'job.cancelled': {
      const crew = new Set(strArr('crew_ids'));
      chainIds().forEach(id => raw.push(spec(id, crew.has(id) ? INTERRUPT : FEED)));
      break;
    }

    // The job completed alert (S06.23), the first PRD 6 row on M6's two-lane chain. The caller (jobCompletedAlert.ts)
    // has already walked the lanes, so every id here is active, can open the job and is not the person who completed
    // it. Bell only and FEED for everyone, and nobody is asked to act: priority and "needs action" are what the verb
    // always had.
    case 'job.completed': {
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // Ready to close (S06.24): the caller (jobReviewAlerts.ts) has walked the lanes. The Close jobs holders (lane 2) are the
    // people asked to act; the job's own people and the copies are only told.
    case 'job.ready_to_close': {
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, FEED, true)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // Office review attention (S06.24): high priority for everyone the chain found, and nobody is asked to act.
    case 'job.review_attention': {
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // The visit-finish alert (S04.16). The caller has already walked M6's two-lane chain (alertChain.ts), asking the
    // "someone" test of every candidate, so every id here is active, can open the job and is not the person who
    // tapped. A person in more than one list is merged by dedupe(). Only lane 2 is asked to act, and only on the
    // alert that says every visit is finished.
    case 'job.visit_finished': {
      const asksToAct = entity.all_finished === true;
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, FEED, asksToAct)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── CALENDAR ENTRY (slice 07) ────────────────────────────────────────────────
    // USER participants only — FEED, never INTERRUPT (a Calendar Entry is never a request
    // for action). The caller (lib/calendar-entries/notify.ts) has already split the
    // participant set by outcome before calling emit(), so every id reaching this case
    // shares the SAME verb/outcome.
    case 'calendar_entry.scheduled':
    case 'calendar_entry.moved':
    case 'calendar_entry.cancelled': {
      const participantUserIds = strArr('participant_user_ids');
      participantUserIds.forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── TASK (multi-assignee design §5) ─────────────────────────────────────────
    // The routing matrix lives HERE, not in the controller: the caller hands over the
    // raw people-lists (and, for the two add-verbs, the DELTA it already computed for
    // the activity log — design §6 says compute that diff once and feed both), and this
    // switch decides who each verb is actually for.
    //
    // "actor always suppressed" in the design table is not implemented per-case: it is
    // dedupe()'s job, one layer down. That is what makes `task.completed` mean "the OTHER
    // assignees + the watchers" without a special case — the completer is the actor and
    // falls out at the end. It also means a solo self-assign, or a task you complete
    // alone, correctly notifies nobody and emit() early-returns without writing a row.
    //
    // object_type 'TASK' is deliberately absent from filterByAccess's SCOPE_TYPE_MAP, so
    // these recipients are NOT row-scope filtered. That is correct by construction: every
    // recipient below is someone the task itself names, and naming them IS what grants
    // them visibility (design §4).
    case 'task.assigned': {
      // Only the newly ADDED assignees. Re-saving an unchanged roster must notify nobody,
      // which is why the caller sends the delta rather than the whole list.
      strArr('added_assignee_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'task.watching': {
      strArr('added_watcher_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'task.completed': {
      // The task's roster AFTER the update, minus the completer (via dedupe).
      strArr('assignee_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('watcher_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'task.cancelled': {
      // Issue 03. Same roster as task.completed and for the same reason -- the whole point is
      // that the people still carrying this work find out it is off. `task.completed` is NOT
      // reused: it would tell them the work finished, which is the lie CANCELLED exists to end.
      strArr('assignee_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('watcher_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'task.removed': {
      // The people taken off the task — from EITHER list; the caller unions them.
      strArr('removed_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // Spec B slice 3. Placed HERE, strictly between the removed and deleted arms and
    // deliberately nowhere near the calendar-entry block above: this file is the one file
    // the task spec touches that differs between `main` and `staging`, and that difference
    // is a pure reorder of the calendar-entry case around this TASK block. A case added on
    // that boundary is how a back-merge ends up duplicating a whole block.
    //
    // The routing is task.completed's, for the same reason: the people carrying the work
    // and the people following it. The commenter falls out at dedupe() like every other
    // actor, so a comment on your own solo task correctly notifies nobody. A commenter who
    // is NOT on the task (an admin passing through) is simply never in the list to drop.
    //
    // NOT here, and it is a real divergence rather than an oversight: the task CREATOR. No
    // task verb routes to them, while `creator` IS an audience a task AUTOMATION can be
    // addressed to (services/automations/recipients.ts). A creator who is neither assigned
    // nor watching therefore gets automation email about a comment and no bell for it. See
    // the note on `task.commented` in templates.ts, which records the same divergence from
    // the other side.
    case 'task.commented': {
      strArr('assignee_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('watcher_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'task.deleted': {
      // Everyone who was on the task at the moment it was destroyed. Snapshotted by the
      // caller BEFORE the delete, because there is nothing left to read afterwards.
      strArr('assignee_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('watcher_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── COMMUNICATION (CTM phone + SMS) ─────────────────────────────────────────
    // Org-wide phone coverage: every dispatcher + admin. actorId is always null
    // (webhook-driven) so actor exclusion never applies. There is deliberately
    // no call_incoming verb — inbound rings the cell, not the app (#870).
    // S08.21: the access filter keeps a person only if they may read the call, text conversation or email conversation
    // (filterByAccess.ts, the same single read the routes ask).
    //
    // A missed call or voicemail (S08.22) and an inbound text (S08.23) are already replaced: the caller (notificationService.emit,
    // through conversationAlertRecipients.ts) found the record's people, the holders of All, the people linked to the number and,
    // for a text, the person the reply is attributed to, and no role list is read. A missed call interrupts and asks for a call
    // back; a text is a feed item.
    case 'communication.call_missed': {
      // needs_action → "call back" follow-up (cleared via the VIEW inline action)
      strArr('recipient_ids').forEach(id => raw.push(spec(id, INTERRUPT, true)));
      break;
    }

    case 'communication.sms_inbound': {
      strArr('recipient_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // A customer's email reply (S10.10): the caller (emailReplyAlerts.ts) walked M6's chain for the conversation, so every id here is
    // someone who may read it and none comes from a role. The people it is theirs to answer (the holder of the mailbox it sits in, the
    // person who sent the mail by hand, its assignee) are interrupted; the rest of the record's people, the fallback and the copies are
    // told on the feed, so a reply does not interrupt the whole room.
    case 'communication.email_inbound': {
      const owners = new Set(strArr('conversation_owner_ids'));
      chainIds().forEach(id => raw.push(spec(id, owners.has(id) ? INTERRUPT : FEED)));
      break;
    }

    // ── AUTOMATION CENTER ───────────────────────────────────────────────────────
    case 'automation.message': {
      // Recipients are pre-resolved by the automation engine (assigned techs /
      // role holders / a specific user, per the rule's action_config) and
      // passed through entity.recipient_ids. Row-scope filtering still runs
      // downstream in filterRecipientsByAccess.
      const ids = strArr('recipient_ids');
      ids.forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── MAILBOX ─────────────────────────────────────────────────────────────────
    // A user mailbox created without an address (S10.3). The caller found the people: the new user for the first
    // verb, the active Admins (by the switch-holder lookup, never a role name) for the second.
    case 'mailbox.address_needed':
    case 'mailbox.address_needed_admin': {
      strArr('recipient_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── SPIDER ──────────────────────────────────────────────────────────────────
    case 'spider.alert': {
      // Pre-resolved by Spider's single recipient rule (services/spider/recipients.ts), the
      // same list its email and text use, so every channel reaches the same people. FEED: Spider's
      // own button, panel and red frame are its interrupting surfaces, and the bell never shows it
      // (bellHiddenVerbs.ts, D3).
      strArr('recipient_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }
    case 'spider.starting_summary': {
      // One person's starting summary (#2794), pre-resolved by the sweep from Spider's one recipient
      // rule. FEED: listed in the bell, never a toast.
      strArr('recipient_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── BILLING ─────────────────────────────────────────────────────────────────
    // The invoice and payment alerts (S06.28) are on M6's two-lane chain. The caller (invoiceBillingAlerts.ts) has already walked
    // the lanes, so every id here is active, can open the invoice and its job or lead (an alert about money never says more than
    // the invoice's own screens), and is not the person who did it. Bell only. The priorities are what each verb always had for
    // the people who got it (the Admins); the record's own people are told on the feed.
    //   told on the feed, nobody asked to act: a payment (full, partial, a bank payment started or cleared), a void, a credit and
    //     a dispute that closed without costing anything
    //   asked to send a reminder (lane 2, the people who must act): an invoice that is overdue or due soon
    //   interrupts the people who must act and the copies: a refund (and one that failed), a dispute, a chargeback, a card payment
    //     that could not be applied, a bank payment that failed
    case 'billing.payment_received':
    case 'billing.partial_payment':
    case 'billing.bank_payment_started':
    case 'billing.bank_payment_cleared':
    case 'billing.dispute_closed':
    case 'billing.voided':
    case 'billing.credit_applied': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'billing.invoice_overdue':
    case 'billing.invoice_due_soon': {
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, FEED, true))); // needs_action = SEND_REMINDER
      strArr('copy_ids').forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'billing.refunded':
    case 'billing.disputed':
    case 'billing.chargeback':
    // #2031 slice 5 (F1) - an unapplied card capture is money nothing accounts for. Same room as a chargeback: the books' business,
    // and it interrupts.
    case 'billing.payment_unrecorded':
    // Payments go-live slice 32: the owner's payment notifications. A failure needs a person.
    case 'billing.bank_payment_failed':
    case 'billing.refund_failed': {
      strArr('lane_one_ids').forEach(id => raw.push(spec(id, FEED)));
      strArr('lane_two_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      strArr('copy_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── BILLING: payments-account lifecycle (Task 1.8) ───────────────────────────
    // The payments-account alerts (S06.29) have no record: the caller (noRecordAlerts.ts) walked the chain from its second step,
    // so every id is in lane_two_ids (the company's active Admins)
    // and none was found by a role. The good news is on the feed; the ones that need the owner interrupt and ask for action.
    case 'billing.payments_activated':
    case 'billing.payouts_activated':
    // ── deferred-bank first-payment nudge (Task 1.9) ──
    case 'billing.payouts_pending_first_payment': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }
    case 'billing.payments_action_needed':
    case 'billing.payments_paused':
    case 'billing.payments_disconnected': {
      chainIds().forEach(id => raw.push(spec(id, INTERRUPT, true)));
      break;
    }

    // ── TEAM ─────────────────────────────────────────────────────────────────────
    // Invite accepted (S06.29): no record, so the Admins found by
    // the caller; the person who accepted is the actor and falls out at dedupe().
    case 'team.invite_accepted': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // ── INVENTORY ────────────────────────────────────────────────────────────────
    // The inventory alerts have no record (S06.29): the caller (noRecordAlerts.ts) found the active holders of the alert's switch,
    // else the Admins. A stock approval asks them to act; the others are only told.
    case 'inventory.stock_approval_requested': {
      chainIds().forEach(id => raw.push(spec(id, INTERRUPT, true))); // needs_action = APPROVE_STOCK / DENY_STOCK
      break;
    }

    case 'inventory.low_stock':
    case 'inventory.backorder':
    case 'inventory.staging_no_area':
    case 'inventory.po_partial': {
      chainIds().forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    // Parts staged and ready (S06.27): on M6's two-lane chain. The caller (jobSchedulingAlerts.ts) has already walked the lanes.
    // The technician the parts are staged for (`assignee_ids`, whichever lane found them) is interrupted, it is their pickup;
    // everyone else is told on the feed.
    case 'inventory.staging_ready': {
      const tech = new Set(strArr('assignee_ids'));
      chainIds().forEach(id => raw.push(spec(id, tech.has(id) ? INTERRUPT : FEED)));
      break;
    }

    // ── LOGISTIC ORDERS (LO-2) ──────────────────────────────────────────────────
    // NOTE: object_type 'LOGISTIC_ORDER' is NOT in filterByAccess SCOPE_TYPE_MAP,
    // so these recipients pass the downstream row-scope filter UNFILTERED. That is
    // correct because the caller (logisticOrderAlerts.ts) has already walked the chain for
    // lo.submitted (active Approve logistic orders holders who can reach the order, else the
    // Manage roles and permissions holders), and lo.approved goes to the creator. If a
    // row-scoped reader is ever added here, wire LOGISTIC_ORDER → 'LogisticOrder' into
    // filterByAccess.SCOPE_TYPE_MAP so it is access-checked.
    case 'lo.submitted': {
      // Submitted for approval (S07.9): the people who must approve it, INTERRUPT + needs_action. No role list, no
      // order or job people, no copies.
      chainIds().forEach(id => raw.push(spec(id, INTERRUPT, true)));
      break;
    }

    case 'lo.approved': {
      // Creator only (mirror lead.assigned). On self-approve the actor filter in
      // dedupe() drops the creator and emit() early-returns — no row.
      const creator = str('created_by_id');
      if (creator) raw.push(spec(creator, INTERRUPT));
      break;
    }

    // ── SECURITY (recipient = the user themselves; actorId is always null here) ──
    case 'security.new_signin':
    case 'security.password_changed':
    case 'security.mfa_enabled':
    case 'security.mfa_disabled': {
      const userId = str('user_id');
      if (userId) raw.push(spec(userId, FEED));
      break;
    }

    // ── Unknown / deferred verbs → empty ─────────────────────────────────────────
    default:
      break;
  }

  // Rule 0, and its one named exception. A `self` verb is about the recipient's own account
  // (or a receipt they asked for), so it must reach them even when they appear to be the
  // actor - the sign-in an attacker made with your session is exactly the alert you still
  // need. Passing a null actor rather than branching inside the switch is deliberate.
  const isSelf = ruleForVerb(verb)?.family === 'self';
  return dedupe(raw, isSelf ? null : actorId);
}
