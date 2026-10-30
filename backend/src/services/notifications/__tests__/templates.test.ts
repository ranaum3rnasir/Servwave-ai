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

  it('renders spider.starting_summary with the sweep\'s title and body, on the feed (no toast), as a summary object', () => {
    const t = renderTemplate('spider.starting_summary', {
      title: 'Spider is on. 12 of your leads were already past their limit.',
      body: 'Your starting summary',
    });
    expect(t).toMatchObject({
      category: 'LEAD',
      object_type: 'SPIDER_SUMMARY',
      priority: 'FEED',
      needs_action: false,
      title: 'Spider is on. 12 of your leads were already past their limit.',
      body: 'Your starting summary',
    });
  });

  it("renders spider.alert with the contractor's title, body and FEED priority", () => {
    const t = renderTemplate('spider.alert', {
      object_label: 'L00042', customer_name: 'Pat Payer',
      title: 'Spider Alert - Pat Payer (L00042)', body: 'This lead was created 2 days ago and has not yet been contacted.',
    });
    expect(t).toMatchObject({
      category: 'LEAD', object_type: 'LEAD', priority: 'FEED', action_type: null, needs_action: false,
      title: 'Spider Alert - Pat Payer (L00042)', body: 'This lead was created 2 days ago and has not yet been contacted.',
    });
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
    expect(isKnownVerb('team.invite_accepted')).toBe(true);
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
  // (invoiceDueCron.ts:65-80) plus Spider's lead-watcher sweep (services/spider/sweep.ts,
  // #2619), which also emits the starting summary (#2794). If this list ever needs editing, the emit sites moved.
  it('only the cron-emitted invoice reminders and the Spider sweep are time-driven, and every always-actorless event verb names itself in an exception', () => {
    const timeDriven = verbs.filter((v) => VERB_RULES[v].timing === 'time');
    expect(timeDriven.sort()).toEqual(['billing.invoice_due_soon', 'billing.invoice_overdue', 'spider.alert', 'spider.starting_summary']);

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
      'billing.payments_disconnected',
      'billing.payouts_pending_first_payment',
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

  it('lead.unassigned_created is named "New lead with no owner" and never says "unassigned" or "assigned to"', () => {
    const named = renderTemplate('lead.unassigned_created', { object_label: 'L0002', customer_name: 'Jones' });
    const bare = renderTemplate('lead.unassigned_created', {});
    for (const t of [named, bare]) {
      expect(t.title.startsWith('New lead with no owner')).toBe(true);
      expect(`${t.title} ${t.body ?? ''}`).not.toMatch(/unassigned|assigned to/i);
    }
  });

  // S06.26: the people covering for a missing Dispatcher are told why, as the alert's body, on every verb the chain moved.
  it.each([
    ['lead.unassigned_created', {}],
    ['lead.walkthrough_scheduled', {}],
    ['estimate.declined', {}],
    ['estimate.cancelled', {}],
    ['estimate.deposit_waived', {}],
    ['estimate.approval_voided', {}],
    ['estimate.status_corrected', {}],
    ['estimate.approved', { options_chosen: 'Gate opener' }],
    ['estimate.deposit_paid', { amount: '500' }],
  ])('%s carries the why line as its body when there is one, and no body when there is none', (verb, extra) => {
    const withLine = renderTemplate(verb, { object_label: 'X0001', ...extra, fallback_reason: 'This lead has no Dispatcher.' });
    expect((withLine.body ?? '').split('\n')).toContain('This lead has no Dispatcher.');
    const without = renderTemplate(verb, { object_label: 'X0001', fallback_reason: '' });
    expect(without.body ?? '').not.toContain('Dispatcher');
    if (!Object.keys(extra).length) expect(without.body).toBeUndefined();
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

  // S06.27: one event, two wordings. The person named reads "assigned to you"; everyone else the chain reaches reads who it was.
  it('dispatch.job_assigned names who was assigned when the alert is for someone else', () => {
    expect(renderTemplate('dispatch.job_assigned', { object_label: 'J0050', assigned_names: ['Dana Reyes'] }).title)
      .toBe('Dana Reyes was assigned to J0050');
    expect(renderTemplate('dispatch.job_assigned', { object_label: 'J0050', assigned_names: ['Dana Reyes', 'Sam Lee'] }).title)
      .toBe('Dana Reyes and Sam Lee were assigned to J0050');
    expect(renderTemplate('dispatch.job_assigned', { object_label: 'J0050', assigned_names: ['Dana', 'Sam', 'Lee'] }).title)
      .toBe('Dana, Sam and Lee were assigned to J0050');
    // ...and the "you" wording is what an alert that names nobody says.
    expect(renderTemplate('dispatch.job_assigned', { object_label: 'J0050', assigned_names: [] }).title).toBe('J0050 assigned to you');
  });

  it('the scheduling and parts alerts carry the why line as their body, and nothing else', () => {
    for (const verb of ['dispatch.job_assigned', 'dispatch.job_rescheduled', 'dispatch.job_created', 'inventory.staging_ready']) {
      expect(renderTemplate(verb, { object_label: 'J0050', fallback_reason: 'This job has no Dispatcher.' }).body, verb)
        .toBe('This job has no Dispatcher.');
      expect(renderTemplate(verb, { object_label: 'J0050', fallback_reason: '' }).body, verb).toBeUndefined();
    }
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
    expect(t.title).toBe('J0100 started');
    expect(t.body).toBeUndefined();
  });

  it('job.completed → JOB, FEED, says the job is ready for office review', () => {
    const t = renderTemplate('job.completed', { object_label: 'J0101' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe('Job completed: J0101 is ready for office review');
    expect(t.body).toBeUndefined();
  });

  it('job.completed carries the why line only when one is given', () => {
    expect(renderTemplate('job.completed', { object_label: 'J0101', fallback_reason: 'This job has no Dispatcher.' }).body)
      .toBe('This job has no Dispatcher.');
    expect(renderTemplate('job.completed', { object_label: 'J0101', fallback_reason: '' }).body).toBeUndefined();
  });

  it('job.ready_to_close → "<job> is ready to close", FEED, asks someone to act; the why line only when one is given', () => {
    const t = renderTemplate('job.ready_to_close', { object_label: 'J0101' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: true });
    expect(t.title).toBe('J0101 is ready to close');
    expect(t.body).toBeUndefined();
    expect(renderTemplate('job.ready_to_close', { object_label: 'J0101', fallback_reason: 'Nobody who can close jobs can open this job.' }).body)
      .toBe('Nobody who can close jobs can open this job.');
  });

  it('job.review_attention → HIGH priority, the items one per line, then the why line', () => {
    const t = renderTemplate('job.review_attention', { object_label: 'J0101', items_text: 'A price was lowered: Line: Door\nA file was deleted: File: Front.png', fallback_reason: 'This job has no Dispatcher.' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
    expect(t.title).toBe('J0101 needs your attention');
    expect(t.body).toBe('A price was lowered: Line: Door\nA file was deleted: File: Front.png\nThis job has no Dispatcher.');
    expect(renderTemplate('job.review_attention', { object_label: 'J0101', items_text: 'A note was deleted: Note' }).body).toBe('A note was deleted: Note');
  });

  it('job.cancelled → JOB, INTERRUPT (tech gets INTERRUPT)', () => {
    const t = renderTemplate('job.cancelled', { object_label: 'J0102' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false });
    // A job is only ever cancelled, never lost.
    expect(t.title).toBe('J0102 cancelled');
    expect(t.title).not.toMatch(/lost/i);
  });

  it('job.reopened → JOB, FEED', () => {
    const t = renderTemplate('job.reopened', { object_label: 'J0103' });
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe('J0103 reopened');
  });

  it.each(['job.started', 'job.cancelled', 'job.reopened'])('%s carries the why line only when one is given', (verb) => {
    expect(renderTemplate(verb, { object_label: 'J0104', fallback_reason: 'This job has no Dispatcher.' }).body).toBe('This job has no Dispatcher.');
    expect(renderTemplate(verb, { object_label: 'J0104', fallback_reason: '' }).body).toBeUndefined();
  });

  it('there is no Job lost alert', () => {
    expect(isKnownVerb('job.lost')).toBe(false);
  });
});

describe('renderTemplate - mailbox.address_needed (S10.3)', () => {
  it('tells the new user, in the PRD\'s words, that they have no email address yet', () => {
    const t = renderTemplate('mailbox.address_needed', {});
    expect(t).toMatchObject({ category: 'TEAM', object_type: 'USER', priority: 'FEED', needs_action: false });
    expect(t.title).toBe("You don't have an email address yet. An admin needs to set one before you can send email.");
  });

  it('tells the people who edit users which person has none', () => {
    const t = renderTemplate('mailbox.address_needed_admin', { user_name: 'Jane Smith' });
    expect(t).toMatchObject({ category: 'TEAM', object_type: 'USER', priority: 'FEED' });
    expect(t.title).toBe('Jane Smith has no email address yet');
    expect(t.body).toContain('Users page');
  });

  it('does not print "undefined" when the name is missing, and names no provider', () => {
    const t = renderTemplate('mailbox.address_needed_admin', {});
    expect(t.title).not.toContain('undefined');
    for (const verb of ['mailbox.address_needed', 'mailbox.address_needed_admin'] as const) {
      const text = JSON.stringify(renderTemplate(verb, { user_name: 'Jane Smith' }));
      expect(text).not.toMatch(/resend|ctm|supabase|render|stripe|twilio/i);
    }
  });
});

describe('renderTemplate - job.visit_finished', () => {
  const data = { object_label: 'J00142', visit_seq: '2', actor_name: 'Dana' };

  it('names the visit, the job and the person who finished it', () => {
    const t = renderTemplate('job.visit_finished', data);
    expect(t).toMatchObject({ category: 'JOB', object_type: 'JOB', title: 'Visit 2 finished on J00142, by Dana', needs_action: false });
    expect(t.body).toBeUndefined();
  });

  it('says why a fallback person got it', () => {
    expect(renderTemplate('job.visit_finished', { ...data, fallback_reason: 'This job has no Dispatcher.' }).body)
      .toBe('This job has no Dispatcher.');
  });

  it('reads "All visits finished: ready to complete" and needs action when no live visit is left', () => {
    const t = renderTemplate('job.visit_finished', { ...data, all_finished: true, fallback_reason: 'This job has no Dispatcher.' });
    expect(t.title).toBe('All visits finished: ready to complete');
    expect(t.needs_action).toBe(true);
    expect(t.body).toBe('Visit 2 finished on J00142, by Dana. This job has no Dispatcher.');
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
    expect(t.title).toBe('Payouts enabled — your bank account is ready.');
  });

  it('billing.payments_action_needed → INTERRUPT, needs_action, VIEW; body carries what to do when supplied', () => {
    const t = renderTemplate('billing.payments_action_needed', { what_to_do: 'Upload the identity document.' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('ServWave Payments needs one more thing to keep your payments running.');
    expect(t.body).toBe('Upload the identity document.');
  });

  it('billing.payments_paused → INTERRUPT, needs_action, VIEW; body carries reason when supplied', () => {
    const t = renderTemplate('billing.payments_paused', { reason: 'requirements.past_due' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('Card payments are paused — ServWave Payments needs more information.');
    expect(t.body).toBe('requirements.past_due');
  });

  it('billing.payments_disconnected → INTERRUPT, needs_action, VIEW; names no processor', () => {
    const t = renderTemplate('billing.payments_disconnected', { object_label: 'Acme' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true });
    expect(t.title).toBe('ServWave Payments is turned off — online payments are off until it is set up again.');
  });

  it('billing.payments_action_needed / billing.payments_paused omit body when no requirements/reason supplied (matches the actual Task 1.6 emitPaymentsNotif call shape — no extra `data` is passed)', () => {
    expect(renderTemplate('billing.payments_action_needed', { object_label: 'Acme' }).body).toBeUndefined();
    expect(renderTemplate('billing.payments_paused', { object_label: 'Acme' }).body).toBeUndefined();
  });

  // ── deferred-bank first-payment nudge (Task 1.9, §6.6/§6.8) ──
  it('billing.payouts_pending_first_payment → BILLING, FEED, ORGANIZATION; names no amount (M4)', () => {
    const t = renderTemplate('billing.payouts_pending_first_payment', { amount: '$500.00' });
    expect(t).toMatchObject({ category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false });
    expect(t.title).toBe("You've collected a payment. Add your bank account to get paid out.");
    expect(t.body).toBeUndefined();
  });

  it('billing.payouts_pending_first_payment falls back to generic wording when no amount is supplied', () => {
    const t = renderTemplate('billing.payouts_pending_first_payment', { object_label: 'Acme' });
    expect(t.title).toBe("You've collected a payment. Add your bank account to get paid out.");
    expect(t.body).toBeUndefined();
  });
});

describe('renderTemplate — TEAM category', () => {
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

  it('says why a person covering for a record with nobody to take the reply was told', () => {
    const reason = 'This job has no Dispatcher or Sold By who can take this reply';
    const t = renderTemplate('communication.email_inbound', { customer_name: 'Dana Ops', subject: 'Re: Quote', fallback_reason: reason });
    expect(t.body).toBe(`Re: Quote\n${reason}`);
    // The reason stands alone for a reply with no subject.
    expect(renderTemplate('communication.email_inbound', { customer_name: 'Dana Ops', fallback_reason: reason }).body).toBe(reason);
  });

  it("tells a reply from an address we didn't send to in PRD 10's words, still previewing the subject", () => {
    const t = renderTemplate('communication.email_inbound', {
      customer_name: 'Dana Ops', subject: 'Re: Quote', unmatched_reply: true, link_path: '/communication/inbox?review=abc',
    });
    expect(t.title).toBe("A reply from an address we didn't send to - check and link it");
    expect(t.body).toBe('Re: Quote');
    expect(t.object_type).toBe('EMAIL_THREAD');
  });

  it('is a known verb', () => {
    expect(isKnownVerb('communication.email_inbound')).toBe(true);
  });
});

// S06.29: the alerts that have no record reach the Manage roles and permissions holders when nobody holds their switch, and say why.
describe('the why line on the alerts that have no record', () => {
  const verbs = [
    'billing.payments_activated', 'billing.payouts_activated', 'billing.payments_action_needed', 'billing.payments_paused',
    'billing.payments_disconnected', 'billing.payouts_pending_first_payment', 'team.invite_accepted',
    'inventory.stock_approval_requested', 'inventory.low_stock', 'inventory.backorder', 'inventory.staging_no_area', 'inventory.po_partial',
  ];

  it.each(verbs)('%s shows the why line under its title, and none when the person was told as a holder', (verb) => {
    const line = 'Nobody can edit stock.';
    expect(renderTemplate(verb, { object_label: 'X', fallback_reason: line }).body).toContain(line);
    expect(renderTemplate(verb, { object_label: 'X', fallback_reason: '' }).body ?? '').not.toContain(line);
  });

  it('keeps the words the alert already had above the why line', () => {
    const body = renderTemplate('inventory.low_stock', { item_name: 'Hinge', on_hand: 2, min: 4, fallback_reason: 'Nobody can create purchase orders.' }).body;
    expect(body).toBe('2 on hand (min 4)\nNobody can create purchase orders.');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// S08.24: the never-silent fallback of the call and text alerts
// ──────────────────────────────────────────────────────────────────────────────

describe('renderTemplate — the never-silent fallback of a call or text alert', () => {
  const reason = 'Nobody is linked to this number and nobody sees every call and text.';
  const facts = { fallback_reason: reason, company_number: '(555) 555-0142', occurred_at: 'October 12, 2026 at 7:05 PM' };

  it('names the company number in the title and the time in the body of a missed call told without caller details, then the reason', () => {
    const t = renderTemplate('communication.call_missed', { ...facts, call_status: 'missed', redacted: true, object_label: 'Pat Payer' });
    expect(t.title).toBe('Missed call on (555) 555-0142');
    expect(t.body).toBe(`October 12, 2026 at 7:05 PM\n${reason}`);
    expect(t).toMatchObject({ priority: 'INTERRUPT', needs_action: true, action_type: 'VIEW' });
    // Whatever the caller's data held, the title and body do not use it.
    expect(`${t.title} ${t.body}`).not.toContain('Pat Payer');
  });

  it('says Voicemail for a voicemail, and a text for a text', () => {
    expect(renderTemplate('communication.call_missed', { ...facts, call_status: 'voicemail', redacted: true }).title).toBe('Voicemail on (555) 555-0142');
    const text = renderTemplate('communication.sms_inbound', { ...facts, redacted: true, preview: 'Gate code 9931', customer_name: 'Pat Payer' });
    expect(text.title).toBe('New text on (555) 555-0142');
    expect(text.body).toBe(`October 12, 2026 at 7:05 PM\n${reason}`);
    expect(text).toMatchObject({ priority: 'FEED', needs_action: false });
    expect(`${text.title} ${text.body}`).not.toMatch(/9931|Pat Payer/);
  });

  it('keeps the ordinary title and the preview for a holder who can read it, with where and when and the reason below', () => {
    const call = renderTemplate('communication.call_missed', { ...facts, call_status: 'missed', customer_name: 'Pat Payer' });
    expect(call.title).toBe('Missed call — Pat Payer');
    expect(call.body).toBe(`On (555) 555-0142, October 12, 2026 at 7:05 PM\n${reason}`);
    const text = renderTemplate('communication.sms_inbound', { ...facts, customer_name: 'Pat Payer', preview: 'Gate code 9931' });
    expect(text.title).toBe('New text — Pat Payer');
    expect(text.body).toBe(`Gate code 9931\nOn (555) 555-0142, October 12, 2026 at 7:05 PM\n${reason}`);
  });

  it('says "a company number" when the number is not one of the company\'s own, and never prints undefined', () => {
    const t = renderTemplate('communication.sms_inbound', { fallback_reason: reason, occurred_at: 'October 12, 2026 at 7:05 PM', redacted: true });
    expect(t.title).toBe('New text on a company number');
    expect(`${t.title} ${t.body}`).not.toContain('undefined');
  });

  it('leaves the ordinary alerts as they were: no body for a call, the preview alone for a text', () => {
    expect(renderTemplate('communication.call_missed', { customer_name: 'Pat Payer' }).body).toBeUndefined();
    expect(renderTemplate('communication.sms_inbound', { customer_name: 'Pat Payer', preview: 'hello' }).body).toBe('hello');
    expect(renderTemplate('communication.sms_inbound', { customer_name: 'Pat Payer' }).body).toBeUndefined();
  });
});
