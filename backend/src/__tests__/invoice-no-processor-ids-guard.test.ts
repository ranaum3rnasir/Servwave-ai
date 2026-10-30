/**
 * Payments go-live slice 33 (fix round 2) - NO processor id value reaches the browser from an
 * invoice response. Staging acceptance found `invoice.refunds[].stripe_refund_id` ("re_...") on
 * GET /api/invoices/:id. This guard walks the responses at any depth and fails on any key shaped
 * like a processor id column that holds a non-null string.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, INVOICE_FIXTURE, JOB_FIXTURE, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const ID_KEY = /^(stripe_.*_id|processor_.*_id|payment_intent)$/;
// STRICT shape: a segment of 14+ alphanumerics holding a digit, a lowercase and an uppercase letter.
const ID_VALUE = /^(evt|re|pi|ch|py|cs|dp|du|pm|src|card|ba|acct|cus|txn|po|tr|trr|fee|fr|seti|in|sub|file|link|mandate|pmc)_(?:[A-Za-z0-9]+_)*(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{14,}(?:_[A-Za-z0-9]+)*$/;
const FIXTURE_ID = '1Q9xYzAbCdEfGhIjKlMnOpQr'; // made up

/** Every path at which a processor-id-shaped key holds a non-null string, or ANY string value is id-shaped. */
function processorIdLeaks(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return ID_VALUE.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => processorIdLeaks(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      ID_KEY.test(k) && typeof v === 'string' ? [`${path}.${k}`] : processorIdLeaks(v, `${path}.${k}`));
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('invoice responses carry no processor id values', () => {
  it('GET /api/invoices/:id strips refund ids, payment intent ids and the dispute id', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      ...INVOICE_FIXTURE,
      stripe_dispute_id: `dp_${FIXTURE_ID}`,
      po_number: 'po_45000123',
      job: { ...INVOICE_FIXTURE.job, assignees: [{ user_id: TEST_USERS.technician.id }] },
      payments: [{ id: 'pay-1', amount: 100, method: 'CARD', state: 'SUCCEEDED', voided_at: null, reference: 'ch_10023456', stripe_payment_intent_id: `pi_${FIXTURE_ID}` }],
      refunds: [
        { id: 'ref-1', payment_id: 'pay-1', amount: 40, state: 'SUCCEEDED', method: 'CARD', stripe_refund_id: `re_${FIXTURE_ID}` },
        { id: 'ref-2', payment_id: null, amount: 10, state: 'SUCCEEDED', method: 'CASH', stripe_refund_id: null },
      ],
    });

    const res = await request(app).get(`/api/invoices/${INVOICE_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(`re_${FIXTURE_ID}`);
    expect(processorIdLeaks(res.body)).toEqual([]);
    expect(res.body.invoice.refunds).toHaveLength(2);
    // Typed user data in the same document is never dropped by the value shape.
    expect(res.body.invoice.po_number).toBe('po_45000123');
    expect(res.body.invoice.payments[0].reference).toBe('ch_10023456');
  });

  it('GET /api/invoices/:id/timeline strips processor ids from event metadata', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { id: 'e1', event_type: 'PAYMENT_RECEIVED', description: 'x', created_at: new Date(), creator: null,
        metadata: { payment_id: 'pay-1', event_id: `evt_${FIXTURE_ID}`, stripe_payment_intent_id: `pi_${FIXTURE_ID}`, payment_intent: `pi_${FIXTURE_ID}`, method: 'ACH', anything: `ch_${FIXTURE_ID}` } },
      { id: 'e2', event_type: 'INVOICE_DISPUTED', description: 'x', created_at: new Date(), creator: null,
        metadata: { processor_dispute_id: `dp_${FIXTURE_ID}`, payment_id: 'pay-1' } },
    ]);

    const res = await request(app).get(`/api/invoices/${INVOICE_FIXTURE.id}/timeline`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(processorIdLeaks(res.body)).toEqual([]);
    expect(res.body.events[0].metadata).toMatchObject({ payment_id: 'pay-1', method: 'ACH' });
    expect(res.body.events[0].metadata).not.toHaveProperty('anything');
  });

  it('GET /api/jobs/:id/timeline (which lists the job invoices\' money events) strips processor ids', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE });
    mockPrisma.job.findFirst.mockResolvedValue({ ...JOB_FIXTURE });
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: INVOICE_FIXTURE.id }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { id: 'e1', entity_type: 'INVOICE', entity_id: INVOICE_FIXTURE.id, event_type: 'PAYMENT_RECEIVED', description: 'x',
        created_at: new Date(), creator: null, metadata: { payment_id: 'pay-1', event_id: `evt_${FIXTURE_ID}`, payment_intent: `pi_${FIXTURE_ID}`, method: 'ACH' } },
    ]);

    const res = await request(app).get(`/api/jobs/${JOB_FIXTURE.id}/timeline`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(processorIdLeaks(res.body)).toEqual([]);
  });

  it('the guard itself catches a leak at any depth', () => {
    expect(processorIdLeaks({ a: [{ b: { stripe_refund_id: 're_x' } }] })).toEqual(['$.a[0].b.stripe_refund_id']);
    expect(processorIdLeaks({ stripe_refund_id: null })).toEqual([]);
    expect(processorIdLeaks({ m: { event_id: `evt_${FIXTURE_ID}` }, l: [`re_${FIXTURE_ID}`] })).toEqual(['$.m.event_id', '$.l[0]']);
    expect(processorIdLeaks({ p: 'po_45000123', c: 'ch_10023456', t: 'tr_20261011' })).toEqual([]);
    expect(processorIdLeaks({ a: 'in_person', b: 'f8afb5f7-7927-4ee0-a9fc-7a8f1cbfa344' })).toEqual([]);
  });
});
