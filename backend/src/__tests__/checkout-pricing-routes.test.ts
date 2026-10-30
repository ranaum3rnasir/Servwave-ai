/**
 * Payments go-live slice 02 - the two public checkout doors price through the checkout pricing
 * module, so what reaches the processor carries no fee line and no application fee (D9).
 *
 * setup.ts mocks `../lib/stripe` wholesale. This file un-mocks it so the REAL session builder
 * runs, and replaces only the processor SDK with a recorder: the assertions are on the exact
 * params handed to the processor client's `checkout.sessions.create`, which is what decides what
 * the homeowner is charged.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = {
      sessions: {
        create: sessionsCreate,
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        expire: vi.fn().mockResolvedValue({}),
      },
    };
  },
}));

import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { ESTIMATE_SENT_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

const CONNECTED_ACCOUNT = 'acct_pricing_test';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-0000000000c2';

function connectedOrg() {
  return {
    id: 'org-pricing-1',
    stripe_account_id: CONNECTED_ACCOUNT,
    stripe_charges_enabled: true,
    accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'],
    // Tips are an org switch, off by default (slice 19); the tip cases here need it on.
    tips_enabled: true,
  };
}

function sentInvoice(amountDue: number, totalAmount: number = amountDue) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00042',
    status: amountDue < totalAmount ? 'PARTIAL' : 'SENT',
    kind: 'STANDARD',
    amount_due: amountDue,
    total_amount: totalAmount,
    estimate: null,
    customer: null,
    job: { customer: { first_name: 'Pat', last_name: 'Example', company_name: null } },
    organization: connectedOrg(),
    // No bank payment in flight: payable-now is the amount due (slice 12).
    payments: [],
  };
}

beforeAll(() => {
  // The real builder refuses to run without a processor key; the SDK itself is the recorder.
  (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_pricing_routes';
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionsCreate.mockResolvedValue({ id: 'cs_pricing_1', url: 'https://checkout.example/session' });
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
});

describe('POST /api/invoices/:id/public/checkout - priced with no fees', () => {
  it('opens a $100.00 card checkout at exactly $100.00: one line, no fee line, no application fee', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({});

    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = sessionsCreate.mock.calls[0];
    expect(params.line_items).toEqual([
      {
        price_data: { currency: 'usd', unit_amount: 10000, product_data: { name: 'Payment for Invoice I00042 — Pat Example' } },
        quantity: 1,
      },
    ]);
    expect(params.payment_intent_data?.application_fee_amount).toBeUndefined();
    expect(params.metadata).toEqual({ organizationId: 'org-pricing-1', invoiceId: INVOICE_ID, kind: 'invoice', payableNowCents: '10000' });
    // Still a direct charge on the contractor's own account.
    expect(requestOptions).toEqual({ stripeAccount: CONNECTED_ACCOUNT });
  });

  it('adds the tip as its own "Tip" line, still with no fee line and no application fee', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({ tip: 15 });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.line_items.map((li: { price_data: { unit_amount: number; product_data: { name: string } } }) => [
      li.price_data.product_data.name,
      li.price_data.unit_amount,
    ])).toEqual([
      ['Payment for Invoice I00042 — Pat Example', 10000],
      ['Tip', 1500],
    ]);
    expect(params.payment_intent_data?.application_fee_amount).toBeUndefined();
    expect(params.metadata).toEqual({ organizationId: 'org-pricing-1', invoiceId: INVOICE_ID, kind: 'invoice', payableNowCents: '10000', tipCents: '1500' });
  });

  it('accepts a tip equal to the invoice amount', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({ tip: 100 });

    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a tip over the invoice amount with 400, before anything reaches the processor', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({ tip: 100.01 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tip amount', code: 'TIP_OUT_OF_BOUNDS' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/public/checkout - tip cap on a partly paid invoice', () => {
  // A $1,000.00 invoice with $900.00 already paid: $100.00 due. The tip may be up to $1,000.00.
  it('accepts a $150.00 tip that exceeds the $100.00 due but not the $1,000.00 invoice', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100, 1000));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({ tip: 150 });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.line_items.map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount)).toEqual([10000, 15000]);
  });

  it('refuses a $1,000.01 tip, one cent over the invoice amount, with 400', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(100, 1000));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/public/checkout?token=tok-pricing`)
      .send({ tip: 1000.01 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tip amount', code: 'TIP_OUT_OF_BOUNDS' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/approve (card deposit) - priced with no fees', () => {
  const depositEstimate = {
    id: ESTIMATE_SENT_FIXTURE.id,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    organization_id: 'org-pricing-1',
    lead: { commission_owner_id: null, status: 'ESTIMATED' },
    total_amount: 1000,
    valid_until: new Date('2027-12-31'),
    signature_data: null,
    deposit: null,
    invoices: [{ id: 'dep-inv-pricing', status: 'SENT', total_amount: 250, amount_due: 250 }],
    send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK'] },
    organization: connectedOrg(),
  };

  it('opens the $250.00 deposit checkout at exactly $250.00: one line, no fee line, no application fee', async () => {
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(depositEstimate)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = sessionsCreate.mock.calls[0];
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: 'usd',
          unit_amount: 25000,
          product_data: { name: `Deposit for Estimate ${ESTIMATE_SENT_FIXTURE.estimate_number}` },
        },
        quantity: 1,
      },
    ]);
    expect(params.payment_intent_data?.application_fee_amount).toBeUndefined();
    expect(params.metadata).toEqual({
      organizationId: 'org-pricing-1',
      invoiceId: 'dep-inv-pricing',
      estimateId: ESTIMATE_SENT_FIXTURE.id,
      kind: 'deposit',
      payableNowCents: '25000',
    });
    expect(requestOptions).toEqual({ stripeAccount: CONNECTED_ACCOUNT });
  });
});
