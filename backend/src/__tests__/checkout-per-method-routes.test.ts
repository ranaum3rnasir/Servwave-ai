/**
 * Payments go-live slice 12 - a checkout session carries exactly one method.
 *
 * - card: `payment_method_types: ['card']` (the hosted page then also offers Apple Pay, Google Pay
 *   and Link on a supported browser);
 * - bank: `payment_method_types: ['us_bank_account']`, verified instantly through a bank login with
 *   micro-deposits as the fallback (`verification_method: 'automatic'`).
 *
 * The amount offered is payable-now: the amount due less the bank payments still PROCESSING on the
 * invoice.
 *
 * setup.ts mocks `../lib/stripe` wholesale. This file un-mocks it so the REAL session builder runs,
 * and replaces only the processor SDK with a recorder: the assertions are on the exact params handed
 * to the processor client's `checkout.sessions.create`.
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

const CONNECTED_ACCOUNT = 'acct_per_method_test';
const ORG_ID = 'org-per-method-1';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-0000000000d2';
const CHECKOUT_URL = `/api/invoices/${INVOICE_ID}/public/checkout?token=tok-per-method`;

/** An org whose account can take both cards and bank payments. */
function cardAndBankOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    stripe_account_id: CONNECTED_ACCOUNT,
    stripe_charges_enabled: true,
    accepted_payment_methods: ['CHECK', 'CASH', 'CARD', 'ACH'],
    tips_enabled: true,
    ...overrides,
  };
}

function sentInvoice(opts: {
  amountDue?: number;
  totalAmount?: number;
  org?: Record<string, unknown>;
  processing?: number[];
} = {}) {
  const amountDue = opts.amountDue ?? 100;
  const totalAmount = opts.totalAmount ?? amountDue;
  return {
    id: INVOICE_ID,
    invoice_number: 'I00077',
    status: amountDue < totalAmount ? 'PARTIAL' : 'SENT',
    kind: 'STANDARD',
    amount_due: amountDue,
    total_amount: totalAmount,
    estimate: null,
    customer: { first_name: 'Sam', last_name: 'Example', company_name: null },
    job: null,
    organization: cardAndBankOrg(opts.org),
    payment_methods_override: null,
    payments: (opts.processing ?? []).map((amount) => ({ amount })),
  };
}

beforeAll(() => {
  // The real builder refuses to run without a processor key; the SDK itself is the recorder.
  (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_per_method_routes';
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionsCreate.mockResolvedValue({ id: 'cs_per_method_1', url: 'https://checkout.example/session' });
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
});

describe('POST /api/invoices/:id/public/checkout - one method per session', () => {
  it('a bank request opens a bank-only session, verified instantly with micro-deposits as the fallback', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice());

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkout_url: 'https://checkout.example/session' });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = sessionsCreate.mock.calls[0];
    expect(params.payment_method_types).toEqual(['us_bank_account']);
    expect(params.payment_method_options).toEqual({
      us_bank_account: {
        verification_method: 'automatic',
        financial_connections: { permissions: ['payment_method'] },
      },
    });
    expect(requestOptions).toEqual({ stripeAccount: CONNECTED_ACCOUNT });
  });

  it('a card request opens a card-only session with no bank options', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice());

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'card' });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.payment_method_options).toBeUndefined();
  });
});

describe('POST /api/invoices/:id/public/checkout - which method the account can take', () => {
  const VENDOR_NAMES = /stripe|plaid|financial connections/i;

  it('refuses a method it does not know with 400, before anything reaches the processor', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice());

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'crypto' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid payment method' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a bank session when the account cannot take bank payments, in ServWave words', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(
      sentInvoice({ org: { accepted_payment_methods: ['CHECK', 'CASH', 'CARD'] } }),
    );

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bank payments are not enabled for this organization' });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_NAMES);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('opens a bank session for an account that can take bank payments but not cards, and refuses its card request', async () => {
    const bankOnlyAccount = { org: { accepted_payment_methods: ['CHECK', 'ACH'] } };
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice(bankOnlyAccount));

    const bank = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });
    expect(bank.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].payment_method_types).toEqual(['us_bank_account']);

    sessionsCreate.mockClear();
    const card = await request(app).post(CHECKOUT_URL).send({ method: 'card' });
    expect(card.status).toBe(400);
    expect(card.body).toEqual({ error: 'Card payments are not enabled for this organization' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses a bank session on an invoice whose methods leave bank out', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      ...sentInvoice(),
      payment_methods_override: ['CARD', 'CHECK'],
    });

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bank payments are not offered on this invoice', code: 'PAYMENT_OPTIONS_CHANGED' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/public/checkout - the amount offered is payable-now', () => {
  // $100.00 due, of which a $40.00 bank payment is still processing: $60.00 can be paid now.
  it('charges the amount due less the payments still processing', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice({ amountDue: 100, processing: [40] }));

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'card' });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.line_items.map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount)).toEqual([6000]);
  });

  it('refuses a checkout while everything due is already processing, before anything reaches the processor', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice({ amountDue: 100, processing: [60, 40] }));

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'A payment for this invoice is already processing', code: 'PAYMENT_PROCESSING' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/public/checkout - what the session says it was built against', () => {
  it('carries the org, the invoice, the kind, the payable-now amount and the tip', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice({ amountDue: 100, processing: [40] }));

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank', tip: 15 });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.metadata).toEqual({
      organizationId: ORG_ID,
      invoiceId: INVOICE_ID,
      kind: 'invoice',
      payableNowCents: '6000',
      tipCents: '1500',
    });
  });

  it('names a deposit invoice paid through the invoice link as a deposit', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ ...sentInvoice({ amountDue: 250 }), kind: 'DEPOSIT' });

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'card' });

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.metadata).toEqual({
      organizationId: ORG_ID,
      invoiceId: INVOICE_ID,
      kind: 'deposit',
      payableNowCents: '25000',
    });
  });
});

describe('POST /api/estimates/:id/approve - the deposit checkout takes the chosen method', () => {
  const APPROVE_URL = `/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`;

  function depositEstimate(org: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      organization_id: ORG_ID,
      lead: { commission_owner_id: null, status: 'ESTIMATED' },
      total_amount: 1000,
      valid_until: new Date('2027-12-31'),
      signature_data: null,
      deposit: null,
      invoices: [{ id: 'dep-inv-per-method', status: 'SENT', total_amount: 250, amount_due: 250 }],
      send_config: { deposit_required: true, payment_methods: ['CARD', 'ACH', 'CHECK'] },
      organization: cardAndBankOrg(org),
    };
  }

  function approveWith(paymentMethod: string, org: Record<string, unknown> = {}) {
    mockPrisma.estimate.findFirst
      .mockReset()
      .mockResolvedValueOnce(depositEstimate(org))
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    return request(app)
      .post(APPROVE_URL)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: paymentMethod });
  }

  it('a bank deposit opens a bank-only session for the deposit, named as a deposit', async () => {
    const res = await approveWith('ACH');

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/session');
    const [params, requestOptions] = sessionsCreate.mock.calls[0];
    expect(params.payment_method_types).toEqual(['us_bank_account']);
    expect(params.payment_method_options.us_bank_account.verification_method).toBe('automatic');
    expect(params.line_items.map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount)).toEqual([25000]);
    expect(params.metadata).toEqual({
      organizationId: ORG_ID,
      invoiceId: 'dep-inv-per-method',
      estimateId: ESTIMATE_SENT_FIXTURE.id,
      kind: 'deposit',
      payableNowCents: '25000',
    });
    expect(requestOptions).toEqual({ stripeAccount: CONNECTED_ACCOUNT });
  });

  it('a card deposit opens a card-only session', async () => {
    const res = await approveWith('CARD');

    expect(res.status).toBe(200);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.payment_method_options).toBeUndefined();
  });

  it('refuses a bank deposit when the account cannot take bank payments, before anything reaches the processor', async () => {
    const res = await approveWith('ACH', { accepted_payment_methods: ['CHECK', 'CARD'] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bank payments are not enabled for this organization' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

// Slice 13 records a bank payment as PROCESSING the moment its checkout completes, so payable-now
// sees money in flight and slice 12's server switch (and its two refusals) is gone: both public
// doors open a bank checkout. A deposit's estimate goes WON when its debit starts (call 3), so a
// payment retry cannot open a second deposit session while the first debit clears.
describe('the bank checkout is open at both public doors', () => {
  const APPROVE_URL = `/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`;

  function bankDeposit(status: 'SENT' | 'PENDING') {
    return {
      id: ESTIMATE_SENT_FIXTURE.id,
      status,
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      organization_id: ORG_ID,
      lead: { commission_owner_id: null, status: 'ESTIMATED' },
      total_amount: 1000,
      valid_until: new Date('2027-12-31'),
      // A PENDING estimate with a signature is a payment retry: the customer signed, then left.
      signature_data: status === 'PENDING' ? 'data:image/png;base64,signed' : null,
      deposit: null,
      invoices: [{ id: 'dep-inv-per-method', status: 'SENT', total_amount: 250, amount_due: 250 }],
      send_config: { deposit_required: true, payment_methods: ['CARD', 'ACH', 'CHECK'] },
      organization: cardAndBankOrg(),
    };
  }

  it('opens a bank checkout on an invoice', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(sentInvoice());

    const res = await request(app).post(CHECKOUT_URL).send({ method: 'bank' });

    expect(res.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].payment_method_types).toEqual(['us_bank_account']);
  });

  it('opens a bank deposit checkout at first approval', async () => {
    mockPrisma.estimate.findFirst.mockReset().mockResolvedValue(bankDeposit('SENT'));

    const res = await request(app)
      .post(APPROVE_URL)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'ACH' });

    expect(res.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].payment_method_types).toEqual(['us_bank_account']);
  });

  it('opens a bank deposit checkout on a payment retry (signed, PENDING: no debit has started)', async () => {
    mockPrisma.estimate.findFirst.mockReset().mockResolvedValue(bankDeposit('PENDING'));

    const res = await request(app).post(APPROVE_URL).send({ payment_method: 'ACH' });

    expect(res.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0].payment_method_types).toEqual(['us_bank_account']);
  });

  it('refuses a payment retry once the deposit debit started: the estimate is already WON', async () => {
    mockPrisma.estimate.findFirst.mockReset().mockResolvedValue({ ...bankDeposit('PENDING'), status: 'WON' });

    const res = await request(app).post(APPROVE_URL).send({ payment_method: 'ACH' });

    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
