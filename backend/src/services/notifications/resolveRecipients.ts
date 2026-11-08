/**
 * resolveRecipients — pure function
 *
 * Encodes the §3 routing matrix from the in-app-notifications design spec.
 * All DB reads happen in the caller (`emit`) and are passed via `entity` + `roleHolders`.
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
  /** Active user-id arrays keyed by role. */
  roleHolders: {
    ADMIN: string[];
    DISPATCHER: string[];
    SALES: string[];
    TECHNICIAN: string[];
  };
}

// ── small helpers ──────────────────────────────────────────────────────────────

const INTERRUPT = 'INTERRUPT' as const;
const FEED = 'FEED' as const;

function spec(userId: string, priority: typeof INTERRUPT | typeof FEED, needs_action = false): RecipientSpec {
  return { userId, priority, needs_action };
}

/** Expand a role group into RecipientSpecs. */
function forRole(
  userIds: string[],
  priority: typeof INTERRUPT | typeof FEED,
  needs_action = false,
): RecipientSpec[] {
  return userIds.map(id => spec(id, priority, needs_action));
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

// ── main function ──────────────────────────────────────────────────────────────

export function resolveRecipients(ctx: ResolveContext): RecipientSpec[] {
  const { verb, entity, roleHolders, actorId } = ctx;
  const { ADMIN, DISPATCHER, SALES: _SALES, TECHNICIAN } = roleHolders;

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

  let raw: RecipientSpec[] = [];

  switch (verb) {
    // ── LEAD ────────────────────────────────────────────────────────────────────
    case 'lead.assigned': {
      // Sales: assigned owner → INTERRUPT; no admin/dispatcher recipients
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, INTERRUPT));
      break;
    }

    case 'lead.unassigned_created': {
      // Admin FEED + Dispatcher FEED (no sales-manager role exists)
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED));
      break;
    }

    case 'lead.reassigned_away': {
      // Previous owner → FEED
      const prev = str('previous_owner_id');
      if (prev) raw.push(spec(prev, FEED));
      break;
    }

    case 'lead.walkthrough_scheduled': {
      // Dispatcher FEED + owner FEED + performers INTERRUPT
      raw.push(...forRole(DISPATCHER, FEED));
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, FEED));
      const performers = strArr('performer_ids');
      performers.forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── ESTIMATE ────────────────────────────────────────────────────────────────
    case 'estimate.approved': {
      // Admin FEED + Dispatcher FEED + needs_action(SCHEDULE_JOB) + owner INTERRUPT
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED, true)); // needs_action = SCHEDULE_JOB
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, INTERRUPT));
      break;
    }

    case 'estimate.declined': {
      // Admin FEED + owner INTERRUPT
      raw.push(...forRole(ADMIN, FEED));
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, INTERRUPT));
      break;
    }

    case 'estimate.deposit_paid': {
      // Admin FEED + Dispatcher FEED + needs_action(SCHEDULE_JOB) + owner INTERRUPT
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED, true)); // needs_action = SCHEDULE_JOB
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, INTERRUPT));
      break;
    }

    case 'estimate.cancelled':
    case 'estimate.deposit_waived':
    case 'estimate.approval_voided':
    case 'estimate.status_corrected': {
      // Admin FEED + owner FEED
      raw.push(...forRole(ADMIN, FEED));
      const owner = str('commission_owner_id');
      if (owner) raw.push(spec(owner, FEED));
      break;
    }

    // ── DISPATCH ────────────────────────────────────────────────────────────────
    case 'dispatch.job_assigned': {
      // Assignees INTERRUPT + Dispatcher FEED (assigner); admin not a recipient
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, INTERRUPT)));
      raw.push(...forRole(DISPATCHER, FEED));
      break;
    }

    case 'dispatch.job_unassigned': {
      // Removed assignees INTERRUPT + Dispatcher FEED
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, INTERRUPT)));
      raw.push(...forRole(DISPATCHER, FEED));
      break;
    }

    case 'dispatch.job_rescheduled': {
      // Assignees INTERRUPT + Dispatcher FEED
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, INTERRUPT)));
      raw.push(...forRole(DISPATCHER, FEED));
      break;
    }

    case 'dispatch.job_created': {
      // Admin FEED + Dispatcher INTERRUPT + assignees INTERRUPT
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, INTERRUPT));
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── JOB ─────────────────────────────────────────────────────────────────────
    case 'job.started':
    case 'job.completed': {
      // Dispatcher FEED + sold_by FEED (if set) + assignees FEED
      raw.push(...forRole(DISPATCHER, FEED));
      const soldBy = str('sold_by_id');
      if (soldBy) raw.push(spec(soldBy, FEED));
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, FEED)));
      break;
    }

    case 'job.cancelled': {
      // Dispatcher FEED + sold_by FEED (if set) + assignees INTERRUPT
      raw.push(...forRole(DISPATCHER, FEED));
      const soldBy = str('sold_by_id');
      if (soldBy) raw.push(spec(soldBy, FEED));
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    case 'job.reopened': {
      // Dispatcher FEED + assignees FEED
      raw.push(...forRole(DISPATCHER, FEED));
      const assignees = strArr('assignee_ids');
      assignees.forEach(id => raw.push(spec(id, FEED)));
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
    case 'communication.call_missed': {
      // needs_action → "call back" follow-up (cleared via the VIEW inline action)
      raw.push(...forRole(DISPATCHER, INTERRUPT, true));
      raw.push(...forRole(ADMIN, INTERRUPT, true));
      break;
    }

    case 'communication.sms_inbound': {
      raw.push(...forRole(DISPATCHER, FEED));
      raw.push(...forRole(ADMIN, FEED));
      break;
    }

    case 'communication.email_inbound': {
      // Unlike sms_inbound, an email thread has an OWNER (slice 8b's "assigned
      // to one, visible to all"). A reply goes to whoever holds the thread, and
      // interrupts them, because it is their conversation to answer - adding
      // the whole room on top would make ownership decorative.
      //
      // The fallback is the room, at FEED: an unowned reply is nobody's in
      // particular, so it is not urgent FOR anyone. The `!== actorId` guard
      // matters because dedupe() drops the actor afterwards - an assignee who
      // is also the actor would otherwise leave the reply notifying no one.
      const assignee = str('thread_assignee_id');
      if (assignee && assignee !== actorId) {
        raw.push(spec(assignee, INTERRUPT));
      } else {
        raw.push(...forRole(DISPATCHER, FEED));
        raw.push(...forRole(ADMIN, FEED));
      }
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

    case 'spider.alert': {
      // The Assignment section controls who receives Spider alerts:
      // 1. If Admin roles are selected, alerts go to those roles
      // 2. If Owner is selected, alerts go to the lead's owner
      // 3. If specific users are selected, alerts go to them
      const selectedAdminRoles = strArr('admin_roles');
      for (const roleKey of selectedAdminRoles) {
        if (roleKey === 'ADMIN') raw.push(...forRole(ADMIN, INTERRUPT));
        else if (roleKey === 'SALES' && roleHolders.SALES) raw.push(...forRole(roleHolders.SALES, INTERRUPT));
        else if (roleKey === 'DISPATCHER') raw.push(...forRole(DISPATCHER, INTERRUPT));
        else if (roleKey === 'TECHNICIAN') raw.push(...forRole(TECHNICIAN, INTERRUPT));
      }

      const explicitUsers = [...strArr('user_ids'), ...strArr('recipient_ids')];
      const singleUserId = str('user_id');
      if (singleUserId && !explicitUsers.includes(singleUserId)) explicitUsers.push(singleUserId);
      explicitUsers.forEach(id => raw.push(spec(id, INTERRUPT)));

      const includeOwner = entity['owner'] === true || entity['notify_owner'] === true;
      const leadOwner =
        str('lead_owner_id') ||
        str('commission_owner_id') ||
        str('customer_owner_id') ||
        str('assigned_to') ||
        str('assigned_to_user_id') ||
        (typeof entity['commission_owner'] === 'object' && (entity['commission_owner'] as any)?.id) ||
        (typeof entity['assigned_to_user'] === 'object' && (entity['assigned_to_user'] as any)?.id) ||
        (typeof entity['owner_user'] === 'object' && (entity['owner_user'] as any)?.id);

      if (includeOwner && leadOwner) {
        raw.push(spec(String(leadOwner), INTERRUPT));
      }

      // Default fallback: if no explicit assignment config was specified, notify ADMIN
      if (raw.length === 0 && selectedAdminRoles.length === 0 && explicitUsers.length === 0 && !includeOwner) {
        raw.push(...forRole(ADMIN, INTERRUPT));
      }
      break;
    }

    // ── BILLING ─────────────────────────────────────────────────────────────────
    case 'billing.payment_received': {
      // Admin FEED + Dispatcher FEED + customer_owner FEED
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED));
      const custOwner = str('customer_owner_id');
      if (custOwner) raw.push(spec(custOwner, FEED));
      break;
    }

    case 'billing.partial_payment': {
      // Admin FEED + Dispatcher FEED + customer_owner FEED
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED));
      const custOwner = str('customer_owner_id');
      if (custOwner) raw.push(spec(custOwner, FEED));
      break;
    }

    case 'billing.invoice_overdue':
    case 'billing.invoice_due_soon': {
      // Admin FEED + needs_action(SEND_REMINDER) + customer_owner FEED + needs_action
      raw.push(...forRole(ADMIN, FEED, true)); // needs_action = SEND_REMINDER
      const custOwner = str('customer_owner_id');
      if (custOwner) raw.push(spec(custOwner, FEED, true)); // needs_action = SEND_REMINDER
      break;
    }

    case 'billing.refunded':
    case 'billing.disputed':
    case 'billing.chargeback':
    // #2031 slice 5 (F1) — an unapplied card capture is money nothing accounts for. Same room as
    // a chargeback: the books' business, and it interrupts.
    case 'billing.payment_unrecorded': {
      // Admin INTERRUPT (Refund / dispute / chargeback → 🔴 Admin)
      raw.push(...forRole(ADMIN, INTERRUPT));
      break;
    }

    case 'billing.voided':
    case 'billing.credit_applied': {
      // Admin FEED
      raw.push(...forRole(ADMIN, FEED));
      break;
    }

    // ── BILLING: payments-account lifecycle (Stripe Connect, Task 1.8) ───────────
    case 'billing.payments_activated':
    case 'billing.payouts_activated': {
      raw.push(...forRole(ADMIN, FEED));
      break;
    }
    case 'billing.payments_action_needed':
    case 'billing.payments_paused': {
      raw.push(...forRole(ADMIN, INTERRUPT, true));
      break;
    }
    // ── deferred-bank first-payment nudge (Task 1.9) ──
    case 'billing.payouts_pending_first_payment': {
      raw.push(...forRole(ADMIN, FEED));
      break;
    }
    // ── within-ceiling rate-change notice (Task 4.3) ──
    case 'billing.platform_fee_rate_changed': {
      raw.push(...forRole(ADMIN, FEED));
      break;
    }

    // ── TEAM ─────────────────────────────────────────────────────────────────────
    case 'team.ot_override_requested': {
      // Admin INTERRUPT + needs_action (APPROVE_OT / DENY_OT)
      raw.push(...forRole(ADMIN, INTERRUPT, true));
      break;
    }

    case 'team.invite_accepted': {
      // Admin FEED
      raw.push(...forRole(ADMIN, FEED));
      break;
    }

    // ── INVENTORY ────────────────────────────────────────────────────────────────
    case 'inventory.stock_approval_requested': {
      // Admin INTERRUPT + needs_action (APPROVE_STOCK / DENY_STOCK)
      raw.push(...forRole(ADMIN, INTERRUPT, true));
      break;
    }

    case 'inventory.low_stock':
    case 'inventory.backorder':
    case 'inventory.staging_no_area':
    case 'inventory.po_partial': {
      // Admin FEED + Dispatcher FEED
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED));
      break;
    }

    case 'inventory.staging_ready': {
      // Admin FEED + Dispatcher FEED + the assigned tech INTERRUPT (it's their pickup).
      raw.push(...forRole(ADMIN, FEED));
      raw.push(...forRole(DISPATCHER, FEED));
      strArr('assignee_ids').forEach(id => raw.push(spec(id, INTERRUPT)));
      break;
    }

    // ── LOGISTIC ORDERS (LO-2) ──────────────────────────────────────────────────
    // NOTE: object_type 'LOGISTIC_ORDER' is NOT in filterByAccess SCOPE_TYPE_MAP,
    // so these recipients pass the downstream row-scope filter UNFILTERED. That is
    // correct while recipients are approve-grant holders + ADMINs (lo.submitted)
    // and the creator (lo.approved) — all org-wide LO readers. If a row-scoped
    // reader (e.g. a technician) is ever added here, wire LOGISTIC_ORDER →
    // 'LogisticOrder' into filterByAccess.SCOPE_TYPE_MAP so it is access-checked.
    case 'lo.submitted': {
      // Approve-grant holders ∪ ADMINs, both INTERRUPT + needs_action. The grant
      // holders are pre-resolved by the caller into entity.approver_ids
      // (automation.message precedent); ADMINs come from roleHolders. dedupe()
      // merges an admin who also holds an explicit grant into a single row.
      strArr('approver_ids').forEach(id => raw.push(spec(id, INTERRUPT, true)));
      raw.push(...forRole(ADMIN, INTERRUPT, true));
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
  // need. Passing a null actor rather than branching inside the switch is deliberate:
  // `communication.email_inbound` reads actorId INSIDE its case to fall back to the room, so
  // nulling the actor any earlier would break that fallback.
  const isSelf = ruleForVerb(verb)?.family === 'self';
  return dedupe(raw, isSelf ? null : actorId);
}
