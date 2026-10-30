import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { constructWebhookEvent, getStripeForOrg } from '../lib/stripe';
import { sendEstimateApprovedNotification } from '../lib/email';
import * as emailLib from '../lib/email';
import { captureStripeFees } from '../lib/reconcile-stripe-fees';
import { withCheckoutLedger } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockConstructWebhookEvent = constructWebhookEvent as ReturnType<typeof vi.fn>;
const mockCaptureStripeFees = captureStripeFees as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  estimate: {
    update: ReturnType<typeof vi.fn>;
  };
  lead: {
    updateMany: ReturnType<typeof vi.fn>;
  };
  organization: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoice: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  payment: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  refund: {
    findFirst: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  user: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    create: ReturnType<typeof vi.fn>;
  };
  stripeEvent: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────

// Org shape returned by resolveOrgFromEvent (§4.5 accepted_payment_methods gate).
// Tests default to CARD-accepting so the existing happy paths keep exercising
// the full handler; the new gate is exercised by dedicated no-CARD tests below.
const ORG_STRIPE = {
  id: 'org_stripe_1',
  stripe_account_id: 'acct_test',
  accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'],
};

// The kind=DEPOSIT Invoice is the SOLE deposit document. Paying it via Stripe (metadata.invoiceId)
// flows through the standard invoiceId branch, which — for kind=DEPOSIT — also approves the
// estimate + wins the lead. amount_due=500 (the deposit principal), charged at face value —
// the Stripe checkout total equals amount_due exactly.
const DEPOSIT_ESTIMATE = {
  id: 'f0000000-0000-0000-0000-000000000001',
  lead_id: 'e0000000-0000-0000-0000-000000000001',
  estimate_number: 'EST-2026-0001',
  total_amount: 1062.5,
  status: 'SENT',
  creator: { email: 'creator@example.com' },
  organization: { name: 'ACME Corp', logo_url: null, brand_color: null },
  lead: { customer: { first_name: 'Jane', last_name: 'Smith', company_name: null, email: 'jane@example.com' } },
};

const DEPOSIT_INVOICE_FIXTURE = {
  id: 'd1000000-0000-0000-0000-000000000001',
  invoice_number: 'I00009',
  status: 'SENT',
  kind: 'DEPOSIT',
  amount_due: 500,
  total_amount: 500,
  organization_id: ORG_STRIPE.id,
  organization: ORG_STRIPE, // resolveOrgFromEvent reads this off the same invoice.findUnique mock
  customer: null,
  job: null,
  estimate: DEPOSIT_ESTIMATE,
};

const INVOICE_FIXTURE = {
  id: '10000000-0000-0000-0000-000000000001',
  invoice_number: 'I00001',
  status: 'SENT',
  kind: 'STANDARD',
  amount_due: 1250.00,
  total_amount: 1250.00,
  organization_id: ORG_STRIPE.id,
  organization: ORG_STRIPE,
  customer: null,
  estimate: null,
  job: {
    customer: { email: 'john@example.com', first_name: 'John', last_name: 'Doe' },
  },
};

const INVOICE_SESSION = {
  id: 'cs_test_inv_123',
  object: 'checkout.session',
  payment_intent: 'pi_test_inv_abc',
  amount_total: 125000, // 1250 * 100 (face value)
  metadata: { invoiceId: INVOICE_FIXTURE.id },
};

// Deposit checkout drives metadata.invoiceId on the kind=DEPOSIT invoice.
// 500 principal * 100 = 50000
const VALID_SESSION = {
  id: 'cs_test_123',
  object: 'checkout.session',
  payment_intent: 'pi_test_abc',
  amount_total: 50000,
  metadata: { invoiceId: DEPOSIT_INVOICE_FIXTURE.id },
};

// #993: same as DEPOSIT_INVOICE_FIXTURE but with a real invoice.customer, so the generic
// "invoice paid" block's customer resolution (invoice.customer ?? invoice.job?.customer) is
// exercised too - the shared fixture's customer:null meant it never reproduced the bug.
const DEPOSIT_INVOICE_WITH_CUSTOMER = {
  ...DEPOSIT_INVOICE_FIXTURE,
  customer: { id: 'cust-dep-1', first_name: 'Jane', last_name: 'Smith', company_name: null, email: 'jane@example.com' },
};

/** The invoice the test serves from invoice.findUnique: the reconciler reads it before its transaction. */
async function servedInvoice(): Promise<Record<string, any>> {
  const results = mockPrisma.invoice.findUnique.mock.results;
  return results.length ? ((await results[results.length - 1].value) ?? {}) : {};
}

/**
 * Serve every transaction from one hand-built client carrying the reconciler's reads, and hand it
 * back so the test can assert on what was written inside it.
 */
function checkoutTransaction(over: Record<string, any> = {}): Record<string, any> {
  const tx: Record<string, any> = { ...over };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: any) => unknown) => fn(withCheckoutLedger(tx, await servedInvoice())));
  return tx;
}

/** The "payment not recorded" history rows a transaction wrote. */
function unrecordedRows(tx: Record<string, any>): Array<Record<string, any>> {
  return (tx.timelineEvent?.create.mock.calls ?? [])
    .map((c: any[]) => c[0].data)
    .filter((d: { event_type: string }) => d.event_type === 'PAYMENT_UNRECORDED');
}

function makeEvent(type: string, dataObject: object, id = 'evt_test_001') {
  return { id, type, data: { object: dataObject } };
}

// ─── Helper: POST to webhook ───────────────────────────

function postWebhook(body: object, sig = 'test_sig') {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', sig)
    .send(Buffer.from(JSON.stringify(body)));
}

// ─── Helper: P2002 (unique constraint) error ───────────
// Shape Prisma throws for a duplicate stripe_event_id row - simulates a sibling
// concurrent webhook delivery having already recorded the same event.
function p2002Error() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

// ─── Tests ────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no duplicate event
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});
});

describe('POST /api/webhooks/stripe', () => {
  it('should skip signature check in test env (missing header returns 200)', async () => {
    mockPrisma.stripeEvent.create.mockResolvedValue({});
    const event = makeEvent('payment_intent.created', {});
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    // In test env, missing stripe-signature is allowed
    expect(res.status).toBe(200);
  });

  it('should skip Stripe signature verification in test env', async () => {
    // constructWebhookEvent is never called in test env; body is parsed directly
    const event = makeEvent('payment_intent.created', {});
    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it('should return 200 with duplicate:true for already-processed events', async () => {
    mockPrisma.stripeEvent.findUnique.mockResolvedValue({ id: 'existing' });

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    // No state changes
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).not.toHaveBeenCalled();
  });

  it('returns 200 (not 500) when P2002 fires inside the transaction (concurrent duplicate race)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);

    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
        invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn() },
        estimate: { update: vi.fn() },
        lead: { updateMany: vi.fn() },
        timelineEvent: { create: vi.fn() },
        payment: { create: vi.fn() },
        stripeEvent: {
          create: vi.fn().mockRejectedValue(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
          ),
        },
      };
      return fn(withCheckoutLedger(tx, await servedInvoice()));
    });

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
  });

  it('should mark the kind=DEPOSIT invoice PAID + approve estimate on checkout.session.completed', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
        invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
      };
      capturedTx = tx;
      return fn(withCheckoutLedger(tx, await servedInvoice()));
    });

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Transaction was called
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();

    // Payment recorded on the deposit invoice + invoice PAID.
    expect(capturedTx.payment.create).toHaveBeenCalled();
    expect(capturedTx.invoice.update).toHaveBeenCalledWith(
      // Slice 09: the write is scoped by the event's org, not only the read that led to it.
      expect.objectContaining({ where: { id: DEPOSIT_INVOICE_FIXTURE.id, organization_id: ORG_STRIPE.id }, data: expect.objectContaining({ status: 'PAID' }) }),
    );
    // kind=DEPOSIT → the estimate is approved and the lead won.
    expect(capturedTx.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WON' }) }),
    );
    // Idempotency record created INSIDE the transaction.
    expect(capturedTx.stripeEvent.create).toHaveBeenCalledWith({
      data: { stripe_event_id: 'evt_test_001', event_type: 'checkout.session.completed' },
    });
    expect(mockPrisma.stripeEvent.create).not.toHaveBeenCalled();
  });

  describe('checkout.session.completed (CARD deposit) — customer email count (#993)', () => {
    // #993: the deposit block below and the generic "invoice paid" block further down in the
    // handler are not mutually exclusive — a CARD deposit used to fire both, sending the
    // customer 4 emails total. Assert on the count of sends addressed to the customer, not
    // just which function fired - the bug was "one too many".
    function countCustomerSends(email: string) {
      return Object.values(emailLib)
        .filter((fn: unknown): fn is ReturnType<typeof vi.fn> => typeof fn === 'function' && 'mock' in fn)
        .flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)
        .filter((call) => (call[0] as { to?: string } | undefined)?.to === email).length;
    }

    it('CARD deposit payment sends the customer exactly TWO emails (deposit confirmation + signed-PDF approval)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_WITH_CUSTOMER);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(countCustomerSends('jane@example.com')).toBe(2);
    });

    it('standard (non-deposit) CARD payment sends the customer exactly ONE email', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_std' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(countCustomerSends('john@example.com')).toBe(1);
    });
  });

  it('should verify amount and record the capture instead of booking it on mismatch', async () => {
    const badSession = { ...VALID_SESSION, amount_total: 99999 }; // wrong amount
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    const tx = checkoutTransaction();

    const res = await postWebhook(makeEvent('checkout.session.completed', badSession));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // No payment, no state change: the capture is written down instead (slice 08).
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['AMOUNT_MISMATCH']);
    // Idempotency record written inside the same transaction.
    expect(tx.stripeEvent.create).toHaveBeenCalledOnce();
    expect(mockPrisma.stripeEvent.create).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: records no payment when amount_total is absent (F-51)', async () => {
    const noAmountSession: Record<string, unknown> = { ...VALID_SESSION };
    delete noAmountSession.amount_total;
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    const tx = checkoutTransaction();

    const res = await postWebhook(makeEvent('checkout.session.completed', noAmountSession));

    // Acknowledge (200) so Stripe stops retrying, but move NO money.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('FAIL-CLOSED: records no payment when amount_total is non-numeric (F-51)', async () => {
    const badSession = { ...VALID_SESSION, amount_total: '51750' as unknown as number };
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    const tx = checkoutTransaction();

    const res = await postWebhook(makeEvent('checkout.session.completed', badSession));

    expect(res.status).toBe(200);
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('should handle missing invoiceId in metadata gracefully', async () => {
    const sessionNoInvoice = { ...VALID_SESSION, metadata: {} };

    const res = await postWebhook(makeEvent('checkout.session.completed', sessionNoInvoice));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('should handle unrecognized event types without error', async () => {
    const res = await postWebhook(makeEvent('payment_intent.created', {}));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('should not transition a LOST lead to WON on Stripe webhook', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    let capturedLeadWhere: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
        invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: {
          updateMany: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
            capturedLeadWhere = where;
            return Promise.resolve({ count: 0 });
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
      };
      return fn(withCheckoutLedger(tx, await servedInvoice()));
    });

    await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(capturedLeadWhere.status).toEqual({ notIn: ['WON', 'LOST'] });
  });

  // §4.5 — accepted_payment_methods gate (CARD not in the array → ignore)
  it('books checkout.session.completed even when the owning org no longer accepts CARD (slice 08: the gate is never consulted here)', async () => {
    const noCardInvoice = {
      ...DEPOSIT_INVOICE_FIXTURE,
      organization: {
        id: ORG_STRIPE.id,
        stripe_account_id: null,
        accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'],
      },
    };
    // resolveOrgFromEvent resolves the owning org via the invoice (metadata.invoiceId).
    mockPrisma.invoice.findUnique.mockResolvedValue(noCardInvoice);
    const tx = checkoutTransaction();

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(tx.payment.create).toHaveBeenCalledOnce();
  });

  it('should return 500 when stripeEvent.create throws', async () => {
    mockPrisma.stripeEvent.create.mockRejectedValue(new Error('DB error'));

    const res = await postWebhook(makeEvent('checkout.session.completed', { ...VALID_SESSION, metadata: {} }));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Webhook handler failed');
  });

  // ─── Plan B (2026-08-04): concurrent-duplicate P2002 tolerance ─────────
  it('a concurrent duplicate of a checkout on a non-payable invoice 200s as a duplicate and records nothing twice', async () => {
    const paidInvoice = { ...INVOICE_FIXTURE, status: 'PAID' };
    mockPrisma.invoice.findUnique.mockResolvedValue(paidInvoice);
    const tx = checkoutTransaction({ stripeEvent: { create: vi.fn().mockRejectedValue(p2002Error()) } });

    const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(unrecordedRows(tx)).toHaveLength(0);
  });

  it('concurrent redelivery end to end: first delivery commits the payment, second hits the event record and 200s as a duplicate - exactly one payment.create', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    const paymentCreate = vi.fn().mockResolvedValue({ id: 'pay_dep' });
    let recorded = false;
    // The second delivery's create hits the stripe_event_id row the first one wrote.
    const eventCreate = vi.fn().mockImplementation(async () => {
      if (recorded) throw p2002Error();
      recorded = true;
      return {};
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => unknown) =>
      fn(withCheckoutLedger({ payment: { create: paymentCreate }, stripeEvent: { create: eventCreate } }, await servedInvoice())));

    const firstRes = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));
    const secondRes = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body).toEqual({ received: true, duplicate: true });
    expect(paymentCreate).toHaveBeenCalledOnce();
  });

  // Slice 10: the accepted-methods gate is gone. An event the reconciler does not act on is
  // acknowledged for any org, whatever it accepts, and a concurrent duplicate still answers 200.
  it('an org that does not accept CARD: an event the reconciler does not act on is acknowledged, not gated', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({
      invoice: { organization: { id: 'org_no_card_1', stripe_account_id: null, accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'] } },
    });
    mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

    const res = await postWebhook(makeEvent('charge.refunded', { id: 'ch_1', payment_intent: 'pi_no_card' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Invoice payment webhook tests ─────────────────────

  describe('invoice payment path', () => {
    it('should process invoice payment and set status to PAID', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);

      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_001' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      // Invoice was fetched: before the lock only its org (slice 09), the figures under the lock.
      expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith({
        where: { id: INVOICE_FIXTURE.id },
        select: { id: true, organization_id: true },
      });

      // Transaction was called
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();

      // Payment created with CARD method and null collected_by
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invoice_id: INVOICE_FIXTURE.id,
          amount: 1250.00,
          method: 'CARD',
          collected_by: null,
          stripe_payment_intent_id: 'pi_test_inv_abc',
        }),
      });

      // Invoice updated to PAID
      expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
        // Slice 09: the write is scoped by the event's org, not only the read that led to it.
        where: { id: INVOICE_FIXTURE.id, organization_id: ORG_STRIPE.id },
        data: expect.objectContaining({
          amount_due: 0,
          status: 'PAID',
        }),
      }));

      // Two timeline events: PAYMENT_RECEIVED + INVOICE_PAID
      expect(capturedTx.timelineEvent.create).toHaveBeenCalledTimes(2);
      expect(capturedTx.timelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_FIXTURE.id,
          event_type: 'PAYMENT_RECEIVED',
        }),
      });
      expect(capturedTx.timelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_FIXTURE.id,
          event_type: 'INVOICE_PAID',
        }),
      });

      // Stripe event recorded inside transaction
      expect(capturedTx.stripeEvent.create).toHaveBeenCalledWith({
        data: { stripe_event_id: 'evt_test_001', event_type: 'checkout.session.completed' },
      });
      // Not recorded outside transaction
      expect(mockPrisma.stripeEvent.create).not.toHaveBeenCalled();
    });

    // ─── Task 1.6 / Step 3b: snapshot the charge's Stripe account onto the Payment ───
    // NULL = legacy platform-account payment; a set value = direct charge (Connect).
    // Step 4's refund keying and Phase 3's reconciliation both read this snapshot.
    it('stamps stripe_account_id from event.account onto the Payment (direct-charge / Connect)', async () => {
      const directOrg = { id: 'org_direct_1', stripe_account_id: 'acct_direct_1', accepted_payment_methods: ['CARD', 'CHECK'] };
      // event.account is set → resolveOrgFromEvent's Connect path resolves the org via stripe_account_id.
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });

      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockImplementation((a: any) => { capturedTx = a; return Promise.resolve({ id: 'pay_direct_1' }); }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const event = { id: 'evt_direct_charge_1', type: 'checkout.session.completed', account: 'acct_direct_1', data: { object: INVOICE_SESSION } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(capturedTx.data.stripe_account_id).toBe('acct_direct_1');

      // ─── Task 3.3: post-commit fee capture, direct charge only ───────────────
      // createdPaymentId is hoisted out of the $transaction (closure-captured, not
      // returned — see reconcile-stripe-fees.ts) so it's available here, after commit.
      expect(mockCaptureStripeFees).toHaveBeenCalledWith('pay_direct_1', 'pi_test_inv_abc', 'acct_direct_1');
    });

    it('records a NULL stripe_account_id for a legacy platform-account payment (no event.account)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);

      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockImplementation((a: any) => { capturedTx = a; return Promise.resolve({ id: 'pay_legacy_1' }); }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(capturedTx.data.stripe_account_id).toBeNull();
      // Task 3.3: no event.account (legacy platform-account charge) → never capture fees
      // (a legacy charge carries no application fee to reconcile).
      expect(mockCaptureStripeFees).not.toHaveBeenCalled();
    });

    it('does not call captureStripeFees when the checkout session carries no payment_intent (defensive guard)', async () => {
      const directOrg = { id: 'org_direct_2', stripe_account_id: 'acct_direct_2', accepted_payment_methods: ['CARD', 'CHECK'] };
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });

      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_direct_2' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const sessionNoPI = { ...INVOICE_SESSION, payment_intent: undefined };
      const event = { id: 'evt_direct_charge_no_pi', type: 'checkout.session.completed', account: 'acct_direct_2', data: { object: sessionNoPI } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(mockCaptureStripeFees).not.toHaveBeenCalled();
    });

    it('records a non-payable invoice\'s capture instead of booking it', async () => {
      const paidInvoice = { ...INVOICE_FIXTURE, status: 'PAID' };
      mockPrisma.invoice.findUnique.mockResolvedValue(paidInvoice);
      const tx = checkoutTransaction();

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['INVOICE_NOT_PAYABLE']);
      // Event recorded inside the same transaction.
      expect(tx.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('should handle invoice not found', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(null);

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('should process PARTIAL invoice status', async () => {
      const partialInvoice = { ...INVOICE_FIXTURE, status: 'PARTIAL', amount_due: 500.00 };
      mockPrisma.invoice.findUnique.mockResolvedValue(partialInvoice);

      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_002' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      // amount_total = amount_due × 100 (face value). 500 → 50000
      const partialSession = { ...INVOICE_SESSION, amount_total: 50000 };
      const res = await postWebhook(makeEvent('checkout.session.completed', partialSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      // Payment amount should be the amount_due (500), not total_amount
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: 500.00,
          method: 'CARD',
        }),
      });
    });

    it('no-ops when the checkout session carries no invoiceId metadata (a session ServWave did not build)', async () => {
      const tx = checkoutTransaction();
      const res = await postWebhook(makeEvent('checkout.session.completed', { ...VALID_SESSION, metadata: {} }));

      expect(res.status).toBe(200);
      expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
      expect(tx.payment?.create).not.toHaveBeenCalled();
      expect(unrecordedRows(tx)).toEqual([]);
    });
  });

  // ─── Payments go-live slice 02 (D9) — checkout carries no service fee, so the webhook expects
  // amount_due + tip and nothing more. Slice 08 retired the legacy branch that still booked a
  // session opened under the old 3.5% card fee: no such session can still be open (they live 24
  // hours), and one that claims a fee now meets the ordinary amount check like any other figure. ───
  describe('checkout.session.completed — no card service fee (payments go-live D9)', () => {
    it('a session that charged the retired 3.5% fee is no longer booked: the capture is recorded as an amount mismatch', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      const tx = checkoutTransaction();

      // amount_due = $1,250.00; the retired fee was 3.5% = $43.75; charged 125000 + 4375.
      const legacyFeeSession = {
        ...INVOICE_SESSION,
        amount_total: 129375,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '4375' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', legacyFeeSession));

      expect(res.status).toBe(200);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(unrecordedRows(tx)).toEqual([
        expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_FIXTURE.id,
          metadata: expect.objectContaining({ reason: 'AMOUNT_MISMATCH', expected_cents: 125000, charged_cents: 129375 }),
        }),
      ]);
    });

    it('does not book a session that charged more than amount due + tip with no fee claimed, and records the unapplied capture', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      const tx = checkoutTransaction();

      const overchargedSession = {
        ...INVOICE_SESSION,
        amount_total: 129375,
        metadata: { invoiceId: INVOICE_FIXTURE.id },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', overchargedSession));

      expect(res.status).toBe(200);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(tx.stripeEvent.create).toHaveBeenCalledOnce();
      expect(unrecordedRows(tx)).toEqual([
        expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_FIXTURE.id,
          event_type: 'PAYMENT_UNRECORDED',
          metadata: expect.objectContaining({ reason: 'AMOUNT_MISMATCH', expected_cents: 125000, charged_cents: 129375 }),
        }),
      ]);
    });

    it('books a session whose stale fee claim was never charged: the customer paid exactly what is owed, with no fee', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      const tx = checkoutTransaction();

      const shortSession = {
        ...INVOICE_SESSION,
        amount_total: 125000,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '4375' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', shortSession));

      expect(res.status).toBe(200);
      const { data } = tx.payment.create.mock.calls[0][0];
      expect(data.amount).toBe(1250.00);
      expect(data.service_fee_amount ?? null).toBeNull();
      expect(unrecordedRows(tx)).toEqual([]);
    });

    it('books the face amount with no service fee on the payment', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_no_fee' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      const { data } = capturedTx.payment.create.mock.calls[0][0];
      expect(data.amount).toBe(1250.00);
      expect(data.service_fee_amount ?? null).toBeNull();
    });
  });

  // ─── Slice 7 (customer-facing tipping, D10) — extends the D8 amount check by one more
  // variable. There is no formula to recompute a customer-chosen tip from, unlike the service
  // fee, so the webhook trusts session metadata as the record of what checkout validated and
  // cross-checks it against amount_total, same as every other figure here.
  describe('checkout.session.completed — tip (Slice 7)', () => {
    it('accepts amount_total that includes a tip and persists Payment.tip_amount', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_tip_1' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      // amount_due = 1250.00 → amount_total = 125000 (face) + 15000 (tip) = 140000. No fee.
      const tipSession = {
        ...INVOICE_SESSION,
        amount_total: 140000,
        metadata: { invoiceId: INVOICE_FIXTURE.id, tipCents: '15000' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', tipSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: 1250.00, // face value only — the tip never touches Payment.amount (D10)
          tip_amount: 150,
        }),
      });
    });

    it('fails closed when amount_total omits the tip metadata claims', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      const tx = checkoutTransaction();

      const shortSession = {
        ...INVOICE_SESSION,
        amount_total: 125000, // no tip actually added
        metadata: { invoiceId: INVOICE_FIXTURE.id, tipCents: '15000' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', shortSession));

      expect(res.status).toBe(200);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['AMOUNT_MISMATCH']);
    });

    it('writes a null tip_amount when the session carries no tipCents metadata (no tip given)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_no_tip' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 1250.00, tip_amount: null }),
      });
    });
  });

  // ─── Deferred-bank first-payment nudge (Task 1.9 / §6.6, §6.8) ────────────────
  // billing.payouts_pending_first_payment: one-shot FEED nudge fired the first time
  // a direct-charge org collects a CARD payment while stripe_payouts_enabled is
  // still false. Gate: event.account set (Connect direct charge) AND
  // !stripe_payouts_enabled AND this is the org's first non-voided CARD Payment.
  describe('deferred-bank first-payment nudge (Task 1.9)', () => {
    function setupPaymentTransaction() {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_nudge' }) },
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });
    }

    it("emits billing.payouts_pending_first_payment on the org's first CARD payment (direct charge, payouts not yet enabled)", async () => {
      const directOrg = {
        id: 'org_direct_nudge', stripe_account_id: 'acct_direct_nudge', accepted_payment_methods: ['CARD'],
        stripe_payouts_enabled: false, name: 'Acme Plumbing',
      };
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });
      setupPaymentTransaction();
      (prisma.payment.count as any).mockResolvedValue(1); // the one we just wrote
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'notif_nudge' });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin_nudge', role: 'ADMIN', email: 'admin@acme.test' }]);

      const event = { id: 'evt_nudge_1', type: 'checkout.session.completed', account: 'acct_direct_nudge', data: { object: INVOICE_SESSION } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: { invoice: { organization_id: directOrg.id }, method: 'CARD', voided_at: null, stripe_account_id: 'acct_direct_nudge' },
      });
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: directOrg.id,
          verb: 'billing.payouts_pending_first_payment',
          category: 'BILLING',
          object_type: 'ORGANIZATION',
          priority: 'FEED',
          needs_action: false,
          dedup_key: `billing.payouts_pending_first_payment:${directOrg.id}`,
          title: "You've collected a payment. Add your bank account to get paid out.",
        }),
      }));
    });

    it('does not nudge when payouts are already enabled', async () => {
      const directOrg = {
        id: 'org_direct_nudge2', stripe_account_id: 'acct_direct_nudge2', accepted_payment_methods: ['CARD'],
        stripe_payouts_enabled: true, name: 'Acme Plumbing',
      };
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });
      setupPaymentTransaction();

      const event = { id: 'evt_nudge_2', type: 'checkout.session.completed', account: 'acct_direct_nudge2', data: { object: INVOICE_SESSION } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(prisma.payment.count).not.toHaveBeenCalled();
      // Scoped to the nudge verb: this door now also emits billing.payment_received
      // for every card payment, so a blanket "no notification at all" assertion would
      // fail on an unrelated, correct notification.
      expect(prisma.notification.create).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verb: 'billing.payouts_pending_first_payment' }),
      }));
    });

    it("does not nudge when this is not the org's first CARD payment", async () => {
      const directOrg = {
        id: 'org_direct_nudge3', stripe_account_id: 'acct_direct_nudge3', accepted_payment_methods: ['CARD'],
        stripe_payouts_enabled: false, name: 'Acme Plumbing',
      };
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });
      setupPaymentTransaction();
      (prisma.payment.count as any).mockResolvedValue(2); // a later payment, not the first

      const event = { id: 'evt_nudge_3', type: 'checkout.session.completed', account: 'acct_direct_nudge3', data: { object: INVOICE_SESSION } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      // Scoped to the nudge verb: this door now also emits billing.payment_received
      // for every card payment, so a blanket "no notification at all" assertion would
      // fail on an unrelated, correct notification.
      expect(prisma.notification.create).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verb: 'billing.payouts_pending_first_payment' }),
      }));
    });

    // ── Regression: the count MUST be scoped to this connected account's own
    // Direct-Charge payments, not every CARD payment the org has ever recorded.
    // Every real org already runs its existing business through the legacy
    // platform account (stripe_account_id: null) — an unscoped count would see
    // that history too and never equal 1, so the nudge would silently never
    // fire for any real org. The mock below actually inspects the `where`
    // clause (unlike the canned mockResolvedValue used elsewhere in this
    // block) so this test fails if the discriminating filter is ever dropped.
    it('counts only this account\'s own direct-charge CARD payments — a legacy platform-account payment on the same org does not block the nudge', async () => {
      const directOrg = {
        id: 'org_direct_nudge5', stripe_account_id: 'acct_direct_nudge5', accepted_payment_methods: ['CARD'],
        stripe_payouts_enabled: false, name: 'Acme Plumbing',
      };
      mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
      mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE, organization_id: directOrg.id });
      setupPaymentTransaction();
      // Simulates a real DB holding 2 rows for this org: 1 legacy platform-account CARD
      // payment (stripe_account_id: null, pre-dating Connect) + this org's first-ever
      // direct-charge payment (the one just written, stripe_account_id: acct_direct_nudge5).
      // A query that fails to scope by stripe_account_id would see count=2 here.
      (prisma.payment.count as any).mockImplementation((args: any) =>
        Promise.resolve(args?.where?.stripe_account_id === 'acct_direct_nudge5' ? 1 : 2));
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'notif_nudge5' });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin_nudge5', role: 'ADMIN', email: 'admin5@acme.test' }]);

      const event = { id: 'evt_nudge_5', type: 'checkout.session.completed', account: 'acct_direct_nudge5', data: { object: INVOICE_SESSION } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: { invoice: { organization_id: directOrg.id }, method: 'CARD', voided_at: null, stripe_account_id: 'acct_direct_nudge5' },
      });
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verb: 'billing.payouts_pending_first_payment' }),
      }));
    });

    it('does not nudge a legacy platform-account payment (no event.account) regardless of payouts state', async () => {
      // ORG_STRIPE (the default invoice-path org) has no stripe_payouts_enabled field set
      // (falsy) — proving the event.account gate, not the payouts flag, is what blocks this.
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      setupPaymentTransaction();

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(prisma.payment.count).not.toHaveBeenCalled();
      // Scoped to the nudge verb: this door now also emits billing.payment_received
      // for every card payment, so a blanket "no notification at all" assertion would
      // fail on an unrelated, correct notification.
      expect(prisma.notification.create).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ verb: 'billing.payouts_pending_first_payment' }),
      }));
    });
  });

  // ─── Approval notification after a kind=DEPOSIT invoice is paid via Stripe ────────
  describe('sendEstimateApprovedNotification after deposit payment', () => {
    function setupDepositTransaction() {
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });
    }

    it('sends sendEstimateApprovedNotification with org data when the deposit invoice is paid', async () => {
      const mockSendApproved = vi.mocked(sendEstimateApprovedNotification);
      mockSendApproved.mockClear();

      // The deposit invoice carries the estimate (+org+customer); the notification is fired
      // directly from the invoiceId branch (no second lookup).
      mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
      setupDepositTransaction();

      const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));
      expect(res.status).toBe(200);

      // Allow the fire-and-forget promise to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendApproved).toHaveBeenCalledOnce();
      expect(mockSendApproved).toHaveBeenCalledWith(
        expect.objectContaining({ estimateNumber: DEPOSIT_ESTIMATE.estimate_number }),
      );
    });

    it('does NOT send sendEstimateApprovedNotification for a STANDARD (non-deposit) invoice', async () => {
      const mockSendApproved = vi.mocked(sendEstimateApprovedNotification);
      mockSendApproved.mockClear();

      // A STANDARD invoice payment never approves an estimate.
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
          invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_std' }) },
        };
        return fn(withCheckoutLedger(tx, await servedInvoice()));
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));
      expect(res.status).toBe(200);

      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendApproved).not.toHaveBeenCalled();
    });
  });
});

// ─── A kind=DEPOSIT invoice paid via Stripe records the Payment + approves the estimate ───
describe('deposit checkout.session.completed → records Payment on the kind=DEPOSIT invoice', () => {
  function setupDepositTx() {
    const captured: any = {};
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
        // The first update is the booking; the stored totals re-derived after it are a second one (slice 09).
        invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate ??= a; return {}; }) },
        payment: { create: vi.fn().mockImplementation((a: any) => { captured.paymentCreate = a; return Promise.resolve({ id: 'pay_dep_1' }); }) },
      };
      captured.tx = tx;
      return fn(withCheckoutLedger(tx, await servedInvoice()));
    });
    return captured;
  }

  it('records a CARD Payment on the kind=DEPOSIT invoice and marks it PAID (drawdown-eligible)', async () => {
    const captured = setupDepositTx();

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    // A CARD Payment is recorded at the deposit principal (500), with the PI, collected_by null.
    expect(captured.paymentCreate.data).toEqual(expect.objectContaining({
      invoice_id: DEPOSIT_INVOICE_FIXTURE.id,
      amount: 500,
      method: 'CARD',
      collected_by: null,
      stripe_payment_intent_id: VALID_SESSION.payment_intent,
    }));
    // Deposit invoice marked PAID, amount_due 0.
    expect(captured.invoiceUpdate.where).toEqual({ id: DEPOSIT_INVOICE_FIXTURE.id, organization_id: ORG_STRIPE.id });
    expect(captured.invoiceUpdate.data).toEqual(expect.objectContaining({ status: 'PAID', amount_due: 0 }));
  });

  it('records the deposit PRINCIPAL (500), matching the face-value Stripe total exactly', async () => {
    const captured = setupDepositTx();

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    // Stripe total is the $500 face value; the Payment is the $500 principal.
    expect(captured.paymentCreate.data.amount).toBe(500);
  });

  it('approves the estimate and wins the lead when the deposit invoice is paid', async () => {
    const captured = setupDepositTx();

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(captured.tx.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WON' }) }),
    );
    expect(captured.tx.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WON' } }),
    );
  });

  it('records the capture, not a second payment, when the deposit invoice was already PAID another way', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...DEPOSIT_INVOICE_FIXTURE, status: 'PAID' });
    const tx = checkoutTransaction();

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.estimate.update).not.toHaveBeenCalled();
    expect(unrecordedRows(tx).map((d) => d.metadata.reason)).toEqual(['INVOICE_NOT_PAYABLE']);
  });

  it('records the payment when amount_total equals face value', async () => {
    const captured = setupDepositTx();
    const session = { ...VALID_SESSION, amount_total: 50000 }; // 500 * 100
    const res = await postWebhook(makeEvent('checkout.session.completed', session));
    expect(res.status).toBe(200);
    expect(captured.paymentCreate.data.amount).toBe(500);
  });

  it('rejects (records event, writes no Payment) when amount_total exceeds face value', async () => {
    const captured = setupDepositTx();
    const session = { ...VALID_SESSION, amount_total: 51750 }; // mismatched total — checkout bills face value only
    const res = await postWebhook(makeEvent('checkout.session.completed', session));
    expect(res.status).toBe(200);
    expect(captured.paymentCreate).toBeUndefined();
    expect(captured.tx.stripeEvent.create).toHaveBeenCalledOnce();
    expect(unrecordedRows(captured.tx).map((d) => d.metadata.reason)).toEqual(['AMOUNT_MISMATCH']);
  });
});

describe('charge.refunded webhook', () => {
  const PAYMENT_FIXTURE = {
    id: 'pay_1',
    invoice_id: 'inv_1',
    amount: 1000,
    stripe_payment_intent_id: 'pi_test_refund_1',
    invoice: {
      id: 'inv_1',
      organization_id: 'org_1',
      total_amount: 1000,
      organization: { id: 'org_1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'] },
    },
  };
  // Slice 07: at the pinned API version (2025-02-24.acacia) a charge carries NO embedded refunds
  // list, and amount_refunded is the charge's RUNNING total. Refunds are recorded from the
  // refund.* events (services/payment-reconciler); this event records nothing.
  function makeChargeRefundedEvent(paymentIntentId: string, refundedCents: number, opts?: { account?: string; eventId?: string }) {
    return {
      id: opts?.eventId ?? 'evt_charge_refunded_1',
      type: 'charge.refunded',
      ...(opts?.account ? { account: opts.account } : {}),
      data: {
        object: { id: 'ch_1', object: 'charge', amount: 100000, payment_intent: paymentIntentId, amount_refunded: refundedCents },
      },
    };
  }

  it('writes no Refund row and touches no invoice: the refund events record refunds (slice 07)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 50000));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    // Nor does it move any platform fee: a refund's own processor call does that.
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
  });


  it('logs warning and records event when no payment matches (no legacy deposit fallback)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);

    const res = await postWebhook(makeChargeRefundedEvent('pi_truly_unknown', 100000));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('is idempotent (replay returns duplicate:true)', async () => {
    mockPrisma.stripeEvent.findUnique.mockResolvedValue({ id: 'evt_charge_refunded_1' });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ─── Plan B (2026-08-04): concurrent-duplicate P2002 tolerance on the bare
  // stripeEvent.create call sites. Each test below mirrors an existing scenario
  // above but makes the bare create reject with P2002 (the shape produced when
  // a sibling concurrent delivery already recorded this event), asserting the
  // site still returns its normal 200 body instead of 500. ───
  describe('P2002 tolerance on bare stripeEvent.create sites (concurrent duplicate delivery)', () => {
    it('unknown owning org tolerates P2002 and still returns 200', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

      const res = await postWebhook(makeChargeRefundedEvent('pi_truly_unknown', 100000));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('a charge.refunded for a known payment tolerates P2002 and still returns 200', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
      mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

// Phase 2c charge.dispute.* webhooks moved into the payment event reconciler (payments go-live
// slice 09); they are proven against a real database in disputes-reconciler-db.test.ts.

// account.updated / account.application.deauthorized moved into the payment event reconciler
// (payments go-live slice 10); they are proven against a real database in
// account-events-reconciler-db.test.ts.
