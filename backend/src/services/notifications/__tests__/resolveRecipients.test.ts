import { describe, it, expect } from 'vitest';
import { resolveRecipients } from '../resolveRecipients';
import { VERB_RULES, type KnownVerb } from '../templates';

const roleHolders = { ADMIN: ['admin1'], DISPATCHER: ['disp1'], SALES: ['sales1', 'sales2'], TECHNICIAN: ['tech1', 'tech2'] };
const base = { organizationId: 'org1', actorId: null as string | null, roleHolders };

// ──────────────────────────────────────────────────────────────────────────────
// Brief representative tests (verbatim from task-1.1-brief.md)
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — brief representative tests', () => {
  it('estimate.approved → owner INTERRUPT+needs nothing, dispatcher FEED+needs_action(schedule), admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.approved',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_assigned → assignees INTERRUPT, assigner(dispatcher) FEED, never admin', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_assigned', actorId: 'disp1',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
  });

  it('inventory.staging_ready → admin + dispatcher FEED + assigned tech INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready',
      entity: { id: 'stg1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r.map(x => x.userId)).toContain('admin1');
    expect(r.map(x => x.userId)).toContain('disp1');
  });

  it('inventory.staging_ready with no assignee → admin + dispatcher only (no INTERRUPT)', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready', entity: { id: 'stg1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    expect(r.find(x => x.priority === 'INTERRUPT')).toBeUndefined();
  });

  it('drops the actor from recipients', () => {
    const r = resolveRecipients({ ...base, verb: 'job.completed', actorId: 'tech1',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
  });

  it('billing.payment_received → admin + dispatcher + owning rep (their customer), all FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payment_received',
      entity: { id: 'i1', customer_owner_id: 'sales2' } });
    expect(r.map(x => x.userId).sort()).toContain('sales2');
    expect(r.map(x => x.userId)).toContain('disp1');
    expect(r.map(x => x.userId)).toContain('admin1');
  });

  it('team.ot_override_requested → ADMIN only, INTERRUPT + needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'team.ot_override_requested',
      entity: { id: 't1', user_id: 'tech1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('security.* → only the account owner', () => {
    const r = resolveRecipients({ ...base, verb: 'security.new_signin',
      entity: { user_id: 'sales1' } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'FEED', needs_action: false }]);
  });

  it('lead.unassigned_created → admin + dispatcher FEED (no sales-manager role)', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.unassigned_created', entity: { id: 'l1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Extended coverage: every remaining v1 verb
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — LEAD verbs', () => {
  it('lead.assigned → commission_owner_id gets INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.assigned',
      entity: { id: 'l1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    // admin and dispatcher are NOT recipients
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('lead.reassigned_away → previous_owner_id gets FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.reassigned_away',
      entity: { id: 'l1', previous_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
  });

  it('lead.walkthrough_scheduled → dispatcher FEED + owner FEED + performers INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1', performer_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
  });

  it('lead.walkthrough_scheduled — no performers → only dispatcher + owner', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['disp1', 'sales1']);
  });
});

describe('resolveRecipients — ESTIMATE verbs', () => {
  it('estimate.declined → owner INTERRUPT + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.declined',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('estimate.deposit_paid → owner INTERRUPT + dispatcher FEED+needs_action + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.deposit_paid',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  it('estimate.cancelled → owner FEED + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.cancelled',
      entity: { id: 'e1', commission_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('estimate.deposit_waived → owner FEED + admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.deposit_waived',
      entity: { id: 'e1', commission_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });
});

describe('resolveRecipients — DISPATCH verbs', () => {
  it('dispatch.job_unassigned → removed assignees INTERRUPT + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_unassigned',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_rescheduled → assignees INTERRUPT + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_rescheduled',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
  });

  it('dispatch.job_created → admin FEED + dispatcher INTERRUPT + assignees INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
  });

  it('dispatch.job_created — no assignees yet → admin + dispatcher only', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created',
      entity: { id: 'j1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

describe('resolveRecipients — JOB verbs', () => {
  it('job.started → dispatcher FEED + sold_by sales FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    // assignee who acts is dropped if actor, but they get FEED if not actor
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
  });

  it('job.started — actor (tech) dropped from result', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started', actorId: 'tech1',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
  });

  it('job.completed → dispatcher + sold_by + assignees FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.completed',
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'], sold_by_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'FEED', needs_action: false });
  });

  it('job.cancelled → dispatcher FEED + sold_by FEED + assignees INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'job.cancelled',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
  });

  it('job.reopened → dispatcher FEED + assignees FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'job.reopened',
      entity: { id: 'j1', assignee_ids: ['tech1'] } });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'FEED', needs_action: false });
  });
});

describe('resolveRecipients — BILLING verbs', () => {
  it('billing.partial_payment → admin + dispatcher + customer_owner_id FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.partial_payment',
      entity: { id: 'i1', customer_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
  });

  it('billing.invoice_overdue → admin FEED+needs_action + customer_owner FEED+needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_overdue',
      entity: { id: 'i1', customer_owner_id: 'sales1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: true });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('billing.invoice_due_soon → admin FEED+needs_action + customer_owner FEED+needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_due_soon',
      entity: { id: 'i1', customer_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: true });
  });

  it('billing.refunded → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.refunded',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });

  it('billing.disputed → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.disputed',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
  });

  it('billing.chargeback → admin INTERRUPT', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.chargeback',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'INTERRUPT', needs_action: false });
  });

  it('billing.voided → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.voided',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
    expect(r.find(x => x.userId === 'sales1')).toBeUndefined();
  });

  it('billing.credit_applied → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.credit_applied',
      entity: { id: 'i1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
  });

  // ── payments-account lifecycle (Task 1.8) — recipients = org ADMIN only ──
  it('billing.payments_activated → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_activated', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('billing.payouts_activated → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payouts_activated', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('billing.payments_action_needed → admin INTERRUPT + needs_action, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_action_needed', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('billing.payments_paused → admin INTERRUPT + needs_action, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payments_paused', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  // ── deferred-bank first-payment nudge (Task 1.9) — recipients = org ADMIN only ──
  it('billing.payouts_pending_first_payment → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payouts_pending_first_payment', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  // ── within-ceiling rate-change notice (Task 4.3) — recipients = org ADMIN only ──
  it('billing.platform_fee_rate_changed → admin FEED, no dispatcher/sales/technician', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.platform_fee_rate_changed', entity: {} });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });
});

describe('resolveRecipients — TEAM verbs', () => {
  it('team.invite_accepted → admin FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'team.invite_accepted',
      entity: { user_id: 'tech1' } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'disp1')).toBeUndefined();
  });
});

describe('resolveRecipients — INVENTORY verbs', () => {
  it('inventory.stock_approval_requested → admin INTERRUPT + needs_action', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.stock_approval_requested',
      entity: { id: 'sr1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('inventory.low_stock → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.low_stock',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    r.forEach(rec => expect(rec.priority).toBe('FEED'));
  });

  it('inventory.backorder → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.backorder',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.staging_ready → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.staging_no_area → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_no_area',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });

  it('inventory.po_partial → admin + dispatcher FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.po_partial',
      entity: { id: 'item1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

describe('resolveRecipients — SECURITY verbs', () => {
  it('security.password_changed → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.password_changed',
      entity: { user_id: 'admin1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });

  it('security.mfa_enabled → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.mfa_enabled',
      entity: { user_id: 'tech2' } });
    expect(r).toEqual([{ userId: 'tech2', priority: 'FEED', needs_action: false }]);
  });

  it('security.mfa_disabled → only the affected user, FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'security.mfa_disabled',
      entity: { user_id: 'sales1' } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'FEED', needs_action: false }]);
  });

  // Every case above passes actorId null, which is what all five security emit sites do
  // today - so until now the alert reached its owner by CONVENTION, not by mechanism, and
  // one future caller passing the real actorId would have silenced it. This is the
  // attacker-with-your-session case: they hold your login, so they ARE the actor, and the
  // alert about what they just did is the one thing that must not be dropped.
  it('security.password_changed returns the account owner even when they are the actor', () => {
    const r = resolveRecipients({ ...base, verb: 'security.password_changed', actorId: 'admin1',
      entity: { user_id: 'admin1' } });
    expect(r).toEqual([{ userId: 'admin1', priority: 'FEED', needs_action: false }]);
  });
});

describe('resolveRecipients — de-dup and priority merging', () => {
  it('INTERRUPT wins over FEED when the same user appears in two roles', () => {
    // tech1 is both an assignee (INTERRUPT in job.cancelled) and a SALES rep
    const rh = { ADMIN: ['admin1'], DISPATCHER: ['disp1'], SALES: ['tech1'], TECHNICIAN: ['tech1'] };
    const r = resolveRecipients({ ...base, roleHolders: rh, verb: 'job.cancelled',
      entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'tech1' } });
    const entry = r.find(x => x.userId === 'tech1');
    expect(entry).toBeDefined();
    expect(entry!.priority).toBe('INTERRUPT');
  });

  it('needs_action ORs: if either slot has needs_action the merged result does too', () => {
    // Use admin who is both admin (FEED, no action on billing.invoice_overdue) — just verify directly
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_overdue',
      entity: { id: 'i1', customer_owner_id: 'admin1' } }); // admin is also customer_owner
    const entry = r.find(x => x.userId === 'admin1');
    expect(entry).toBeDefined();
    expect(entry!.needs_action).toBe(true);
  });

  it('returns empty array for unknown verb', () => {
    const r = resolveRecipients({ ...base, verb: 'unknown.verb', entity: {} });
    expect(r).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rule 0, asserted over every verb rather than over a hand-picked sample.
//
// The fixture seats ONE user in every entity key the resolver reads (the full str()/strArr()
// list) and in every role, so each verb's own recipients resolve to that user whichever door
// it goes through. Both directions are asserted, and the positive half is not optional: the
// switch ends in `default: break`, so "this verb returned nobody" is also what a verb with no
// case at all looks like, and what a recipient key the fixture forgot to seat looks like. The
// negative assertion alone would sit green through either.
// ──────────────────────────────────────────────────────────────────────────────

const EVERYONE = 'u1';

/** Every key resolveRecipients reads via str() / strArr(), all pointing at one user. */
const fullEntity: Record<string, unknown> = {
  id: 'x1',
  commission_owner_id: EVERYONE,
  previous_owner_id: EVERYONE,
  sold_by_id: EVERYONE,
  customer_owner_id: EVERYONE,
  thread_assignee_id: EVERYONE,
  created_by_id: EVERYONE,
  user_id: EVERYONE,
  assignee_ids: [EVERYONE],
  performer_ids: [EVERYONE],
  participant_user_ids: [EVERYONE],
  added_assignee_ids: [EVERYONE],
  added_watcher_ids: [EVERYONE],
  watcher_ids: [EVERYONE],
  removed_ids: [EVERYONE],
  recipient_ids: [EVERYONE],
  approver_ids: [EVERYONE],
};

const everyRole = { ADMIN: [EVERYONE], DISPATCHER: [EVERYONE], SALES: [EVERYONE], TECHNICIAN: [EVERYONE] };

const allVerbs = Object.keys(VERB_RULES) as KnownVerb[];
const nonSelfVerbs = allVerbs.filter((v) => VERB_RULES[v].family !== 'self');
const selfVerbs = allVerbs.filter((v) => VERB_RULES[v].family === 'self');

/**
 * Verbs that legitimately reach nobody even with every recipient field seated. Empty today,
 * and it stays a named list rather than a silent `if` so that adding one is a review event:
 * every entry has to state why that verb has an audience of zero under a full fixture.
 */
const REACHES_NOBODY_UNDER_A_FULL_FIXTURE: Partial<Record<KnownVerb, string>> = {};

describe('resolveRecipients - Rule 0 across every verb', () => {
  it('with the actor seated in every recipient field, no non-self verb returns anyone', () => {
    for (const verb of nonSelfVerbs) {
      const r = resolveRecipients({
        verb, organizationId: 'org1', actorId: EVERYONE, entity: fullEntity, roleHolders: everyRole,
      });
      expect(r, `${verb} told the actor about their own action`).toEqual([]);
    }
  });

  it('with a different actor, every non-self verb returns at least one recipient', () => {
    for (const verb of nonSelfVerbs) {
      const r = resolveRecipients({
        verb, organizationId: 'org1', actorId: 'someone-else', entity: fullEntity, roleHolders: everyRole,
      });
      const reason = REACHES_NOBODY_UNDER_A_FULL_FIXTURE[verb];
      if (reason) {
        expect(r, `${verb} is allowlisted (${reason}) but reached someone`).toEqual([]);
        continue;
      }
      // A failure here is one of two things, and they look identical from the outside:
      // the verb has no case in the switch, or it reads an entity key fullEntity does not
      // seat. Either way the negative assertion above is passing vacuously for it.
      expect(r.length, `${verb} reached nobody - missing switch case, or an unseated entity key`)
        .toBeGreaterThan(0);
      expect(r.map((x) => x.userId)).toContain(EVERYONE);
    }
  });

  // The timing axis is a label, not a branch. Both cron reminders go through exactly the same
  // dedupe() call as the other 59 verbs; a null actor simply gives it nothing to drop.
  it('a time-driven invoice reminder resolves to the admins and the commission owner with a null actor', () => {
    for (const verb of ['billing.invoice_overdue', 'billing.invoice_due_soon']) {
      const r = resolveRecipients({ ...base, verb, actorId: null,
        entity: { id: 'i1', customer_owner_id: 'sales1' } });
      expect(r.map((x) => x.userId).sort(), verb).toEqual(['admin1', 'sales1']);
      expect(r.every((x) => x.needs_action), `${verb} carries SEND_REMINDER`).toBe(true);
    }
  });

  // Story 2, stated honestly: one RULE across entities, not one recipient list. The two verbs
  // drop the completer identically because both go through dedupe(); they reach different
  // people because a job carries a dispatch duty (VERB_RULES marks job.* `duty`) and a task
  // does not (task.* is `involvement`). Equalising the two would be a product change.
  it('a completed task and a completed job drop the completer the same way', () => {
    const completer = 'tech1';

    const task = resolveRecipients({ ...base, verb: 'task.completed', actorId: completer,
      entity: { id: 't1', assignee_ids: ['tech1', 'tech2'], watcher_ids: ['sales1'] } });
    const job = resolveRecipients({ ...base, verb: 'job.completed', actorId: completer,
      entity: { id: 'j1', assignee_ids: ['tech1', 'tech2'], sold_by_id: 'sales1' } });

    expect(task.map((x) => x.userId)).not.toContain(completer);
    expect(job.map((x) => x.userId)).not.toContain(completer);
    // ...and the other assignee is still told in both cases, so the drop is the completer's
    // alone rather than the whole roster falling out.
    expect(task.map((x) => x.userId)).toContain('tech2');
    expect(job.map((x) => x.userId)).toContain('tech2');
    // The declared difference: the job reaches dispatch, the task does not.
    expect(job.map((x) => x.userId)).toContain('disp1');
    expect(task.map((x) => x.userId)).not.toContain('disp1');
  });

  it('with the actor seated in every recipient field, every self verb still returns them', () => {
    expect(selfVerbs.length).toBeGreaterThan(0);
    for (const verb of selfVerbs) {
      const r = resolveRecipients({
        verb, organizationId: 'org1', actorId: EVERYONE, entity: fullEntity, roleHolders: everyRole,
      });
      expect(r.map((x) => x.userId), `${verb} dropped its own recipient`).toContain(EVERYONE);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────

// communication.email_inbound — a customer reply landing in the shared inbox.
//
// A thread is owned ("assigned to one, visible to all", slice 8b), so the reply
// goes to whoever holds it rather than interrupting the whole office. Only when
// nobody holds it does it fall back to the room, matching sms_inbound.
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — communication.email_inbound', () => {
  it('routes a reply to the thread assignee, and to nobody else', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r).toEqual([{ userId: 'tech1', priority: 'INTERRUPT', needs_action: false }]);
  });

  it('falls back to dispatcher + admin when the thread is unassigned', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
    // The room gets a feed entry, not an interrupt - nobody owns this yet, so
    // there is no one it is urgent FOR.
    expect(r.find(x => x.priority === 'INTERRUPT')).toBeUndefined();
  });

  it('does not also notify the room when the thread IS assigned', () => {
    // The whole point of assignment. An assignee plus a broadcast would make
    // ownership decorative.
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('falls back to the room when the assignee is the actor', () => {
    // dedupe() drops the actor. Without a fallback the reply would notify
    // nobody at all - worse than notifying too many.
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound', actorId: 'tech1',
      entity: { id: 'em1', thread_assignee_id: 'tech1' } });
    expect(r.map(x => x.userId).sort()).toEqual(['admin1', 'disp1']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// automation.message outlives the automation engine's in-app step
// ──────────────────────────────────────────────────────────────────────────────
// Asserted from the test file on purpose: resolveRecipients.ts is not edited by the
// retirement, and this pins that its case was not deleted alongside the executor.
describe('automation.message routes to its pre-resolved recipients', () => {
  it('notifies exactly the ids the caller passed, at INTERRUPT', () => {
    const r = resolveRecipients({
      ...base,
      verb: 'automation.message',
      entity: { id: 'wf1', recipient_ids: ['tech1', 'disp1'] },
    });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toHaveLength(2);
  });

  it('notifies nobody when no ids are passed - no role fallback', () => {
    const r = resolveRecipients({ ...base, verb: 'automation.message', entity: { id: 'wf1' } });
    expect(r).toEqual([]);
  });
});
