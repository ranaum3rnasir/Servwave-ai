import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTemplate, isKnownVerb, VERB_RULES, type KnownVerb } from '../templates';

// ──────────────────────────────────────────────────────────────────────────────
// Brief verbatim tests (task-1.2-brief.md)
// ──────────────────────────────────────────────────────────────────────────────

describe('renderTemplate — brief verbatim tests', () => {
  it('renders estimate.approved', () => {
    const t = renderTemplate('estimate.approved', { object_label: 'E0042', customer_name: 'Acme', amount: '4200' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', action_type: 'SCHEDULE_JOB', needs_action: true });
    expect(t.title).toContain('E0042');
  });

  it('renders dispatch.job_assigned as informational interrupt', () => {
    const t = renderTemplate('dispatch.job_assigned', { object_label: 'J0123' });
    expect(t).toMatchObject({ category: 'DISPATCH', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });

  // INVERTED by the multi-assignee change: task.assigned is no longer deferred. This
  // assertion is the load-bearing one for design §5 — emit() silently returns [] on an
  // unregistered verb, so an un-inverted `false` here would sit green while the whole
  // notification feature delivered nothing.
  it('isKnownVerb true for task.assigned (no longer deferred)', () => {
    expect(isKnownVerb('task.assigned')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unknown verb throws
// ──────────────────────────────────────────────────────────────────────────────

describe('renderTemplate — unknown verb', () => {
  it('throws for an unknown verb', () => {
    expect(() => renderTemplate('unknown.verb', {})).toThrow();
  });

  it('throws for deferred billing.payment_failed', () => {
    expect(() => renderTemplate('billing.payment_failed', {})).toThrow();
  });

  it('throws for deferred service_plan.renewal_due', () => {
    expect(() => renderTemplate('service_plan.renewal_due', {})).toThrow();
  });

  it('throws for deferred estimate.viewed', () => {
    expect(() => renderTemplate('estimate.viewed', {})).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isKnownVerb
// ──────────────────────────────────────────────────────────────────────────────

describe('isKnownVerb', () => {
  it('returns true for registered verbs', () => {
    expect(isKnownVerb('lead.assigned')).toBe(true);
    expect(isKnownVerb('estimate.approved')).toBe(true);
    expect(isKnownVerb('dispatch.job_assigned')).toBe(true);
    expect(isKnownVerb('job.started')).toBe(true);
    expect(isKnownVerb('billing.payment_received')).toBe(true);
    expect(isKnownVerb('team.ot_override_requested')).toBe(true);
    expect(isKnownVerb('inventory.stock_approval_requested')).toBe(true);
    expect(isKnownVerb('security.new_signin')).toBe(true);
  });

  // Design §9 guard #2 — all five task verbs must be registered, or emit() no-ops silently.
  it('returns true for all five task verbs', () => {
    for (const verb of ['task.assigned', 'task.watching', 'task.completed', 'task.removed', 'task.deleted']) {
      expect(isKnownVerb(verb)).toBe(true);
    }
  });

  it('returns false for deferred verbs', () => {
    // task.due_soon / task.overdue stay deferred on purpose — they need a cron that
    // does not exist. The other five task verbs are registered (see above).
    expect(isKnownVerb('task.overdue')).toBe(false);
    expect(isKnownVerb('task.due_soon')).toBe(false);
    expect(isKnownVerb('billing.payment_failed')).toBe(false);
    expect(isKnownVerb('service_plan.renewal_due')).toBe(false);
    expect(isKnownVerb('estimate.viewed')).toBe(false);
    expect(isKnownVerb('estimate.delivery_failed')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// VERB_RULES - the family/timing classification beside the registry
//
// Coverage is COMPILER-enforced, not test-enforced: `VERB_RULES` is declared
// `Record<KnownVerb, VerbRule>` over the registry's own literal keys, so a missing
// entry and a stray entry are both `tsc -b` failures. These tests therefore cover
// only what the type system cannot express, and each one is load-bearing for the
// same reason the assertion at :20-26 is - emit() silently returns [] on an
// unregistered verb, so a wrong rule here would sit green while the bell quietly
// told the wrong people (or nobody).
// ──────────────────────────────────────────────────────────────────────────────

describe('VERB_RULES', () => {
  const verbs = Object.keys(VERB_RULES) as KnownVerb[];

  // The `self` family is the ONE named exception to Rule 0, and the resolver reads it
  // to decide whether to drop the actor. Reclassifying a security verb would silently
  // re-arm the very case the exemption exists for: an attacker holding your session
  // appears to be the actor, and the alert about them must still reach you.
  it('every security.* verb is classified self', () => {
    const security = verbs.filter((v) => v.startsWith('security.'));
    expect(security).toHaveLength(4);
    for (const verb of security) {
      expect(VERB_RULES[verb].family).toBe('self');
    }
  });

  // `exception` is a justification, not an escape hatch. The compiler can make the field
  // optional but it cannot make a present one non-empty, so '' would read as "there is an
  // exception here" while saying nothing about what it is.
  it('no verb rule carries an empty exception string', () => {
    for (const verb of verbs) {
      const { exception } = VERB_RULES[verb];
      if (exception !== undefined) {
        expect(exception.trim().length, `${verb} has an empty exception`).toBeGreaterThan(0);
      }
    }
  });

  // Pins the CORRECTED timing definition against the wrong one Spec A states. `event` does
  // NOT mean "has an actor": twelve event verbs never carry one, because a webhook or a
  // system detector is the cause. Only a sweep is `time`, and there are exactly two sweeps
  // (invoiceDueCron.ts:65-80). If this list ever needs editing, the emit sites moved.
  it('only the two cron-emitted invoice reminders are time-driven, and every always-actorless event verb names itself in an exception', () => {
    const timeDriven = verbs.filter((v) => VERB_RULES[v].timing === 'time');
    expect(timeDriven.sort()).toEqual(['billing.invoice_due_soon', 'billing.invoice_overdue']);

    // Re-derived from the emit sites, not from Spec A's draft list, which named eleven and
    // got three wrong (estimate.approved, estimate.deposit_paid and billing.payment_received
    // all have an actor-bearing staff door) while missing the four Stripe account-lifecycle
    // verbs.
    const alwaysActorless: KnownVerb[] = [
      'billing.disputed',
      'billing.chargeback',
      'billing.payments_activated',
      'billing.payouts_activated',
      'billing.payments_action_needed',
      'billing.payments_paused',
      'billing.payouts_pending_first_payment',
      'billing.platform_fee_rate_changed',
      'inventory.low_stock',
      'communication.call_missed',
      'communication.sms_inbound',
      'communication.email_inbound',
    ];
    for (const verb of alwaysActorless) {
      expect(VERB_RULES[verb].timing, `${verb} is emitted at a call site, not by a sweep`).toBe('event');
      expect(VERB_RULES[verb].exception, `${verb} must record that its only paths are actorless`).toBeTruthy();
    }
  });

  // An exception string is a justification, and the only one that hands the reader a call
  // site is automation.message's - the Test dialog's send-to-me receipt, which is also the
  // line ADR 0005 and the scenarios reference each cite by number. A file:line rots in
  // silence, and a stale one here makes this map tell a third story about the same emit.
  // Pin the citation to the line it claims.
  it('the automation.message exception cites the Test dialog emit at its real line', () => {
    const { exception } = VERB_RULES['automation.message'];
    const cited = /workflow\.controller\.ts:(\d+)/.exec(exception ?? '');
    expect(cited, 'the exception must cite the Test dialog call site').not.toBeNull();

    const controller = readFileSync(
      resolve(__dirname, '..', '..', '..', 'controllers', 'workflow.controller.ts'),
      'utf8',
    ).split('\n');
    expect(controller[Number(cited![1]) - 1]).toContain("verb: 'automation.message'");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// One test per category — representative verbs
// ──────────────────────────────────────────────────────────────────────────────

describe('renderTemplate — LEAD category', () => {
  it('lead.assigned → LEAD category, object_type LEAD, INTERRUPT, no action_type', () => {
    const t = renderTemplate('lead.assigned', { object_label: 'L0001', customer_name: 'Smith HVAC' });
    expect(t).toMatchObject({ category: 'LEAD', object_type: 'LEAD', priority: 'INTERRUPT', action_type: null, needs_action: false });
    expect(t.title).toContain('L0001');
  });

  it('lead.unassigned_created → LEAD, FEED', () => {
    const t = renderTemplate('lead.unassigned_created', { object_label: 'L0002', customer_name: 'Jones' });
    expect(t).toMatchObject({ category: 'LEAD', object_type: 'LEAD', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('lead.reassigned_away → LEAD, FEED', () => {
    const t = renderTemplate('lead.reassigned_away', { object_label: 'L0003' });
    expect(t).toMatchObject({ category: 'LEAD', object_type: 'LEAD', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('lead.walkthrough_scheduled → LEAD, INTERRUPT, no action_type', () => {
    const t = renderTemplate('lead.walkthrough_scheduled', { object_label: 'L0004', customer_name: 'A Corp' });
    expect(t).toMatchObject({ category: 'LEAD', object_type: 'LEAD', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — ESTIMATE category', () => {
  it('estimate.approved → ESTIMATE, INTERRUPT, SCHEDULE_JOB, needs_action', () => {
    const t = renderTemplate('estimate.approved', { object_label: 'E0010', customer_name: 'Acme' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', priority: 'INTERRUPT', action_type: 'SCHEDULE_JOB', needs_action: true });
    expect(t.title).toContain('E0010');
  });

  it('estimate.declined → ESTIMATE, INTERRUPT, no action_type', () => {
    const t = renderTemplate('estimate.declined', { object_label: 'E0011' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });

  it('estimate.deposit_paid → ESTIMATE, INTERRUPT, SCHEDULE_JOB', () => {
    const t = renderTemplate('estimate.deposit_paid', { object_label: 'E0012', amount: '500' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', priority: 'INTERRUPT', action_type: 'SCHEDULE_JOB', needs_action: true });
  });

  it('estimate.cancelled → ESTIMATE, FEED, no action_type', () => {
    const t = renderTemplate('estimate.cancelled', { object_label: 'E0013' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('estimate.deposit_waived → ESTIMATE, FEED', () => {
    const t = renderTemplate('estimate.deposit_waived', { object_label: 'E0014' });
    expect(t).toMatchObject({ category: 'ESTIMATE', object_type: 'ESTIMATE', priority: 'FEED', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — DISPATCH category', () => {
  it('dispatch.job_assigned → DISPATCH, INTERRUPT, no action_type', () => {
    const t = renderTemplate('dispatch.job_assigned', { object_label: 'J0050' });
    expect(t).toMatchObject({ category: 'DISPATCH', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
    expect(t.title).toContain('J0050');
  });

  it('dispatch.job_unassigned → DISPATCH, INTERRUPT', () => {
    const t = renderTemplate('dispatch.job_unassigned', { object_label: 'J0051' });
    expect(t).toMatchObject({ category: 'DISPATCH', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });

  it('dispatch.job_rescheduled → DISPATCH, INTERRUPT', () => {
    const t = renderTemplate('dispatch.job_rescheduled', { object_label: 'J0052' });
    expect(t).toMatchObject({ category: 'DISPATCH', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });

  it('dispatch.job_created → DISPATCH, INTERRUPT', () => {
    const t = renderTemplate('dispatch.job_created', { object_label: 'J0053', customer_name: 'Acme Co' });
    expect(t).toMatchObject({ category: 'DISPATCH', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — JOB category', () => {
  it('job.started → JOB, FEED, no action_type', () => {
    const t = renderTemplate('job.started', { object_label: 'J0100' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toContain('J0100');
  });

  it('job.completed → JOB, FEED', () => {
    const t = renderTemplate('job.completed', { object_label: 'J0101' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('job.cancelled → JOB, INTERRUPT (tech gets INTERRUPT)', () => {
    const t = renderTemplate('job.cancelled', { object_label: 'J0102' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
  });

  it('job.reopened → JOB, FEED', () => {
    const t = renderTemplate('job.reopened', { object_label: 'J0103' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — BILLING category', () => {
  it('billing.payment_received → BILLING, FEED, no action_type', () => {
    const t = renderTemplate('billing.payment_received', { object_label: 'I0001', amount: '1200', customer_name: 'Acme' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toContain('I0001');
  });

  it('billing.partial_payment → BILLING, FEED', () => {
    const t = renderTemplate('billing.partial_payment', { object_label: 'I0002', amount: '600' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('billing.invoice_overdue → BILLING, FEED, SEND_REMINDER, needs_action', () => {
    const t = renderTemplate('billing.invoice_overdue', { object_label: 'I0003' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: 'SEND_REMINDER', needs_action: true });
  });

  it('billing.invoice_due_soon → BILLING, FEED, SEND_REMINDER, needs_action', () => {
    const t = renderTemplate('billing.invoice_due_soon', { object_label: 'I0004' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: 'SEND_REMINDER', needs_action: true });
  });

  it('billing.refunded → BILLING, INTERRUPT, VIEW', () => {
    const t = renderTemplate('billing.refunded', { object_label: 'I0005', amount: '300' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
  });

  it('billing.disputed → BILLING, INTERRUPT, VIEW', () => {
    const t = renderTemplate('billing.disputed', { object_label: 'I0006' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
  });

  it('billing.chargeback → BILLING, INTERRUPT, VIEW', () => {
    const t = renderTemplate('billing.chargeback', { object_label: 'I0007', amount: '900' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
  });

  it('billing.voided → BILLING, FEED, no action_type', () => {
    const t = renderTemplate('billing.voided', { object_label: 'I0008' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('billing.credit_applied → BILLING, FEED', () => {
    const t = renderTemplate('billing.credit_applied', { object_label: 'I0009', amount: '150' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'INVOICE', priority: 'FEED', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — BILLING category (payments-account lifecycle, Task 1.8)', () => {
  it('billing.payments_activated → BILLING, FEED, ORGANIZATION', () => {
    const t = renderTemplate('billing.payments_activated', { object_label: 'Acme' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe('ServWave Payments is active — you can take card payments now.');
  });

  it('billing.payouts_activated → BILLING, FEED, ORGANIZATION', () => {
    const t = renderTemplate('billing.payouts_activated', { object_label: 'Acme' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe('Payouts enabled — your bank is connected.');
  });

  it('billing.payments_action_needed → INTERRUPT, needs_action, VIEW; body carries requirements when supplied', () => {
    const t = renderTemplate('billing.payments_action_needed', { requirements: 'individual.verification.document' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('Stripe needs one more thing to keep your payments running.');
    expect(t.body).toBe('individual.verification.document');
  });

  it('billing.payments_paused → INTERRUPT, needs_action, VIEW; body carries reason when supplied', () => {
    const t = renderTemplate('billing.payments_paused', { reason: 'requirements.past_due' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('Card payments are paused — Stripe needs more information.');
    expect(t.body).toBe('requirements.past_due');
  });

  it('billing.payments_action_needed / billing.payments_paused omit body when no requirements/reason supplied (matches the actual Task 1.6 emitPaymentsNotif call shape — no extra `data` is passed)', () => {
    expect(renderTemplate('billing.payments_action_needed', { object_label: 'Acme' }).body).toBeUndefined();
    expect(renderTemplate('billing.payments_paused', { object_label: 'Acme' }).body).toBeUndefined();
  });

  // ── deferred-bank first-payment nudge (Task 1.9, §6.6/§6.8) ──
  it('billing.payouts_pending_first_payment → BILLING, FEED, ORGANIZATION; title + body carry the collected amount', () => {
    const t = renderTemplate('billing.payouts_pending_first_payment', { amount: '$500.00' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe("You've collected $500.00. Connect your bank to get paid out.");
    expect(t.body).toBe('$500.00');
  });

  it('billing.payouts_pending_first_payment falls back to generic wording when no amount is supplied', () => {
    const t = renderTemplate('billing.payouts_pending_first_payment', { object_label: 'Acme' });
    expect(t.title).toBe("You've collected a payment. Connect your bank to get paid out.");
    expect(t.body).toBeUndefined();
  });

  // ── within-ceiling rate-change notice (Task 4.3, §3.6) ──
  it('billing.platform_fee_rate_changed → BILLING, FEED, ORGANIZATION; title + body carry the new rate + effective date', () => {
    const t = renderTemplate('billing.platform_fee_rate_changed', { new_rate: '0.75%', effective_date: 'August 20, 2026' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe('Your ServWave Payments rate is changing to 0.75%.');
    expect(t.body).toBe('Effective August 20, 2026. No action is needed.');
  });

  it('billing.platform_fee_rate_changed falls back to generic wording when no new_rate/effective_date is supplied', () => {
    const t = renderTemplate('billing.platform_fee_rate_changed', { object_label: 'Acme' });
    expect(t.title).toBe('Your ServWave Payments rate is changing to a new rate.');
    expect(t.body).toBeUndefined();
  });
});

describe('renderTemplate — TEAM category', () => {
  it('team.ot_override_requested → TEAM, INTERRUPT, APPROVE_OT, object_type TIME_ENTRY, needs_action', () => {
    const t = renderTemplate('team.ot_override_requested', { object_label: 'T0001', actor_name: 'Bob' });
    expect(t).toMatchObject({ category: 'TEAM', object_type: 'TIME_ENTRY', priority: 'INTERRUPT', action_type: 'APPROVE_OT', needs_action: true });
  });

  it('team.invite_accepted → TEAM, FEED, object_type USER', () => {
    const t = renderTemplate('team.invite_accepted', { actor_name: 'Jane Doe' });
    expect(t).toMatchObject({ category: 'TEAM', object_type: 'USER', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toContain('Jane Doe');
  });
});

describe('renderTemplate — INVENTORY category', () => {
  it('inventory.stock_approval_requested → INVENTORY, INTERRUPT, APPROVE_STOCK, object_type STOCK_APPROVAL', () => {
    const t = renderTemplate('inventory.stock_approval_requested', { item_name: 'Filter 12x24', object_label: 'REQ-001' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'STOCK_APPROVAL', priority: 'INTERRUPT', action_type: 'APPROVE_STOCK', needs_action: true });
  });

  it('inventory.low_stock → INVENTORY, FEED, object_type INVENTORY_ITEM', () => {
    const t = renderTemplate('inventory.low_stock', { item_name: 'Filter 12x24' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'INVENTORY_ITEM', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('inventory.backorder → INVENTORY, FEED, object_type INVENTORY_ITEM', () => {
    const t = renderTemplate('inventory.backorder', { item_name: 'Capacitor 45/5' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'INVENTORY_ITEM', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('inventory.staging_ready → INVENTORY, FEED, object_type JOB_STAGE', () => {
    const t = renderTemplate('inventory.staging_ready', { object_label: 'J0200', item_name: 'Parts kit' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'JOB_STAGE', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('inventory.staging_no_area → INVENTORY, FEED, object_type JOB_STAGE', () => {
    const t = renderTemplate('inventory.staging_no_area', { object_label: 'J0201' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'JOB_STAGE', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('inventory.po_partial → INVENTORY, FEED, object_type PURCHASE_ORDER', () => {
    const t = renderTemplate('inventory.po_partial', { object_label: 'PO-007', item_name: 'Capacitor' });
    expect(t).toMatchObject({ category: 'INVENTORY', object_type: 'PURCHASE_ORDER', priority: 'FEED', action_type: null, needs_action: false });
  });
});

describe('renderTemplate — SECURITY category', () => {
  it('security.new_signin → SECURITY, FEED, object_type USER', () => {
    const t = renderTemplate('security.new_signin', { actor_name: 'Bob' });
    expect(t).toMatchObject({ category: 'SECURITY', object_type: 'USER', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('security.password_changed → SECURITY, FEED', () => {
    const t = renderTemplate('security.password_changed', {});
    expect(t).toMatchObject({ category: 'SECURITY', object_type: 'USER', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('security.mfa_enabled → SECURITY, FEED', () => {
    const t = renderTemplate('security.mfa_enabled', {});
    expect(t).toMatchObject({ category: 'SECURITY', object_type: 'USER', priority: 'FEED', action_type: null, needs_action: false });
  });

  it('security.mfa_disabled → SECURITY, FEED', () => {
    const t = renderTemplate('security.mfa_disabled', {});
    expect(t).toMatchObject({ category: 'SECURITY', object_type: 'USER', priority: 'FEED', action_type: null, needs_action: false });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Graceful data handling — missing fields should not produce "undefined"
// ──────────────────────────────────────────────────────────────────────────────

describe('renderTemplate — graceful missing data fields', () => {
  it('estimate.approved with no data fields does not output "undefined" in title', () => {
    const t = renderTemplate('estimate.approved', {});
    expect(t.title).not.toContain('undefined');
  });

  it('billing.payment_received with no data fields does not output "undefined" in title', () => {
    const t = renderTemplate('billing.payment_received', {});
    expect(t.title).not.toContain('undefined');
  });

  it('team.invite_accepted with no actor_name does not output "undefined" in title', () => {
    const t = renderTemplate('team.invite_accepted', {});
    expect(t.title).not.toContain('undefined');
  });

  it('inventory.stock_approval_requested with no item_name does not output "undefined" in title', () => {
    const t = renderTemplate('inventory.stock_approval_requested', {});
    expect(t.title).not.toContain('undefined');
  });
});

describe('renderTemplate — communication.email_inbound', () => {
  it('names the sender and previews the subject', () => {
    const t = renderTemplate('communication.email_inbound', {
      customer_name: 'Dana Ops',
      subject: 'Re: Quote for the vault re-key',
    });
    expect(t).toMatchObject({
      category: 'COMMUNICATION',
      object_type: 'EMAIL_THREAD',
      needs_action: false,
      action_type: null,
    });
    expect(t.title).toContain('Dana Ops');
    expect(t.body).toBe('Re: Quote for the vault re-key');
  });

  it('falls back to the sender address when the customer is unknown', () => {
    // An inbound reply frequently has no Customer row behind it - the address
    // is all we have, and it is more use than "Unknown".
    const t = renderTemplate('communication.email_inbound', {
      object_label: 'dana@example.com',
      subject: 'Re: Quote',
    });
    expect(t.title).toContain('dana@example.com');
  });

  it('survives a reply with no subject at all', () => {
    const t = renderTemplate('communication.email_inbound', { customer_name: 'Dana Ops' });
    expect(t.title).toContain('Dana Ops');
    expect(t.body).toBeUndefined();
  });

  it('is a known verb', () => {
    expect(isKnownVerb('communication.email_inbound')).toBe(true);
  });
});
