import { describe, it, expect, vi } from 'vitest';
import { getJobCommunications, getLeadCommunications, getCustomerCommunications, type ChannelVisibility } from '../lib/job-communications';

/**
 * Roles & Permissions S08.9 - the aggregator's customer-decision entries, with the database stubbed. The routes and the
 * real rows are in permission-communication-estimate-decisions-db.test.ts; this holds what is cheap to state here: which
 * estimates each tab asks for, and that only the per-source form of visibility can open the entries at all.
 */

const ORG = 'o0000000-0000-0000-0000-000000000001';
const ESTIMATE = {
  id: 'e0000000-0000-0000-0000-000000000001', estimate_number: 'E-1', job_id: 'j1', lead_id: null, status: 'WON',
  lost_reason: null, lost_reason_note: null, job_link: { job_number: 'J-1' }, lead: null,
  customer: { id: 'c1', first_name: 'Pat', last_name: 'Payer', company_name: null },
};

function stubDb() {
  const none = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  return {
    callSession: none(), message: none(), email: none(), whatsAppMessage: none(), manualCommunicationLog: none(),
    estimate: { findMany: vi.fn().mockResolvedValue([ESTIMATE]) },
    timelineEvent: { findMany: vi.fn().mockResolvedValue([{ id: 'ev1', entity_id: ESTIMATE.id, event_type: 'APPROVED', metadata: null, created_at: new Date('2026-06-01T10:00:00Z') }]) },
    lostReasonOption: none(),
    payment: none(),
  };
}

const perChannel = (estimates: Record<string, unknown>): ChannelVisibility => ({
  perChannel: true, calls: {}, messages: {}, emails: {}, whatsapps: {}, manuals: {}, estimates, payments: {},
});

describe('customer-decision entries (lib)', () => {
  it('asks for the estimates of the record each tab belongs to, narrowed by the person\'s estimate reach', async () => {
    const reach = { created_by: 'u-me' };
    const jobDb = stubDb();
    await getJobCommunications(jobDb, { jobId: 'j1', organizationId: ORG, visibility: perChannel(reach) });
    expect(jobDb.estimate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organization_id: ORG, AND: [{ job_id: 'j1' }, reach] } }));

    const leadDb = stubDb();
    await getLeadCommunications(leadDb, { leadId: 'l1', organizationId: ORG, visibility: perChannel(reach) });
    expect(leadDb.estimate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organization_id: ORG, AND: [{ lead_id: 'l1' }, reach] } }));

    const customerDb = stubDb();
    await getCustomerCommunications(customerDb, { customerId: 'c1', organizationId: ORG, visibility: perChannel(reach) });
    expect(customerDb.estimate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organization_id: ORG, AND: [{ customer_id: 'c1' }, reach] } }));
  });

  it('reads only the customer\'s own events, never the office\'s', async () => {
    const db = stubDb();
    await getJobCommunications(db, { jobId: 'j1', organizationId: ORG, visibility: perChannel({}) });
    expect(db.timelineEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ entity_type: 'ESTIMATE', event_type: { in: ['APPROVED', 'DECLINED'] }, created_by: null }),
    }));
  });

  it('reads no estimate and lists no entry for a caller that hands in one shared filter, which cannot carry the estimate reach', async () => {
    const db = stubDb();
    const items = await getJobCommunications(db, { jobId: 'j1', organizationId: ORG, visibility: { OR: [{ job_id: null }] } });
    expect(db.estimate.findMany).not.toHaveBeenCalled();
    expect(items.filter((i) => i.channel === 'portal')).toEqual([]);
  });

  it('puts an approval in the chronology as a portal entry with the estimate\'s job and no money', async () => {
    const db = stubDb();
    const items = await getJobCommunications(db, { jobId: 'j1', organizationId: ORG, visibility: perChannel({}) });
    expect(items).toEqual([expect.objectContaining({
      id: 'ev1', channel: 'portal', entry: 'estimate_approved', direction: 'in', who: 'Pat Payer',
      title: 'Estimate E-1 approved by the customer', jobId: 'j1', jobLabel: 'J-1', at: '2026-06-01T10:00:00.000Z',
    })]);
    expect(Object.keys(items[0]).filter((k) => /total|amount|price/i.test(k))).toEqual([]);
  });
});
