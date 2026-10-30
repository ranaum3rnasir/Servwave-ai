import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emit } from '../notificationService';
import { prisma } from '../../../lib/prisma';

vi.mock('../filterByAccess', () => ({
  filterRecipientsByAccess: vi.fn((_t: string, _i: string, ids: string[]) => Promise.resolve(ids)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure findFirst returns undefined by default (dedup guard sees no existing row).
  (prisma.notification.findFirst as any).mockResolvedValue(undefined);
});

describe('emit — brief representative tests', () => {
  it('inserts one Notification + a recipient row per resolved recipient, dropping the actor', async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'admin1', role: 'ADMIN' }, { id: 'disp1', role: 'DISPATCHER' }, { id: 'sales1', role: 'SALES' },
    ]);
    (prisma.notification.create as any).mockResolvedValue({ id: 'n1' });
    // The caller (leadEstimateAlerts) walked the lanes: the record's people, who must act, and the copies.
    await emit({ verb: 'estimate.approved', organizationId: 'org1', actorId: 'sales1',
      object: { type: 'ESTIMATE', id: 'e1', label: 'E0042' },
      entity: { commission_owner_id: 'sales1', lane_one_ids: ['sales1', 'admin1'], lane_two_ids: ['disp1'], copy_ids: [] },
      data: { customer_name: 'Acme' } });
    expect(prisma.notification.create).toHaveBeenCalledOnce();
    // sales1 is the actor → excluded; disp1 + admin1 remain
    const recipArgs = (prisma.notificationRecipient.createMany as any).mock.calls[0][0].data;
    expect(recipArgs.map((r: any) => r.recipient_id).sort()).toEqual(['admin1', 'disp1']);
    // Per-recipient needs_action + priority must be stored correctly.
    const disp = recipArgs.find((r: any) => r.recipient_id === 'disp1');
    const admin = recipArgs.find((r: any) => r.recipient_id === 'admin1');
    expect(disp).toMatchObject({ priority: 'FEED', needs_action: true });
    expect(admin).toMatchObject({ priority: 'FEED', needs_action: false });
  });

  it('never throws on a downstream failure', async () => {
    (prisma.notification.create as any).mockRejectedValue(new Error('db down'));
    await expect(emit({ verb: 'job.started', organizationId: 'org1', actorId: null,
      object: { type: 'JOB', id: 'j1' }, entity: { assignee_ids: [] } })).resolves.toEqual([]);
  });

  // Was `task.assigned` — now a REGISTERED verb, so it no longer demonstrates the skip.
  // task.overdue is still deferred (it needs a cron) and keeps this case honest.
  it('skips unknown/deferred verbs without inserting', async () => {
    await emit({ verb: 'task.overdue', organizationId: 'org1', actorId: null,
      object: { type: 'TASK', id: 't1' }, entity: {} });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('skips insert when a notification with the same dedup_key already exists (idempotent)', async () => {
    (prisma.notification.findFirst as any).mockResolvedValue({ id: 'existing' });
    await emit({ verb: 'estimate.approved', organizationId: 'org1', actorId: null,
      object: { type: 'ESTIMATE', id: 'e1', label: 'E0042' }, entity: { commission_owner_id: 'sales1' },
      dedupKey: 'estimate.approved:e1' });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

// emit() returns the recipients it actually notified, so a caller that wants to
// push a SECOND signal to the same people (the inbox list refresh that rides
// alongside an inbound-email notification) does not have to re-resolve them and
// risk the two sets drifting apart.
describe('emit — returns the notified recipients', () => {
  it('returns the final recipient ids, post row-scope filter and actor drop', async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'admin1', role: 'ADMIN' }, { id: 'disp1', role: 'DISPATCHER' }, { id: 'sales1', role: 'SALES' },
    ]);
    (prisma.notification.create as any).mockResolvedValue({ id: 'n1' });

    const notified = await emit({ verb: 'estimate.approved', organizationId: 'org1', actorId: 'sales1',
      object: { type: 'ESTIMATE', id: 'e1', label: 'E0042' },
      entity: { commission_owner_id: 'sales1', lane_one_ids: ['sales1', 'admin1'], lane_two_ids: ['disp1'], copy_ids: [] },
      data: { customer_name: 'Acme' } });

    expect([...notified].sort()).toEqual(['admin1', 'disp1']);
  });

  it('returns [] when there are no recipients', async () => {
    (prisma.user.findMany as any).mockResolvedValue([]);
    const notified = await emit({ verb: 'job.started', organizationId: 'org1', actorId: null,
      object: { type: 'JOB', id: 'j1' }, entity: { assignee_ids: [] } });
    expect(notified).toEqual([]);
  });

  it('returns [] rather than throwing when the write fails', async () => {
    // The swallow-everything contract is unchanged; the return value just has
    // to be safe to spread into a follow-up publish.
    (prisma.notification.create as any).mockRejectedValue(new Error('db down'));
    (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin1', role: 'ADMIN' }]);
    const notified = await emit({ verb: 'communication.sms_inbound', organizationId: 'org1', actorId: null,
      object: { type: 'MESSAGE_THREAD', id: 'm1' }, entity: {} });
    expect(notified).toEqual([]);
  });

  it('returns [] for an unknown verb', async () => {
    const notified = await emit({ verb: 'task.overdue', organizationId: 'org1', actorId: null,
      object: { type: 'TASK', id: 't1' }, entity: {} });
    expect(notified).toEqual([]);
  });
});

// S06.27, S06.29, S10.10: no verb is handed the company's role list any more, and a personal alert is not filtered by who can open the
// record.
describe('emit — verbs that no longer read a role list', () => {
  it('does not read the company\'s people to build a role list for any verb, the inbound email alert included', async () => {
    (prisma.notification.create as any).mockResolvedValue({ id: 'n1' });
    (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin1', role: 'ADMIN' }]);

    await emit({ verb: 'dispatch.job_rescheduled', organizationId: 'org1', actorId: null,
      object: { type: 'JOB', id: 'j1', label: 'J1' }, entity: { lane_one_ids: ['sales1'] } });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationRecipient.createMany).toHaveBeenCalledOnce();

    // A customer's email reply (S10.10), an alert that moved off its role list (low stock) and the logistic order alert (the chain names
    // its approvers) read none either. The email alert's people are the chain's, already through the single read of the conversation.
    for (const [verb, object, entity] of [
      ['communication.email_inbound', { type: 'EMAIL_THREAD', id: 'm1' }, { lane_one_ids: ['holder1'] }],
      ['inventory.low_stock', { type: 'INVENTORY_ITEM', id: 'i1', label: 'Item' }, { lane_two_ids: ['holder1'] }],
      ['lo.submitted', { type: 'INVENTORY_ITEM', id: 'i1', label: 'Item' }, { lane_two_ids: ['holder1'] }],
    ] as const) {
      vi.clearAllMocks();
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'n3' });
      await emit({ verb, organizationId: 'org1', actorId: null, object, entity, ...(verb === 'communication.email_inbound' ? { readersChecked: true } : {}) });
      expect(prisma.user.findMany, verb).not.toHaveBeenCalled();
    }
  });

  it('a personal alert reaches the people it names without asking whether they can open the record', async () => {
    const { filterRecipientsByAccess } = await import('../filterByAccess.js');
    (filterRecipientsByAccess as any).mockResolvedValue([]); // nobody can open it
    (prisma.notification.create as any).mockResolvedValue({ id: 'n1' });

    const notified = await emit({ verb: 'dispatch.job_unassigned', organizationId: 'org1', actorId: 'boss1', personal: true,
      object: { type: 'JOB', id: 'j1', label: 'J1' }, entity: { assignee_ids: ['tech1'] } });
    expect(notified).toEqual(['tech1']);

    // Without `personal` the same alert is held back by the filter, as every other alert is.
    vi.clearAllMocks();
    (prisma.notification.findFirst as any).mockResolvedValue(undefined);
    (filterRecipientsByAccess as any).mockResolvedValue([]);
    expect(await emit({ verb: 'dispatch.job_unassigned', organizationId: 'org1', actorId: 'boss1',
      object: { type: 'JOB', id: 'j1', label: 'J1' }, entity: { assignee_ids: ['tech1'] } })).toEqual([]);
  });
});
