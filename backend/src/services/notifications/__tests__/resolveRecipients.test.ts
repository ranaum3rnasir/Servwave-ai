import { describe, it, expect } from 'vitest';
import { resolveRecipients, VERBS_WITHOUT_ROLE_LISTS } from '../resolveRecipients';
import { VERB_RULES, type KnownVerb } from '../templates';

const base = { organizationId: 'org1', actorId: null as string | null };

/** The invoice and payment alerts S06.28 moved onto the chain: the ten the PRD names and the five that sit beside them. */
const BILLING_VERBS_ON_THE_CHAIN = [
  'billing.payment_received', 'billing.partial_payment', 'billing.invoice_overdue', 'billing.invoice_due_soon', 'billing.refunded',
  'billing.disputed', 'billing.chargeback', 'billing.payment_unrecorded', 'billing.voided', 'billing.credit_applied',
  'billing.bank_payment_started', 'billing.bank_payment_cleared', 'billing.bank_payment_failed', 'billing.dispute_closed',
  'billing.refund_failed',
];

// ──────────────────────────────────────────────────────────────────────────────
// Brief representative tests (verbatim from task-1.1-brief.md)
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — brief representative tests', () => {
  // S06.26: the estimate alerts are addressed by the chain's lanes, never by a role list. The role holders handed in here (an
  // Admin and a Dispatcher) are not told just for their role.
  it('estimate.approved → the Owner INTERRUPT, the people who must act FEED + needs_action(schedule), everyone else FEED, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.approved',
      entity: { id: 'e1', commission_owner_id: 'sales1', lane_one_ids: ['sales1', 'tech2'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'rev1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  // S06.27: the dispatch alerts are addressed by the chain's lanes, never by a role list. The role holders handed in here (an Admin
  // and a Dispatcher) are not told just for their role.
  it('dispatch.job_assigned → the people named INTERRUPT, everyone else the chain found FEED, never a role list', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_assigned', actorId: 'disp1',
      entity: { id: 'j1', named_ids: ['tech1', 'tech2'], lane_one_ids: ['tech1', 'tech2', 'sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1', 'disp1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    for (const id of ['sales1', 'rev1', 'boss1']) expect(r).toContainEqual({ userId: id, priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1'); // the actor
  });

  it('inventory.staging_ready → the technician it is staged for INTERRUPT, everyone else the chain found FEED, never a role list', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready',
      entity: { id: 'stg1', assignee_ids: ['tech1'], lane_one_ids: ['tech1', 'sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    for (const id of ['sales1', 'rev1', 'boss1']) expect(r).toContainEqual({ userId: id, priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('inventory.staging_ready with nobody on the chain → nobody (no role list to fall back on)', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.staging_ready', entity: { id: 'stg1' } });
    expect(r).toEqual([]);
  });

  it('drops the actor from recipients', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started', actorId: 'tech1',
      entity: { id: 'j1', lane_one_ids: ['tech1'] } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
  });

  // S06.28: the billing alerts are addressed by the chain's lanes, never by a role list. The role holders handed in here (an Admin and a
  // Dispatcher) and a customer owner are not told just for who they are.
  it('billing.payment_received → everyone the chain found FEED; no role list, no customer owner', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.payment_received',
      entity: { id: 'i1', customer_owner_id: 'sales2', lane_one_ids: ['sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales1']);
    expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
  });

  it('security.* → only the account owner', () => {
    const r = resolveRecipients({ ...base, verb: 'security.new_signin',
      entity: { user_id: 'sales1' } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'FEED', needs_action: false }]);
  });

  it('lead.unassigned_created → the people the chain found, FEED, nobody asked to act, and no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.unassigned_created',
      entity: { id: 'l1', lane_one_ids: ['tech1'], lane_two_ids: ['rev1'], copy_ids: ['rev1', 'boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'tech1']);
    expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('lead.unassigned_created with no lanes in the entity reaches nobody, whatever the roles', () => {
    expect(resolveRecipients({ ...base, verb: 'lead.unassigned_created', entity: { id: 'l1' } })).toEqual([]);
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

  it('spider.starting_summary → the one pre-resolved person, on the feed (never a toast)', () => {
    const r = resolveRecipients({ ...base, actorId: null, verb: 'spider.starting_summary', entity: { recipient_ids: ['u-1'] } });
    expect(r).toEqual([expect.objectContaining({ userId: 'u-1', priority: 'FEED' })]);
  });

  it("spider.alert → every pre-resolved recipient gets FEED (Spider's own panel and frame interrupt; the bell never shows it)", () => {
    const r = resolveRecipients({ ...base, actorId: null, verb: 'spider.alert',
      entity: { id: 'l1', recipient_ids: ['admin1', 'sales1'] } });
    expect(r).toContainEqual({ userId: 'admin1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
  });

  it('lead.reassigned_away → previous_owner_id gets FEED', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.reassigned_away',
      entity: { id: 'l1', previous_owner_id: 'sales2' } });
    expect(r).toContainEqual({ userId: 'sales2', priority: 'FEED', needs_action: false });
    expect(r.find(x => x.userId === 'admin1')).toBeUndefined();
  });

  // S06.26: the people booked on the walkthrough are interrupted, whichever lane found them; everyone else is told on the feed.
  it('lead.walkthrough_scheduled → the people booked INTERRUPT, the Owner and everyone else the chain found FEED, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1', performer_ids: ['tech1', 'tech2'],
        lane_one_ids: ['sales1', 'tech1', 'tech2'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'rev1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('lead.walkthrough_scheduled — nobody booked → everyone the chain found on the feed', () => {
    const r = resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled',
      entity: { id: 'l1', commission_owner_id: 'sales1', lane_one_ids: ['sales1'], lane_two_ids: ['rev1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['rev1', 'sales1']);
    expect(r.every(x => x.priority === 'FEED')).toBe(true);
  });

  it('lead.walkthrough_scheduled with no lanes in the entity reaches nobody, whatever the roles', () => {
    expect(resolveRecipients({ ...base, verb: 'lead.walkthrough_scheduled', entity: { id: 'l1', commission_owner_id: 'sales1', performer_ids: ['tech1'] } })).toEqual([]);
  });
});

describe('resolveRecipients — ESTIMATE verbs', () => {
  const lanes = { lane_one_ids: ['sales1', 'tech2'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] };
  const everyoneBut = (r: Array<{ userId: string }>, ...ids: string[]) => ids.every((id) => !r.map(x => x.userId).includes(id));

  it('estimate.declined → the Owner INTERRUPT, everyone else the chain found FEED, nobody asked to act, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.declined', entity: { id: 'e1', commission_owner_id: 'sales1', ...lanes } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'rev1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(everyoneBut(r, 'admin1', 'disp1')).toBe(true);
  });

  it('estimate.deposit_paid → the Owner INTERRUPT, the people who must act FEED + needs_action(schedule), everyone else FEED, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.deposit_paid', entity: { id: 'e1', commission_owner_id: 'sales1', ...lanes } });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'rev1', priority: 'FEED', needs_action: true });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(everyoneBut(r, 'admin1', 'disp1')).toBe(true);
  });

  it('an Owner who is also who must act keeps both: interrupted and asked to schedule the job', () => {
    const r = resolveRecipients({ ...base, verb: 'estimate.approved',
      entity: { id: 'e1', commission_owner_id: 'sales1', lane_one_ids: ['sales1'], lane_two_ids: ['sales1'] } });
    expect(r).toEqual([{ userId: 'sales1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it.each(['estimate.cancelled', 'estimate.deposit_waived', 'estimate.approval_voided', 'estimate.status_corrected'])(
    '%s → everyone the chain found on the feed, the Owner included, nobody asked to act, no role list',
    (verb) => {
      const r = resolveRecipients({ ...base, verb, entity: { id: 'e1', commission_owner_id: 'sales1', ...lanes } });
      expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales1', 'tech2']);
      expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
      expect(everyoneBut(r, 'admin1', 'disp1')).toBe(true);
    },
  );

  it.each(['estimate.approved', 'estimate.declined', 'estimate.deposit_paid', 'estimate.cancelled', 'estimate.deposit_waived', 'estimate.approval_voided', 'estimate.status_corrected'])(
    '%s with no lanes in the entity reaches nobody, whatever the roles',
    (verb) => {
      expect(resolveRecipients({ ...base, verb, entity: { id: 'e1', commission_owner_id: 'sales1' } })).toEqual([]);
    },
  );
});

describe('resolveRecipients — DISPATCH verbs', () => {
  // "Unassigned from you" is personal: the people taken off and nobody else.
  it('dispatch.job_unassigned → only the removed assignees, INTERRUPT: no Dispatcher, no lanes, no copies', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_unassigned',
      entity: { id: 'j1', assignee_ids: ['tech1'], lane_one_ids: ['sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r).toEqual([{ userId: 'tech1', priority: 'INTERRUPT', needs_action: false }]);
  });

  it('dispatch.job_rescheduled → the job crew INTERRUPT, everyone else the chain found FEED, never a role list', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_rescheduled',
      entity: { id: 'j1', crew_ids: ['tech1', 'tech2'], lane_one_ids: ['tech1', 'tech2', 'sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    for (const id of ['sales1', 'rev1', 'boss1']) expect(r).toContainEqual({ userId: id, priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales1', 'tech1', 'tech2']);
  });

  it('dispatch.job_created → the crew and the people who must act INTERRUPT, the rest FEED, never a role list', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created',
      entity: { id: 'j1', crew_ids: ['tech1'], lane_one_ids: ['tech1', 'sales1', 'disp2'], lane_two_ids: ['disp2'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp2', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('dispatch.job_created — nobody on the chain → nobody', () => {
    const r = resolveRecipients({ ...base, verb: 'dispatch.job_created', entity: { id: 'j1' } });
    expect(r).toEqual([]);
  });
});

// A verb listed as free of role lists is handed no role list by emit(), so it must really not read one: the resolver, given a
// role list full of people and a chain that found nobody, tells nobody.
describe('resolveRecipients — the verbs that no longer read a role list', () => {
  it.each([...VERBS_WITHOUT_ROLE_LISTS])('%s tells nobody on its own, whatever the role holders are', (verb) => {
    const r = resolveRecipients({ ...base, verb, entity: { id: 'x1' } });
    expect(r).toEqual([]);
  });
});

describe('resolveRecipients — JOB verbs', () => {
  // S06.25: job started, cancelled and reopened are addressed by the chain's lanes, never by a role list. The role holders
  // handed in here (an Admin and a Dispatcher) are not told just for their role.
  it('job.started → the people the chain found, FEED, nobody asked to act, and no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started', actorId: 'tech1',
      entity: { id: 'j1', lane_one_ids: ['tech1', 'sales2'], lane_two_ids: ['disp2'], copy_ids: ['disp2', 'boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'disp2', 'sales2']);
    expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('job.started with no lanes in the entity reaches nobody, whatever the roles', () => {
    expect(resolveRecipients({ ...base, verb: 'job.started', entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } })).toEqual([]);
  });

  it('job.started — actor (tech) dropped from result', () => {
    const r = resolveRecipients({ ...base, verb: 'job.started', actorId: 'tech1',
      entity: { id: 'j1', lane_one_ids: ['tech1', 'sales1'] } });
    expect(r.find(x => x.userId === 'tech1')).toBeUndefined();
    expect(r.map(x => x.userId)).toEqual(['sales1']);
  });

  // S06.23: the job completed alert is addressed by the chain's lanes, never by a role list. The role holders handed in
  // here (an Admin and a Dispatcher) are not told just for their role.
  it('job.completed → the people the chain found, FEED, nobody asked to act, and no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.completed', actorId: 'tech1',
      entity: { id: 'j1', lane_one_ids: ['tech1', 'sales2'], lane_two_ids: ['rev1'], copy_ids: ['rev1', 'boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales2']);
    expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('job.completed with no lanes in the entity reaches nobody, whatever the roles', () => {
    expect(resolveRecipients({ ...base, verb: 'job.completed', entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales2' } })).toEqual([]);
  });

  // S06.24: Ready to close asks the Close jobs holders (lane 2) to act and only tells the job's people and the copies.
  it('job.ready_to_close → FEED for everyone the chain found, needs action for lane 2 only, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.ready_to_close', actorId: 'actor1',
      entity: { id: 'j1', lane_one_ids: ['sales2', 'closer1'], lane_two_ids: ['closer1', 'actor1'], copy_ids: ['boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'closer1', 'sales2']);
    expect(r.every(x => x.priority === 'FEED')).toBe(true);
    expect(r.filter(x => x.needs_action).map(x => x.userId)).toEqual(['closer1']);
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  // S06.24: the Office review attention alert is high priority for everyone and asks nobody to act.
  it('job.review_attention → INTERRUPT for the lanes and the copies, nobody asked to act, and no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.review_attention', actorId: 'actor1',
      entity: { id: 'j1', lane_one_ids: ['sales2'], lane_two_ids: ['rev1', 'actor1'], copy_ids: ['boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales2']);
    expect(r.every(x => x.priority === 'INTERRUPT' && x.needs_action === false)).toBe(true);
    expect(resolveRecipients({ ...base, verb: 'job.review_attention', entity: { id: 'j1', assignee_ids: ['tech1'] } })).toEqual([]);
  });

  // A cancelled job interrupts its crew, whichever lane found them, and tells everyone else the way it always did.
  it('job.cancelled → the people the chain found; the crew interrupts, everyone else is FEED, nobody asked to act, no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.cancelled', actorId: 'actor1',
      entity: { id: 'j1', crew_ids: ['tech1', 'tech2'], lane_one_ids: ['tech1', 'sales1', 'actor1'], lane_two_ids: ['disp2', 'tech2'], copy_ids: ['boss1'] } });
    expect(r).toContainEqual({ userId: 'tech1', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'tech2', priority: 'INTERRUPT', needs_action: false });
    expect(r).toContainEqual({ userId: 'sales1', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'disp2', priority: 'FEED', needs_action: false });
    expect(r).toContainEqual({ userId: 'boss1', priority: 'FEED', needs_action: false });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'disp2', 'sales1', 'tech1', 'tech2']);
    expect(r.map(x => x.userId)).not.toContain('admin1');
    expect(r.map(x => x.userId)).not.toContain('disp1');
  });

  it('job.cancelled with no lanes in the entity reaches nobody, whatever the roles', () => {
    expect(resolveRecipients({ ...base, verb: 'job.cancelled', entity: { id: 'j1', assignee_ids: ['tech1'], sold_by_id: 'sales1' } })).toEqual([]);
  });

  it('job.reopened → the people the chain found, FEED, nobody asked to act, and no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.reopened', actorId: 'actor1',
      entity: { id: 'j1', crew_ids: ['tech1'], lane_one_ids: ['tech1', 'sales1'], lane_two_ids: ['rev1', 'actor1'], copy_ids: ['boss1'] } });
    expect(r.map(x => x.userId).sort()).toEqual(['boss1', 'rev1', 'sales1', 'tech1']);
    expect(r.every(x => x.priority === 'FEED' && x.needs_action === false)).toBe(true);
    expect(resolveRecipients({ ...base, verb: 'job.reopened', entity: { id: 'j1', assignee_ids: ['tech1'] } })).toEqual([]);
  });
});

describe('resolveRecipients — BILLING verbs', () => {
  // S06.28: every invoice and payment alert is addressed by the chain's lanes (invoiceBillingAlerts.ts has already asked who is
  // active, can open the invoice and is not the actor). A role list and a customer owner are never read.
  const chain = { lane_one_ids: ['sales1'], lane_two_ids: ['rev1'], copy_ids: ['boss1'] };
  const roleListAndOwner = { customer_owner_id: 'sales2' };
  const prioritiesOf = (verb: string) => {
    const r = resolveRecipients({ ...base, verb, entity: { id: 'i1', ...roleListAndOwner, ...chain } });
    expect(r.map(x => x.userId).sort(), `${verb}: only the chain is told`).toEqual(['boss1', 'rev1', 'sales1']);
    return Object.fromEntries(r.map(x => [x.userId, `${x.priority}${x.needs_action ? '+action' : ''}`]));
  };

  it.each([
    'billing.payment_received', 'billing.partial_payment', 'billing.voided', 'billing.credit_applied',
    'billing.bank_payment_started', 'billing.bank_payment_cleared', 'billing.dispute_closed',
  ])('%s → the whole chain on the feed, nobody asked to act', (verb) => {
    expect(prioritiesOf(verb)).toEqual({ sales1: 'FEED', rev1: 'FEED', boss1: 'FEED' });
  });

  it.each(['billing.invoice_overdue', 'billing.invoice_due_soon'])(
    '%s → the people who must act are asked to send a reminder (FEED + needs_action); the record\'s people and the copies are only told',
    (verb) => {
      expect(prioritiesOf(verb)).toEqual({ sales1: 'FEED', rev1: 'FEED+action', boss1: 'FEED' });
    },
  );

  it.each([
    'billing.refunded', 'billing.disputed', 'billing.chargeback', 'billing.payment_unrecorded',
    'billing.bank_payment_failed', 'billing.refund_failed',
  ])('%s → the people who must act and the copies are interrupted; the record\'s own people are told on the feed', (verb) => {
    expect(prioritiesOf(verb)).toEqual({ sales1: 'FEED', rev1: 'INTERRUPT', boss1: 'INTERRUPT' });
  });

  it('a person the chain found in more than one lane is one person: INTERRUPT wins and the reminder flag is kept', () => {
    const interrupted = resolveRecipients({ ...base, verb: 'billing.refunded', entity: { lane_one_ids: ['x'], lane_two_ids: ['x'] } });
    expect(interrupted).toEqual([{ userId: 'x', priority: 'INTERRUPT', needs_action: false }]);
    const reminded = resolveRecipients({ ...base, verb: 'billing.invoice_overdue', entity: { lane_one_ids: ['x'], copy_ids: ['x'], lane_two_ids: ['x'] } });
    expect(reminded).toEqual([{ userId: 'x', priority: 'FEED', needs_action: true }]);
  });

  it('the person who did it is never told', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.refunded', actorId: 'rev1', entity: { ...chain } });
    expect(r.map(x => x.userId)).not.toContain('rev1');
  });

  it('a billing alert with nobody on the chain reaches nobody: there is no role list to fall back on', () => {
    for (const verb of BILLING_VERBS_ON_THE_CHAIN) {
      expect(resolveRecipients({ ...base, verb, entity: { id: 'i1', ...roleListAndOwner } }), verb).toEqual([]);
    }
  });

  it('every billing alert that moved to the chain is in the set that is never handed a role list, and the set holds nothing that still reads one', () => {
    for (const verb of BILLING_VERBS_ON_THE_CHAIN) expect(VERBS_WITHOUT_ROLE_LISTS.has(verb), verb).toBe(true);
  });

  // S06.29: the payments-account alerts have no record. The caller (noRecordAlerts.ts) walked the chain from its second step, so
  // the people who must act arrive in lane_two_ids and nobody is found by a role. Not one of them reads a role list.
  it.each([
    ['billing.payments_activated', 'FEED', false], ['billing.payouts_activated', 'FEED', false], ['billing.payouts_pending_first_payment', 'FEED', false],
    ['billing.payments_action_needed', 'INTERRUPT', true], ['billing.payments_paused', 'INTERRUPT', true], ['billing.payments_disconnected', 'INTERRUPT', true],
  ])('%s → the people the chain found, %s, needs action %s, and no role list', (verb, priority, needsAction) => {
    const r = resolveRecipients({ ...base, verb, entity: { lane_two_ids: ['holder1', 'holder2'] } });
    expect(r).toEqual([
      { userId: 'holder1', priority, needs_action: needsAction },
      { userId: 'holder2', priority, needs_action: needsAction },
    ]);
    expect(VERBS_WITHOUT_ROLE_LISTS.has(verb), verb).toBe(true);
  });
});

describe('resolveRecipients — TEAM verbs', () => {
  it('team.invite_accepted → the people the chain found on the feed, never the Admin role list, and never the person who accepted', () => {
    const r = resolveRecipients({ ...base, verb: 'team.invite_accepted', actorId: 'newbie',
      entity: { user_id: 'tech1', lane_two_ids: ['holder1', 'newbie'] } });
    expect(r).toEqual([{ userId: 'holder1', priority: 'FEED', needs_action: false }]);
    expect(VERBS_WITHOUT_ROLE_LISTS.has('team.invite_accepted')).toBe(true);
  });
});

describe('resolveRecipients — INVENTORY verbs', () => {
  it('inventory.stock_approval_requested → the people the chain found, INTERRUPT + needs_action, never the Admin role list', () => {
    const r = resolveRecipients({ ...base, verb: 'inventory.stock_approval_requested',
      entity: { id: 'sr1', lane_two_ids: ['holder1'] } });
    expect(r).toEqual([{ userId: 'holder1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it.each(['inventory.low_stock', 'inventory.backorder', 'inventory.staging_no_area', 'inventory.po_partial'])(
    '%s → the people the chain found on the feed, nobody asked to act, never the Admin or Dispatcher role list',
    (verb) => {
      const r = resolveRecipients({ ...base, verb, entity: { id: 'item1', lane_two_ids: ['holder1', 'holder2'] } });
      expect(r).toEqual([
        { userId: 'holder1', priority: 'FEED', needs_action: false },
        { userId: 'holder2', priority: 'FEED', needs_action: false },
      ]);
      expect(VERBS_WITHOUT_ROLE_LISTS.has(verb), verb).toBe(true);
    },
  );

  it('a moved inventory alert with nobody on the chain reaches nobody: there is no role list to fall back on', () => {
    for (const verb of ['inventory.stock_approval_requested', 'inventory.low_stock', 'inventory.backorder', 'inventory.staging_no_area', 'inventory.po_partial']) {
      expect(resolveRecipients({ ...base, verb, entity: { id: 'item1' } }), verb).toEqual([]);
    }
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
    // tech1 is both a crew member (INTERRUPT in job.cancelled) and found by every lane (FEED on its own)
    const r = resolveRecipients({ ...base, verb: 'job.cancelled',
      entity: { id: 'j1', crew_ids: ['tech1'], lane_one_ids: ['tech1'], lane_two_ids: ['tech1'], copy_ids: ['tech1'] } });
    const entry = r.find(x => x.userId === 'tech1');
    expect(entry).toBeDefined();
    expect(entry!.priority).toBe('INTERRUPT');
  });

  it('needs_action ORs: a person found by two lanes keeps the flag the lane that asked them to act gave', () => {
    const r = resolveRecipients({ ...base, verb: 'billing.invoice_overdue',
      entity: { id: 'i1', lane_one_ids: ['admin1'], lane_two_ids: ['admin1'] } }); // the person is the record's own AND must act
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
  lane_one_ids: [EVERYONE],
  lane_two_ids: [EVERYONE],
  copy_ids: [EVERYONE],
};

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
        verb, organizationId: 'org1', actorId: EVERYONE, entity: fullEntity,
      });
      expect(r, `${verb} told the actor about their own action`).toEqual([]);
    }
  });

  it('with a different actor, every non-self verb returns at least one recipient', () => {
    for (const verb of nonSelfVerbs) {
      const r = resolveRecipients({
        verb, organizationId: 'org1', actorId: 'someone-else', entity: fullEntity,
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
  it('a time-driven invoice reminder resolves to the people the chain found with a null actor, and asks the people who must act to send it', () => {
    for (const verb of ['billing.invoice_overdue', 'billing.invoice_due_soon']) {
      const r = resolveRecipients({ ...base, verb, actorId: null,
        entity: { id: 'i1', lane_one_ids: ['sales1'], lane_two_ids: ['rev1'] } });
      expect(r.map((x) => x.userId).sort(), verb).toEqual(['rev1', 'sales1']);
      expect(r.find((x) => x.userId === 'rev1')!.needs_action, `${verb} carries SEND_REMINDER for who must act`).toBe(true);
      expect(r.find((x) => x.userId === 'sales1')!.needs_action).toBe(false);
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
    const job = resolveRecipients({ ...base, verb: 'job.started', actorId: completer,
      entity: { id: 'j1', lane_one_ids: ['tech1', 'tech2', 'sales1'], lane_two_ids: ['disp1'] } });

    expect(task.map((x) => x.userId)).not.toContain(completer);
    expect(job.map((x) => x.userId)).not.toContain(completer);
    // ...and the other assignee is still told in both cases, so the drop is the completer's
    // alone rather than the whole roster falling out.
    expect(task.map((x) => x.userId)).toContain('tech2');
    expect(job.map((x) => x.userId)).toContain('tech2');
    // The declared difference: the job reaches whoever the chain found (here its Dispatcher), the task does not.
    expect(job.map((x) => x.userId)).toContain('disp1');
    expect(task.map((x) => x.userId)).not.toContain('disp1');
  });

  it('with the actor seated in every recipient field, every self verb still returns them', () => {
    expect(selfVerbs.length).toBeGreaterThan(0);
    for (const verb of selfVerbs) {
      const r = resolveRecipients({
        verb, organizationId: 'org1', actorId: EVERYONE, entity: fullEntity,
      });
      expect(r.map((x) => x.userId), `${verb} dropped its own recipient`).toContain(EVERYONE);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────

// job.visit_finished (S04.16): the caller walks M6's two-lane chain and hands over the people; the resolver
// merges them, asks only lane 2 to act, and reads no role list.
describe('resolveRecipients - job.visit_finished', () => {
  const entity = { lane_one_ids: ['tech2', 'sales1'], lane_two_ids: ['disp1'], copy_ids: ['admin2'] };

  it('tells every lane and the copy holders, and reads no role list', () => {
    const r = resolveRecipients({ ...base, verb: 'job.visit_finished', actorId: 'tech1', entity });
    expect(r.map((x) => x.userId).sort()).toEqual(['admin2', 'disp1', 'sales1', 'tech2']);
    // The role lists hold admin1, sales2, tech1 and disp1: only the one named by the chain is told.
    expect(r.map((x) => x.userId)).not.toContain('admin1');
  });

  it('asks only lane 2 to act, and only when every visit is finished', () => {
    const last = resolveRecipients({ ...base, verb: 'job.visit_finished', actorId: 'tech1', entity: { ...entity, all_finished: true } });
    expect(last.filter((x) => x.needs_action).map((x) => x.userId)).toEqual(['disp1']);
    const notLast = resolveRecipients({ ...base, verb: 'job.visit_finished', actorId: 'tech1', entity });
    expect(notLast.some((x) => x.needs_action)).toBe(false);
  });

  it('merges a person found by two lanes into one alert that asks them to act', () => {
    const r = resolveRecipients({
      ...base, verb: 'job.visit_finished', actorId: 'tech1',
      entity: { lane_one_ids: ['disp1'], lane_two_ids: ['disp1'], copy_ids: ['disp1'], all_finished: true },
    });
    expect(r).toEqual([{ userId: 'disp1', priority: 'FEED', needs_action: true }]);
  });
});

// mailbox.address_needed and mailbox.address_needed_admin (S10.3): the caller has already found the new user and
// the active holders of Edit users; the resolver tells exactly those people and reads no role list.
describe('resolveRecipients - mailbox.address_needed', () => {
  it.each(['mailbox.address_needed', 'mailbox.address_needed_admin'])('%s tells the pre-resolved people and nobody from the role lists', (verb) => {
    const r = resolveRecipients({ ...base, verb, actorId: null, entity: { recipient_ids: ['u1', 'u2'] } });
    expect(r).toEqual([
      { userId: 'u1', priority: 'FEED', needs_action: false },
      { userId: 'u2', priority: 'FEED', needs_action: false },
    ]);
  });

  it('tells nobody when no one was resolved', () => {
    expect(resolveRecipients({ ...base, verb: 'mailbox.address_needed', actorId: null, entity: {} })).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

// communication.email_inbound (S10.10) - a customer's reply to an email. The caller walked M6's chain for the conversation (the holder
// of the mailbox it sits in, the person who sent the mail by hand, the record's people, the fallback and the copies) and ran them
// through the single read of the conversation; the resolver only gives each of them a weight. The people the conversation is theirs
// to answer interrupt; everyone else is told on the feed. No role list is read, so a company's Admins and Dispatchers hear of a reply
// only when the chain named them.
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients — communication.email_inbound', () => {
  it('interrupts the conversation\'s own people and feeds the rest of the chain, lane by lane', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { lane_one_ids: ['sender', 'crew1'], lane_two_ids: ['cover1'], copy_ids: ['copy1'], conversation_owner_ids: ['sender'] } });
    expect(r).toEqual([
      { userId: 'sender', priority: 'INTERRUPT', needs_action: false },
      { userId: 'crew1', priority: 'FEED', needs_action: false },
      { userId: 'cover1', priority: 'FEED', needs_action: false },
      { userId: 'copy1', priority: 'FEED', needs_action: false },
    ]);
  });

  it('tells a person the chain found twice once, interrupting if they are the conversation\'s own', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.email_inbound',
      entity: { lane_one_ids: ['p1'], copy_ids: ['p1'], conversation_owner_ids: ['p1'] } });
    expect(r).toEqual([{ userId: 'p1', priority: 'INTERRUPT', needs_action: false }]);
  });

  it('rings nobody when the chain named nobody: there is no room to fall back to', () => {
    expect(resolveRecipients({ ...base, verb: 'communication.email_inbound', entity: { thread_assignee_id: 'tech1' } })).toEqual([]);
    expect(resolveRecipients({ ...base, verb: 'communication.email_inbound', entity: {} })).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// communication.call_missed (S08.22) - a missed call or a voicemail. The caller found the people (the call's record, the holders of
// All, the people linked to the number) and ran them through the access filter; the resolver only gives each of them the weight the
// alert always had: interrupt, and a call back to make.
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients - communication.call_missed', () => {
  it('interrupts and asks for a call back, for each person the caller found', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.call_missed', entity: { recipient_ids: ['p1', 'p2'] } });
    expect(r).toEqual([
      { userId: 'p1', priority: 'INTERRUPT', needs_action: true },
      { userId: 'p2', priority: 'INTERRUPT', needs_action: true },
    ]);
  });

  it('tells one person once even when found twice', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.call_missed', entity: { recipient_ids: ['p1', 'p1'] } });
    expect(r).toEqual([{ userId: 'p1', priority: 'INTERRUPT', needs_action: true }]);
  });

  it('reads no role list: the Admin and Dispatcher holders handed in are not told, and nobody found means nobody told', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.call_missed', entity: { id: 'c1' } });
    expect(r).toEqual([]);
    expect(VERBS_WITHOUT_ROLE_LISTS.has('communication.call_missed')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// communication.sms_inbound (S08.23) - an inbound text. The caller found the people (the text's record, the holders of All, the
// people linked to the number and the person its reply is attributed to) and ran them through the access filter; the resolver only
// gives each of them the weight the alert always had: a feed item, with nothing to do.
// ──────────────────────────────────────────────────────────────────────────────

describe('resolveRecipients - communication.sms_inbound', () => {
  it('is a feed item that asks for nothing, for each person the caller found', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.sms_inbound', entity: { recipient_ids: ['p1', 'p2'] } });
    expect(r).toEqual([
      { userId: 'p1', priority: 'FEED', needs_action: false },
      { userId: 'p2', priority: 'FEED', needs_action: false },
    ]);
  });

  it('tells one person once even when found twice', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.sms_inbound', entity: { recipient_ids: ['p1', 'p1'] } });
    expect(r).toEqual([{ userId: 'p1', priority: 'FEED', needs_action: false }]);
  });

  it('reads no role list: the Admin and Dispatcher holders handed in are not told, and nobody found means nobody told', () => {
    const r = resolveRecipients({ ...base, verb: 'communication.sms_inbound', entity: { message_id: 'm1' } });
    expect(r).toEqual([]);
    expect(VERBS_WITHOUT_ROLE_LISTS.has('communication.sms_inbound')).toBe(true);
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
