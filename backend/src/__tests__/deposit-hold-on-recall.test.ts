/**
 * #2031 slice 5 — recalling an estimate to draft suspends its deposit link.
 *
 * Back to draft nulls the ESTIMATE's own public token, clears the signature, the T&C acceptance
 * and the changed-since-sent flag. The deposit invoice minted at the first send survives all of
 * it: its own public_token stays live, it stays SENT, and it keeps asking for the amount the old
 * total produced. Worse, clearing `modified_after_send` is itself enough to reopen the money door
 * on an estimate that had been flagged — the recall UNDID the only thing standing between the
 * customer and a stale figure.
 *
 * Ran's decision: suspend, do not void. The document stays, the link stays, the token stays, and
 * the deposit simply declines to take money until the estimate is sent again — which re-prices it
 * through the same link. So every door the money can come through has to ask the same question:
 * the public page, the checkout POST, the webhook that settles a session opened earlier, and the
 * processor itself (a session already open is killed at the moment of recall).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendDepositPaymentConfirmation } from '../lib/email';
import { isStripeConfigured, createCheckoutSession, getStripeForOrg, expireOpenCheckoutSessionsForInvoice } from '../lib/stripe';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, ESTIMATE_SENT_FIXTURE, TEST_USERS, ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;
const mockDepositReceipt = sendDepositPaymentConfirmation as unknown as ReturnType<typeof vi.fn>;
const mockIsStripeConfigured = isStripeConfigured as ReturnType<typeof vi.fn>;
const mockCreateCheckoutSession = createCheckoutSession as ReturnType<typeof vi.fn>;
const mockGetStripeForOrg = getStripeForOrg as ReturnType<typeof vi.fn>;
const mockExpireOpenSessions = expireOpenCheckoutSessionsForInvoice as unknown as ReturnType<typeof vi.fn>;

const ORG = {
  id: 'org_stripe_1',
  stripe_account_id: 'acct_test',
  accepted_payment_methods: ['CARD'],
  stripe_payouts_enabled: true,
  name: 'Test Org',
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 50,
  deposit_default_fixed_amount: 0,
};

const DEPOSIT_INVOICE_ID = 'd1000000-0000-0000-0000-000000000001';

/**
 * The deposit document exactly as the customer holds it: $500, which is 50% of the $1,000 total
 * the estimate had when it went out. `estimateStatus` is the whole experiment — the figures agree
 * either way, so nothing but the recall can be what refuses the money.
 */
function depositInvoice(estimateStatus: string, over: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_INVOICE_ID,
    invoice_number: 'I00009',
    status: 'SENT',
    kind: 'DEPOSIT',
    amount_due: 500,
    total_amount: 500,
    organization_id: ORG.id,
    organization: ORG,
    customer: null,
    job: null,
    estimate: {
      id: 'f0000000-0000-0000-0000-000000000001',
      lead_id: 'e0000000-0000-0000-0000-000000000001',
      estimate_number: 'EST-2026-0001',
      total_amount: 1000,
      status: estimateStatus,
      // The recall CLEARED this flag. That is the point: the superseded predicate alone sees an
      // estimate in perfect step with its deposit.
      modified_after_send: false,
      deposit_type: null,
      deposit_value: null,
      creator: { email: 'creator@example.com' },
      organization: { name: 'Test Org', logo_url: null, brand_color: null },
      customer: { id: 'c1', first_name: 'Pat', last_name: 'Q', company_name: null, email: 'pat@example.com' },
      lead: { commission_owner_id: null, status: 'ESTIMATED', customer: null },
    },
    ...over,
  };
}

function checkoutSession(over: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    object: 'checkout.session',
    payment_intent: 'pi_test_abc',
    amount_total: 50000,
    metadata: { invoiceId: DEPOSIT_INVOICE_ID },
    ...over,
  };
}

function postWebhook(body: object) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test_sig')
    .send(Buffer.from(JSON.stringify({ id: 'evt_recall_1', type: 'checkout.session.completed', data: { object: body } })));
}

/**
 * Runs the money transaction for real against recording stubs. Without this the assertions below
 * would be vacuous: the default `$transaction` mock never invokes its callback, so "the estimate
 * was not won" would hold on the broken code too.
 */
function recordingTransaction() {
  const tx = {
    stripeEvent: { create: vi.fn().mockResolvedValue({}) },
    payment: { create: vi.fn().mockResolvedValue({ id: 'pay-1' }) },
    invoice: { update: vi.fn().mockResolvedValue({}) },
    estimate: { update: vi.fn().mockResolvedValue({}) },
    lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn().mockResolvedValue({}) },
    timelineEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  mockPrisma.$transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.payment.count.mockResolvedValue(0);
});

describe('a deposit checkout that settles after the estimate was recalled to draft', () => {
  it('records no payment, wins nothing and emails no receipt', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice('DRAFT'));
    const tx = recordingTransaction();

    const res = await postWebhook(checkoutSession());

    expect(res.status).toBe(200);
    expect(tx.payment.create).not.toHaveBeenCalled();
    // The estimate is in the salesperson's hands; a card settling must not declare it won.
    expect(tx.estimate.update).not.toHaveBeenCalled();
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
    // And the customer is not thanked for a deposit on a document that was withdrawn.
    expect(mockDepositReceipt).not.toHaveBeenCalled();
  });

  /**
   * The control that makes the refusal above mean something. Identical fixture, identical figures,
   * identical session — only the estimate's status differs. If this one did not take the money,
   * the test above would be passing for some unrelated reason.
   */
  it('takes the money as usual when the estimate has not been recalled', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice('SENT'));
    const tx = recordingTransaction();

    const res = await postWebhook(checkoutSession());

    expect(res.status).toBe(200);
    expect(tx.payment.create).toHaveBeenCalledTimes(1);
    expect(tx.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WON' }) }),
    );
    expect(mockDepositReceipt).toHaveBeenCalledTimes(1);
  });
});

/**
 * The door the customer actually knocks on: the deposit invoice's own public link, which the
 * recall does not rotate, does not void and does not expire.
 */
describe('the public deposit link while the estimate is recalled to draft', () => {
  /** The checkout door's view of the same document. */
  function checkoutInvoice(estimateStatus: string, over: Record<string, unknown> = {}) {
    return {
      id: DEPOSIT_INVOICE_ID,
      invoice_number: 'I00009',
      status: 'SENT',
      kind: 'DEPOSIT',
      amount_due: 500,
      total_amount: 500,
      customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
      job: null,
      estimate: {
        status: estimateStatus,
        modified_after_send: false,
        deposit_type: null,
        deposit_value: null,
        total_amount: 1000,
      },
      organization: {
        id: ORG.id,
        stripe_account_id: 'acct_test',
        accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true,
        deposit_default_type: 'PERCENTAGE',
        deposit_default_percentage: 50,
        deposit_default_fixed_amount: 0,
      },
      ...over,
    };
  }

  function payTheLink() {
    return request(app).post(`/api/invoices/${DEPOSIT_INVOICE_ID}/public/checkout?token=deposit-link-token`);
  }

  beforeEach(() => {
    // The door reads the invoice twice (the guard, then the post-create re-check), so a queued
    // once-value left over from another test would answer the wrong read.
    mockPrisma.invoice.findFirst.mockReset();
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockIsStripeConfigured.mockReturnValue(true);
    mockGetStripeForOrg.mockReturnValue({ stripe: {}, stripeAccount: undefined });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.example/test' });
  });

  it('refuses to open a payment, and says why in words a customer can act on', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(checkoutInvoice('DRAFT'));

    const res = await payTheLink();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'This deposit request is on hold while the estimate is being updated. Please contact us if you would like to pay it now.',
      // Its own code: the page has to be able to tell "withdrawn for changes" from "the amount
      // moved", because they are different things to be told.
      code: 'DEPOSIT_ON_HOLD',
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('opens the payment as usual when the estimate has not been recalled', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(checkoutInvoice('SENT'));

    const res = await payTheLink();

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/test');
  });

  /**
   * The mocked Prisma answers whatever the fixture says regardless of what was selected, so a
   * `select` that never asks for the estimate's status would read `undefined`, never 'DRAFT', and
   * reopen the door in production while every test above stayed green. Assert on the query.
   */
  it('asks the database for the estimate status it refuses on', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(checkoutInvoice('SENT'));

    await payTheLink();

    const select = mockPrisma.invoice.findFirst.mock.calls[0][0].select;
    expect(select.estimate.select.status).toBe(true);
  });
});

/**
 * What the page is told when the customer opens the link. It has to withdraw the payment options
 * rather than walk the customer into the refusal above — and it has to be able to say WHICH of the
 * two holds this is, because "we are updating your estimate" and "this amount is out of date" are
 * different things to read.
 */
describe('the public deposit page payload while the estimate is recalled to draft', () => {
  function publicRow(estimateStatus: string, modifiedAfterSend = false, estimateTotal = 1000) {
    return {
      id: DEPOSIT_INVOICE_ID,
      invoice_number: 'I00009',
      organization_id: ORG.id,
      status: 'SENT',
      kind: 'DEPOSIT',
      amount_due: 500,
      total_amount: 500,
      subtotal: 500,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      estimate: {
        status: estimateStatus,
        modified_after_send: modifiedAfterSend,
        deposit_type: null,
        deposit_value: null,
        total_amount: estimateTotal,
      },
      customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
      line_items: [],
      job: null,
    };
  }

  beforeEach(() => {
    mockPrisma.invoice.findFirst.mockReset();
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Org', logo_url: null, brand_color: null, phone: null, timezone: null,
      accepted_payment_methods: ['CARD'], stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
  });

  function loadThePage() {
    return request(app).get(`/api/invoices/${DEPOSIT_INVOICE_ID}/public?token=deposit-link-token`);
  }

  it('names the recall as the reason, and still renders the document', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(publicRow('DRAFT'));

    const res = await loadThePage();

    expect(res.status).toBe(200);
    expect(res.body.deposit_hold_reason).toBe('ESTIMATE_IN_DRAFT');
    // The link is suspended, not dead: the customer can still see what they were sent.
    expect(res.body.invoice.id).toBe(DEPOSIT_INVOICE_ID);
    // And the estimate's internal state is still not part of the customer's payload.
    expect(res.body.invoice.estimate).toBeUndefined();
  });

  it('reports no hold at all once the estimate is out with the customer again', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(publicRow('SENT'));

    const res = await loadThePage();

    expect(res.body.deposit_hold_reason).toBeNull();
  });

  // The page and the money door answer to one predicate, so the OTHER hold still reports itself.
  it('still reports a superseded figure as superseded', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(publicRow('SENT', true, 1912.5));

    const res = await loadThePage();

    expect(res.body.deposit_hold_reason).toBe('SUPERSEDED');
  });

  it('asks the database for the estimate status it holds on', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(publicRow('SENT'));

    await loadThePage();

    const select = mockPrisma.invoice.findFirst.mock.calls[0][0].select;
    expect(select.estimate.select.status).toBe(true);
  });
});

/**
 * A session the customer opened BEFORE the recall is already live at the processor and settles by
 * itself. Refusing to open new ones does nothing about it, and the webhook backstop only catches
 * it after the card has been charged. So the recall kills it, exactly as a material edit does.
 */
describe('a checkout already open when the estimate is recalled', () => {
  /** setStatusInternal's own read of the estimate it is about to move. */
  function recalledEstimateRow(depositInvoices: unknown[]) {
    return {
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'ESTIMATED' },
      invoices: depositInvoices,
    };
  }

  /** The guard's own org-scoped read of the deposit document. */
  function sweepableDeposit(over: Record<string, unknown> = {}) {
    return {
      id: DEPOSIT_INVOICE_ID,
      invoice_number: 'I00009',
      organization_id: ALPHA_ORG_ID,
      total_amount: 500,
      estimate: { deposit_type: null, deposit_value: null, total_amount: 1000 },
      organization: {
        stripe_account_id: 'acct_test',
        deposit_default_type: 'PERCENTAGE',
        deposit_default_percentage: 50,
        deposit_default_fixed_amount: 0,
      },
      ...over,
    };
  }

  function stubRecallTransaction() {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      estimate: { update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT', public_token: null }) },
      estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
  }

  function recall() {
    return request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });
  }

  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.invoice.findFirst.mockReset();
    mockExpireOpenSessions.mockResolvedValue({ expired: ['cs_live_1'], failed: 0, ok: true });
    stubRecallTransaction();
  });

  it('is expired at the processor', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimateRow([{ id: DEPOSIT_INVOICE_ID, status: 'SENT', payments: [] }]));
    mockPrisma.invoice.findFirst.mockResolvedValue(sweepableDeposit());

    const res = await recall();

    expect(res.status).toBe(200);
    expect(mockExpireOpenSessions).toHaveBeenCalledTimes(1);
    expect(mockExpireOpenSessions.mock.calls[0][0]).toBe(DEPOSIT_INVOICE_ID);
    // Only this org's deposit document is ever swept.
    const where = mockPrisma.invoice.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.kind).toBe('DEPOSIT');
  });

  /**
   * Absolute: a deposit with money against it is not this guard's business. The sweep's own
   * status filter is what keeps a PAID deposit's row out of reach — nothing here may write to it,
   * expire against it, or reason about it.
   */
  it('leaves a paid deposit entirely alone', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimateRow([{ id: DEPOSIT_INVOICE_ID, status: 'PAID', payments: [{ id: 'pay-1' }] }]));
    // The guard's query excludes settled rows, so it finds nothing to sweep.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await recall();

    expect(res.status).toBe(200);
    expect(mockExpireOpenSessions).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.findFirst.mock.calls[0][0].where.status.in).toEqual(
      expect.not.arrayContaining(['PAID']),
    );
  });

  /**
   * The call is external. What it must never do is fail the recall — a salesperson pulling a
   * document back cannot be blocked by the card processor — and what it must never do is let the
   * recall finish believing a session is dead that is in fact still able to settle.
   */
  it('still recalls the estimate, and says so on the record, when the session could not be killed', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimateRow([{ id: DEPOSIT_INVOICE_ID, status: 'SENT', payments: [] }]));
    mockPrisma.invoice.findFirst.mockResolvedValue(sweepableDeposit());
    mockExpireOpenSessions.mockResolvedValue({ expired: [], failed: 1, ok: false });

    const res = await recall();

    expect(res.status).toBe(200);
    const audit = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(audit.some((row: any) => row.action === 'estimate.deposit_checkout_expiry_failed')).toBe(true);
  });

  it('does not touch the processor on a move that is not a recall', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimateRow([{ id: DEPOSIT_INVOICE_ID, status: 'SENT', payments: [] }]));
    mockPrisma.invoice.findFirst.mockResolvedValue(sweepableDeposit());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'PENDING' });

    expect(res.status).toBe(200);
    expect(mockExpireOpenSessions).not.toHaveBeenCalled();
  });
});

/**
 * The other half of the policy: the suspension has to LIFT, and it has to lift on the document the
 * customer already holds. Sending the recalled estimate again re-prices that same deposit invoice
 * behind that same token — no second document, no second link, so "two live payable links for one
 * deposit at two different amounts" stays impossible by construction rather than by vigilance.
 */
describe('sending a recalled estimate again', () => {
  const RECALLED_ESTIMATE_ID = ESTIMATE_FIXTURE.id;
  const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

  /** The estimate as the recall left it: DRAFT, no public token, flag cleared, total now $2,000. */
  function recalledEstimate(overrides: Record<string, unknown> = {}) {
    return {
      id: RECALLED_ESTIMATE_ID,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 2000,
      public_token: null,
      valid_until: null,
      modified_after_send: false,
      version: 3,
      customer_id: CUSTOMER_ID,
      created_by: TEST_USERS.admin.id,
      deposit_type: null,
      deposit_value: null,
      _count: { line_items: 2 },
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: 'ESTIMATED',
        customer: { id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Q', company_name: null, email: 'pat@example.com' },
      },
      customer: { id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Q', company_name: null, email: 'pat@example.com' },
      send_config: null,
      job_id: null,
      job: null,
      job_link: null,
      ...overrides,
    };
  }

  function stubSendTransaction(depositInvoice: unknown) {
    const tx = {
      estimate: {
        update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
        findUnique: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
      },
      estimateSendConfig: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
      },
      invoice: {
        findFirst: vi.fn().mockResolvedValue(depositInvoice),
        create: vi.fn().mockResolvedValue({ id: 'dep-new' }),
        update: vi.fn().mockResolvedValue({ id: 'dep-1' }),
      },
      invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
      estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockPrisma.$transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
    return tx;
  }

  function send() {
    return request(app)
      .post(`/api/estimates/${RECALLED_ESTIMATE_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });
  }

  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.visit.count.mockResolvedValue(0);
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ALPHA_ORG_ID, name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
  });

  it('re-prices the deposit the customer already holds instead of minting a second one', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimate());
    const tx = stubSendTransaction({
      id: 'dep-1', invoice_number: 'I00009', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await send();

    expect(res.status).toBe(200);
    // No second deposit document, and therefore no second payable link. The mocked client answers
    // the fixture whatever is asked of it, so "it found the existing one" is only true if the
    // query actually looked for THIS estimate's deposit, in THIS org — a lookup that missed would
    // find nothing and mint a second payable link while this assertion stayed green.
    expect(tx.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        estimate_id: RECALLED_ESTIMATE_ID,
        kind: 'DEPOSIT',
        organization_id: ALPHA_ORG_ID,
      }),
    }));
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    const args = tx.invoice.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'dep-1' });
    expect(Number(args.data.total_amount)).toBe(1000);
    expect(Number(args.data.amount_due)).toBe(1000);
    // THE SAME LINK. The re-price rewrites the figures and nothing else: the token the customer was
    // emailed is not rotated, not cleared and not re-minted, so the link they already have is the
    // link that starts working again.
    expect(args.data).not.toHaveProperty('public_token');
    expect(args.data).not.toHaveProperty('status');
  });

  it('leaves a deposit that has already been paid exactly as it is', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(recalledEstimate());
    const tx = stubSendTransaction({
      id: 'dep-1', invoice_number: 'I00009', status: 'PAID', total_amount: 531.25, _count: { payments: 1 },
    });

    const res = await send();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });
});

/**
 * A capture the system refuses to apply must never vanish: the card HAS been charged by the time
 * the webhook looks at it, and the event is recorded, so the processor will not re-deliver. This
 * is the only moment anyone will ever hear about that money — and what it says has to be true, or
 * whoever picks it up goes looking for a change to the estimate that never happened.
 */
describe('the record left behind when a recalled deposit is charged anyway', () => {
  it('names the recall, not a change of amount', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice('DRAFT'));
    recordingTransaction();

    await postWebhook(checkoutSession());

    const rows = mockPrisma.timelineEvent.create.mock.calls.map((c: any[]) => c[0].data);
    const row = rows.find((d: any) => d.event_type === 'PAYMENT_UNRECORDED');
    expect(row).toBeDefined();
    expect(row.entity_id).toBe(DEPOSIT_INVOICE_ID);
    expect(row.organization_id).toBe(ORG.id);
    expect(row.metadata).toMatchObject({
      reason: 'DEPOSIT_ON_HOLD',
      charged_cents: 50000,
      payment_intent: 'pi_test_abc',
    });
    expect(row.description).toMatch(/sent back to draft/i);
    // No vendor and no account number in anything a person reads off this record.
    expect(row.description).not.toMatch(/stripe/i);
  });
});
