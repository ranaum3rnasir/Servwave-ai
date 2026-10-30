import { describe, it, expect, vi } from 'vitest';
import { getJobCommunications, getLeadCommunications, getCustomerCommunications, type ChannelVisibility } from '../lib/job-communications';
import { COUNTED_PAYMENT_WHERE } from '../lib/payment-ledger';
import { DEPOSIT_CREDIT_REFERENCE } from '../lib/deposit-credit';

/**
 * Roles & Permissions S08.10 - the aggregator's payment entries, with the database stubbed. The routes and the real rows
 * are in permission-communication-payments-db.test.ts; this holds what is cheap to state here: which payments each tab
 * asks for, which rows count as money received, how an entry reads, and that only the per-source form of visibility can
 * open the entries at all.
 */

const ORG = 'o0000000-0000-0000-0000-000000000001';

const payment = (over: Record<string, unknown> = {}): any => ({
  id: 'p0000000-0000-0000-0000-000000000001',
  amount: '250.00',
  paid_at: new Date('2026-06-03T12:00:00Z'),
  created_by_source: 'USER',
  reference_number: null,
  refunded_at: null,
  refunded_amount: null,
  voided_at: null,
  invoice: {
    invoice_number: 'INV-7', kind: 'STANDARD', job_id: 'j1', job: { job_number: 'J-1' },
    customer: { id: 'c1', first_name: 'Pat', last_name: 'Payer', company_name: null },
    estimate: null,
  },
  ...over,
});

function stubDb(rows: unknown[] = [payment()]) {
  const none = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  return {
    callSession: none(), message: none(), email: none(), whatsAppMessage: none(), manualCommunicationLog: none(),
    estimate: none(), timelineEvent: none(), lostReasonOption: none(),
    payment: { findMany: vi.fn().mockResolvedValue(rows) },
  };
}

const perChannel = (payments: Record<string, unknown>): ChannelVisibility => ({
  perChannel: true, calls: {}, messages: {}, emails: {}, whatsapps: {}, manuals: {}, estimates: {}, payments,
});

const jobTab = (db: ReturnType<typeof stubDb>, payments: Record<string, unknown> = {}) =>
  getJobCommunications(db, { jobId: 'j1', organizationId: ORG, visibility: perChannel(payments) });

describe('payment entries (lib)', () => {
  it('asks for the counted payments of the record each tab belongs to, narrowed by the person\'s invoice reach', async () => {
    const reach = { invoice: { created_by_id: 'u-me' } };
    const jobDb = stubDb();
    await jobTab(jobDb, reach);
    const jobWhere = jobDb.payment.findMany.mock.calls[0][0].where;
    expect(jobWhere).toEqual(expect.objectContaining({ ...COUNTED_PAYMENT_WHERE }));
    expect(JSON.stringify(jobWhere)).toContain('"j1"');
    expect(jobWhere.AND).toContainEqual(reach);

    const leadDb = stubDb();
    await getLeadCommunications(leadDb, { leadId: 'l1', organizationId: ORG, visibility: perChannel(reach) });
    expect(JSON.stringify(leadDb.payment.findMany.mock.calls[0][0].where)).toContain('"l1"');

    const customerDb = stubDb();
    await getCustomerCommunications(customerDb, { customerId: 'c1', organizationId: ORG, visibility: perChannel(reach) });
    expect(JSON.stringify(customerDb.payment.findMany.mock.calls[0][0].where)).toContain('"c1"');
  });

  it('never counts the deposit credit a deposit hands to the final invoice, which is the same cash as the deposit', async () => {
    const db = stubDb();
    await jobTab(db);
    const where = db.payment.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain(DEPOSIT_CREDIT_REFERENCE);
  });

  it('reads no payment and lists no entry for a caller that hands in one shared filter, which cannot carry the invoice reach', async () => {
    const db = stubDb();
    const items = await getJobCommunications(db, { jobId: 'j1', organizationId: ORG, visibility: { OR: [{ job_id: null }] } });
    expect(db.payment.findMany).not.toHaveBeenCalled();
    expect(items.filter((i) => i.entry === 'payment_received')).toEqual([]);
  });

  it('puts a payment in the chronology as a portal-kind entry on the invoice\'s job, with the amount, the invoice and who paid', async () => {
    const items = await jobTab(stubDb());
    expect(items).toEqual([expect.objectContaining({
      id: 'p0000000-0000-0000-0000-000000000001', channel: 'portal', entry: 'payment_received', direction: 'in',
      who: 'Pat Payer', title: 'Payment received on invoice INV-7', amount: 250, jobId: 'j1', jobLabel: 'J-1',
      at: '2026-06-03T12:00:00.000Z',
    })]);
  });

  it('says a payment the customer made themselves was paid online, and one the office keyed was recorded by the office', async () => {
    const [online] = await jobTab(stubDb([payment({ created_by_source: 'CLIENT' })]));
    expect(online.paidVia).toBe('online');
    expect(online.preview).toBe('Paid online');
    for (const source of ['USER', 'SYSTEM', 'IMPORT', 'UNKNOWN']) {
      const [office] = await jobTab(stubDb([payment({ created_by_source: source })]));
      expect(office.paidVia).toBe('office');
      expect(office.preview).toBe('Recorded by the office');
    }
  });

  it('says a payment from before creators were tracked was paid online when the payment processor took it, whichever id it holds', async () => {
    for (const ids of [{ stripe_payment_intent_id: 'pi_1' }, { stripe_charge_id: 'ch_1' }, { stripe_checkout_session_id: 'cs_1' }]) {
      const [entry] = await jobTab(stubDb([payment({ created_by_source: 'UNKNOWN', ...ids })]));
      expect(entry.paidVia).toBe('online');
      expect(entry.preview).toBe('Paid online');
    }
  });

  it('reads the processor ids from the payment so a legacy online payment can be told from one the office keyed', async () => {
    const db = stubDb();
    await jobTab(db);
    const select = db.payment.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ stripe_payment_intent_id: true, stripe_charge_id: true, stripe_checkout_session_id: true });
  });

  it('names a deposit as a deposit', async () => {
    const row = payment();
    row.invoice = { ...row.invoice, kind: 'DEPOSIT', invoice_number: 'D-3' };
    const [entry] = await jobTab(stubDb([row]));
    expect(entry.title).toBe('Payment received on deposit D-3');
  });

  it('puts an invoice tied only by its estimate on that estimate\'s job, and a lead-stage deposit on the lead', async () => {
    const viaEstimate = payment();
    viaEstimate.invoice = {
      ...viaEstimate.invoice, kind: 'DEPOSIT', job_id: null, job: null,
      estimate: { job_id: 'j9', lead_id: 'l4', job_link: { job_number: 'J-9' }, lead: { lead_number: 'L-4' } },
    };
    const [converted] = await jobTab(stubDb([viaEstimate]));
    expect(converted).toEqual(expect.objectContaining({ jobId: 'j9', jobLabel: 'J-9', leadId: 'l4', leadLabel: 'L-4' }));

    const leadStage = payment();
    leadStage.invoice = {
      ...leadStage.invoice, kind: 'DEPOSIT', job_id: null, job: null,
      estimate: { job_id: null, lead_id: 'l4', job_link: null, lead: { lead_number: 'L-4' } },
    };
    const [onLead] = await jobTab(stubDb([leadStage]));
    expect(onLead.jobId).toBeUndefined();
    expect(onLead).toEqual(expect.objectContaining({ leadId: 'l4', leadLabel: 'L-4' }));
  });

  it('leaves out a payment that was given back whole, and keeps one that was only partly refunded', async () => {
    const whole = payment({ id: 'whole', refunded_at: new Date('2026-06-04T00:00:00Z'), refunded_amount: '250.00' });
    const legacyWhole = payment({ id: 'legacy', refunded_at: new Date('2026-06-04T00:00:00Z'), refunded_amount: null });
    const partly = payment({ id: 'partly', refunded_at: new Date('2026-06-04T00:00:00Z'), refunded_amount: '50.00' });
    const items = await jobTab(stubDb([whole, legacyWhole, partly]));
    expect(items.map((i) => i.id)).toEqual(['partly']);
    expect(items[0].amount).toBe(250);
  });

  it('never words an entry with a payment processor\'s name', async () => {
    const rows = [
      payment({ created_by_source: 'CLIENT', method: 'CARD', stripe_charge_id: 'ch_1', stripe_payment_intent_id: 'pi_1' }),
      payment({ id: 'office', created_by_source: 'USER', method: 'CASH' }),
    ];
    const items = await jobTab(stubDb(rows));
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toMatch(/stripe|square|paypal|processor|\bch_|\bpi_/i);
  });
});
