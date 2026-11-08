import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { constructWebhookEvent, retrieveAccount, getStripeForOrg } from '../lib/stripe';
import { sendEstimateApprovedNotification, sendPaymentsActionNeededEmail } from '../lib/email';
import * as emailLib from '../lib/email';
import { captureStripeFees } from '../lib/reconcile-stripe-fees';

// ─── Typed mocks ──────────────────────────────────────

const mockConstructWebhookEvent = constructWebhookEvent as ReturnType<typeof vi.fn>;
const mockRetrieveAccount = retrieveAccount as ReturnType<typeof vi.fn>;
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
        invoice: { update: vi.fn() },
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
      await fn(tx);
      return tx;
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
        invoice: { update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
      };
      capturedTx = tx;
      await fn(tx);
      return tx;
    });

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Transaction was called
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();

    // Payment recorded on the deposit invoice + invoice PAID.
    expect(capturedTx.payment.create).toHaveBeenCalled();
    expect(capturedTx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DEPOSIT_INVOICE_FIXTURE.id }, data: expect.objectContaining({ status: 'PAID' }) }),
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
        };
        await fn(tx);
        return tx;
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(countCustomerSends('john@example.com')).toBe(1);
    });
  });

  it('should verify amount and skip state changes on mismatch', async () => {
    const badSession = { ...VALID_SESSION, amount_total: 99999 }; // wrong amount
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);

    const res = await postWebhook(makeEvent('checkout.session.completed', badSession));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // No transaction — amount mismatch causes break before $transaction
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // Idempotency record still created at the end of the handler.
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('FAIL-CLOSED: records no payment when amount_total is absent (F-51)', async () => {
    const noAmountSession: Record<string, unknown> = { ...VALID_SESSION };
    delete noAmountSession.amount_total;
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);

    const res = await postWebhook(makeEvent('checkout.session.completed', noAmountSession));

    // Acknowledge (200) so Stripe stops retrying, but move NO money.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('FAIL-CLOSED: records no payment when amount_total is non-numeric (F-51)', async () => {
    const badSession = { ...VALID_SESSION, amount_total: '51750' as unknown as number };
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);

    const res = await postWebhook(makeEvent('checkout.session.completed', badSession));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
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
        invoice: { update: vi.fn().mockResolvedValue({}) },
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
      await fn(tx);
      return tx;
    });

    await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(capturedLeadWhere.status).toEqual({ notIn: ['WON', 'LOST', 'CANCELLED'] });
  });

  // §4.5 — accepted_payment_methods gate (CARD not in the array → ignore)
  it('short-circuits checkout.session.completed when owning org does not accept CARD', async () => {
    const noCardInvoice = {
      ...DEPOSIT_INVOICE_FIXTURE,
      organization: {
        id: 'org_no_card_1',
        stripe_account_id: null,
        accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'],
      },
    };
    // resolveOrgFromEvent resolves the owning org via the invoice (metadata.invoiceId).
    mockPrisma.invoice.findUnique.mockResolvedValue(noCardInvoice);

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, ignored: 'org_does_not_accept_card' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('should return 500 when stripeEvent.create throws', async () => {
    mockPrisma.stripeEvent.create.mockRejectedValue(new Error('DB error'));

    const res = await postWebhook(makeEvent('checkout.session.completed', { ...VALID_SESSION, metadata: {} }));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Webhook handler failed');
  });

  // ─── Plan B (2026-08-04): concurrent-duplicate P2002 tolerance ─────────
  it('non-payable invoice status early-breaks to the bottom fallback record path - tolerates P2002 and still returns 200', async () => {
    const paidInvoice = { ...INVOICE_FIXTURE, status: 'PAID' };
    mockPrisma.invoice.findUnique.mockResolvedValue(paidInvoice);
    mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

    const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('concurrent redelivery end to end: first delivery commits the payment, second finds the invoice already PAID and 200s off the tolerated P2002 - exactly one payment.create', async () => {
    // resolveOrgFromEvent and the checkout.session.completed handler each call
    // prisma.invoice.findUnique once per delivery, so this is keyed on which
    // delivery is in flight (flipped below, between the two postWebhook calls),
    // not on a raw call count.
    let currentInvoice: typeof DEPOSIT_INVOICE_FIXTURE = DEPOSIT_INVOICE_FIXTURE;
    mockPrisma.invoice.findUnique.mockImplementation(async () => currentInvoice);
    const paymentCreate = vi.fn().mockResolvedValue({ id: 'pay_dep' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        invoice: { update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: paymentCreate },
      };
      await fn(tx);
      return tx;
    });
    // The second delivery's fallback bare create hits the same stripe_event_id row
    // the first delivery's tx.stripeEvent.create already wrote.
    mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

    const firstRes = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));
    // Sibling delivery has now committed - the invoice is PAID by the time the
    // second (racing) delivery does its own lookup.
    currentInvoice = { ...DEPOSIT_INVOICE_FIXTURE, status: 'PAID' };
    const secondRes = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(paymentCreate).toHaveBeenCalledOnce();
  });

  it('org does not accept CARD tolerates P2002 and still returns 200 with its own ignored body', async () => {
    const noCardInvoice = {
      ...DEPOSIT_INVOICE_FIXTURE,
      organization: {
        id: 'org_no_card_1',
        stripe_account_id: null,
        accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'],
      },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(noCardInvoice);
    mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, ignored: 'org_does_not_accept_card' });
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      // Invoice was fetched
      expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith({
        where: { id: INVOICE_FIXTURE.id },
        select: expect.objectContaining({
          id: true,
          invoice_number: true,
          status: true,
          amount_due: true,
          total_amount: true,
        }),
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
      expect(capturedTx.invoice.update).toHaveBeenCalledWith({
        where: { id: INVOICE_FIXTURE.id },
        data: expect.objectContaining({
          amount_due: 0,
          status: 'PAID',
        }),
      });

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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
      });

      const sessionNoPI = { ...INVOICE_SESSION, payment_intent: undefined };
      const event = { id: 'evt_direct_charge_no_pi', type: 'checkout.session.completed', account: 'acct_direct_2', data: { object: sessionNoPI } };
      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(mockCaptureStripeFees).not.toHaveBeenCalled();
    });

    it('should skip non-payable invoice statuses', async () => {
      const paidInvoice = { ...INVOICE_FIXTURE, status: 'PAID' };
      mockPrisma.invoice.findUnique.mockResolvedValue(paidInvoice);

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      // Event still recorded via fallback path
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
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

    it('no-ops when the checkout session carries no invoiceId metadata', async () => {
      const res = await postWebhook(makeEvent('checkout.session.completed', { ...VALID_SESSION, metadata: {} }));

      expect(res.status).toBe(200);
      expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ─── Slice 3 (card service fee) — md_files/plans/payments/2026-08-03-card-service-fee-workiz-parity.md ───
  // D8: the fee is server-recomputed from amount_due + CARD_SERVICE_FEE_BPS and cross-checked
  // against session metadata; it is never taken from either alone.
  describe('checkout.session.completed — card service fee (Slice 3 / D8)', () => {
    it('accepts amount_total that includes a correctly-recomputed service fee and persists Payment.service_fee_amount', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_fee_1' }) },
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      // amount_due = 1250.00 → 3.5% = 4375 cents ($43.75). amount_total = 125000 + 4375.
      const feeSession = {
        ...INVOICE_SESSION,
        amount_total: 129375,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '4375' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', feeSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: 1250.00, // face value only — the fee never touches Payment.amount (D1)
          service_fee_amount: 43.75,
        }),
      });
      expect(capturedTx.invoice.update).toHaveBeenCalledWith({
        where: { id: INVOICE_FIXTURE.id },
        data: expect.objectContaining({ amount_due: 0, status: 'PAID' }),
      });
    });

    it('fails closed when metadata.serviceFeeCents does not match the independent recompute', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);

      // Claimed fee (5000) does not match 3.5% of amount_due (4375) — reject regardless of what
      // amount_total says, so a stale/buggy metadata value can never settle an invoice.
      const tamperedSession = {
        ...INVOICE_SESSION,
        amount_total: 130000,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '5000' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', tamperedSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('fails closed when amount_total omits the service fee metadata claims', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);

      // Metadata correctly claims the recomputed fee, but the actual Stripe total never carried it.
      const shortSession = {
        ...INVOICE_SESSION,
        amount_total: 125000,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '4375' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', shortSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    // D6 regression guard — a manually-recorded (non-Stripe) payment must never carry a service
    // fee. This webhook path is the ONLY writer of service_fee_amount; a payment with no
    // serviceFeeCents metadata (disabled org, or pre-feature session) writes null, matching the
    // manual recordPayment door exactly.
    it('writes a null service_fee_amount when the session carries no serviceFeeCents metadata (disabled org / today\'s behavior)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_no_fee' }) },
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeEvent('checkout.session.completed', INVOICE_SESSION));

      expect(res.status).toBe(200);
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 1250.00, service_fee_amount: null }),
      });
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
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

    it('combines a service fee AND a tip in the same expected-amount check', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_tip_2' }) },
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      // amount_due=1250.00 → fee 4375c ($43.75), tip 15000c ($150). Total = 125000+4375+15000.
      const session = {
        ...INVOICE_SESSION,
        amount_total: 144375,
        metadata: { invoiceId: INVOICE_FIXTURE.id, serviceFeeCents: '4375', tipCents: '15000' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', session));

      expect(res.status).toBe(200);
      expect(capturedTx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 1250.00, service_fee_amount: 43.75, tip_amount: 150 }),
      });
    });

    it('fails closed when amount_total omits the tip metadata claims', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);

      const shortSession = {
        ...INVOICE_SESSION,
        amount_total: 125000, // no tip actually added
        metadata: { invoiceId: INVOICE_FIXTURE.id, tipCents: '15000' },
      };
      const res = await postWebhook(makeEvent('checkout.session.completed', shortSession));

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('writes a null tip_amount when the session carries no tipCents metadata (no tip given)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_FIXTURE);
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_no_tip' }) },
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
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
          title: "You've collected $1,250.00. Connect your bank to get paid out.",
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_dep' }) },
        };
        await fn(tx);
        return tx;
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
          invoice: { update: vi.fn().mockResolvedValue({}) },
          estimate: { update: vi.fn().mockResolvedValue({}) },
          lead: { updateMany: vi.fn().mockResolvedValue({}) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          stripeEvent: { create: vi.fn().mockResolvedValue({}) },
          payment: { create: vi.fn().mockResolvedValue({ id: 'pay_std' }) },
        };
        await fn(tx);
        return tx;
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
        invoice: { update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate = a; return {}; }) },
        payment: { create: vi.fn().mockImplementation((a: any) => { captured.paymentCreate = a; return Promise.resolve({ id: 'pay_dep_1' }); }) },
      };
      captured.tx = tx;
      await fn(tx);
      return tx;
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
    expect(captured.invoiceUpdate.where).toEqual({ id: DEPOSIT_INVOICE_FIXTURE.id });
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

  it('is a no-op when the deposit invoice is already PAID (not SENT/PARTIAL)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...DEPOSIT_INVOICE_FIXTURE, status: 'PAID' });

    const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

    expect(res.status).toBe(200);
    // Not payable → the handler breaks before the transaction.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('records the payment when amount_total equals face value', async () => {
    const captured = setupDepositTx();
    const session = { ...VALID_SESSION, amount_total: 50000 }; // 500 * 100
    const res = await postWebhook(makeEvent('checkout.session.completed', session));
    expect(res.status).toBe(200);
    expect(captured.paymentCreate.data.amount).toBe(500);
  });

  it('rejects (records event, writes no Payment) when amount_total exceeds face value', async () => {
    setupDepositTx();
    const session = { ...VALID_SESSION, amount_total: 51750 }; // mismatched total — checkout bills face value only
    const res = await postWebhook(makeEvent('checkout.session.completed', session));
    expect(res.status).toBe(200);
    // Amount mismatch → the handler breaks before $transaction is ever entered, so
    // tx.payment.create (only constructed inside that callback) is never reached.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

  function makeChargeRefundedEvent(
    paymentIntentId: string,
    refundedCents: number,
    refundMetadata?: Record<string, string>,
    // Task 3.2 (door 2) — direct-charge fixtures: event.account + the charge's own id/amount
    // (event.data.object IS the Charge for charge.refunded). Omitted ⇒ identical shape to before.
    // eventId/refundId let a single test drive two sequential refund events (each a distinct
    // real Stripe event/refund id) without colliding with the default fixtures used elsewhere.
    opts?: { account?: string; chargeId?: string; chargeAmount?: number; eventId?: string; refundId?: string },
  ) {
    return {
      id: opts?.eventId ?? 'evt_charge_refunded_1',
      type: 'charge.refunded',
      ...(opts?.account ? { account: opts.account } : {}),
      data: {
        object: {
          ...(opts?.chargeId ? { id: opts.chargeId } : {}),
          ...(opts?.chargeAmount !== undefined ? { amount: opts.chargeAmount } : {}),
          payment_intent: paymentIntentId,
          amount_refunded: refundedCents,
          refunds: { data: [{ id: opts?.refundId ?? 're_1', metadata: refundMetadata ?? {} }] },
        },
      },
    };
  }

  it('skips state changes when refund metadata.source === "in_app" (records event only)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000, { source: 'in_app' }));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    // Task 3.2 (door 2 guard): an in-app refund already reversed the fee via refund_application_fee
    // (door 1) — the dashboard-refund door must never fire for it (no double-reversal).
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
  });

  it('is idempotent on stripe_refund_id (already-recorded Refund → no double-record)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    // A Refund row already carries this event's re_1 (the in-app refund created it).
    mockPrisma.refund.findFirst.mockResolvedValue({ id: 're_row_existing' });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

    expect(res.status).toBe(200);
    // No double-record: no transaction, just the StripeEvent row.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('processes dashboard refund for invoice path: INCREMENTS total_refunded and writes a Refund row', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    // Prior refunds total $0 → accumulated = 0 + 1000.
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        refund: { create: vi.fn() },
        payment: { update: vi.fn() },
        invoice: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      capturedTx = tx;
      await fn(tx);
      return tx;
    });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

    expect(res.status).toBe(200);
    // A first-class Refund row is written with the Stripe refund id.
    expect(capturedTx.refund.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stripe_refund_id: 're_1', amount: 1000 }),
    }));
    // total_refunded is the ACCUMULATED total (prior 0 + 1000), invoice fully refunded.
    expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'REFUNDED',
        total_refunded: 1000,
        refund_reason: 'Refunded via Stripe dashboard',
      }),
    }));
    expect(capturedTx.timelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ source: 'stripe_dashboard' }),
      }),
    }));
    // Task 3.2 (door 2 guard): no event.account on this event ⇒ not a direct charge ⇒ no
    // application fee ever existed to reverse.
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    expect(stripe.applicationFees.list).not.toHaveBeenCalled();
  });

  // ─── Slice 6 (card service fee) — a dashboard refund must strip the fee out of the
  // face-value figure it writes; the raw Stripe cents include the customer's service fee. ───
  describe('service fee stripped from dashboard refunds (Slice 6)', () => {
    it('a full dashboard refund of the fee-inclusive charge writes exactly the face amount', async () => {
      // $1000 face + $35 fee = $1035 originally charged; the dashboard admin refunds it all.
      mockPrisma.payment.findFirst.mockResolvedValue({ ...PAYMENT_FIXTURE, service_fee_amount: 35 });
      mockPrisma.refund.findFirst.mockResolvedValue(null);
      mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          refund: { create: vi.fn() },
          payment: { update: vi.fn() },
          invoice: { update: vi.fn() },
          timelineEvent: { create: vi.fn() },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 103500));

      expect(res.status).toBe(200);
      // Face value only (1000), not the raw 1035 Stripe cents-derived figure.
      expect(capturedTx.refund.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 1000 }),
      }));
      expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'REFUNDED', total_refunded: 1000 }),
      }));
    });

    it('a partial dashboard refund strips the fee proportionally too', async () => {
      // Half the $1035 charge refunded (51750c) → face-only equivalent is exactly $500.
      mockPrisma.payment.findFirst.mockResolvedValue({ ...PAYMENT_FIXTURE, service_fee_amount: 35 });
      mockPrisma.refund.findFirst.mockResolvedValue(null);
      mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          refund: { create: vi.fn() },
          payment: { update: vi.fn() },
          invoice: { update: vi.fn() },
          timelineEvent: { create: vi.fn() },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 51750));

      expect(res.status).toBe(200);
      expect(capturedTx.refund.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 500 }),
      }));
      expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'PARTIALLY_REFUNDED', total_refunded: 500 }),
      }));
    });

    // Slice 7 — the tip is stripped out by the same fraction, alongside the service fee.
    it('a full dashboard refund of a fee-and-tip-inclusive charge writes exactly the face amount', async () => {
      // $1000 face + $35 fee + $150 tip = $1185 originally charged; refunded in full.
      mockPrisma.payment.findFirst.mockResolvedValue({ ...PAYMENT_FIXTURE, service_fee_amount: 35, tip_amount: 150 });
      mockPrisma.refund.findFirst.mockResolvedValue(null);
      mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
      let capturedTx: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          refund: { create: vi.fn() },
          payment: { update: vi.fn() },
          invoice: { update: vi.fn() },
          timelineEvent: { create: vi.fn() },
        };
        capturedTx = tx;
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 118500));

      expect(res.status).toBe(200);
      expect(capturedTx.refund.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: 1000 }),
      }));
      expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'REFUNDED', total_refunded: 1000 }),
      }));
    });
  });

  // ─── Task 3.2 — door 2: dashboard-initiated refund reverses the platform fee ──────────
  it('reverses the application fee proportionally for a dashboard refund on a direct charge (event.account set)', async () => {
    const directOrg = { id: 'org_1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'] };
    // event.account set → resolveOrgFromEvent's Connect path resolves the org this way first.
    mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        refund: { create: vi.fn() },
        payment: { update: vi.fn() },
        invoice: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      await fn(tx);
      return tx;
    });
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    (stripe.applicationFees.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: 'fee_1', amount: 5000, amount_refunded: 0 }],
    });

    // $1000 charge (100000c), $250 refunded (25000c) → 25% → 25% of the $50 fee = $12.50 (1250c).
    const res = await postWebhook(
      makeChargeRefundedEvent('pi_test_refund_1', 25000, undefined, {
        account: 'acct_test', chargeId: 'ch_1', chargeAmount: 100000,
      }),
    );

    expect(res.status).toBe(200);
    expect(stripe.applicationFees.list).toHaveBeenCalledWith({ charge: 'ch_1', limit: 1 });
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledWith('fee_1', { amount: 1250 });
  });

  // Bug: charge.amount_refunded is Stripe's CUMULATIVE refunded total on the charge. The old
  // code recomputed "fee * cumulative portion" and reversed that ABSOLUTE figure on every
  // event, re-reversing the portion already reversed by a prior event. A second sequential
  // dashboard refund must reverse only the INCREMENTAL fee owed since the last reversal.
  it('reverses only the INCREMENTAL fee portion on a second sequential dashboard refund (does not re-reverse the first portion)', async () => {
    const directOrg = { id: 'org_1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'] };
    mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        refund: { create: vi.fn() },
        payment: { update: vi.fn() },
        invoice: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      await fn(tx);
      return tx;
    });
    const { stripe } = getStripeForOrg({ stripe_account_id: null });

    // $1000 charge (100000c), $50 application fee (5000c).
    // 1st dashboard refund: 30% of the charge (30000c). appFee.amount_refunded starts at 0,
    // so target (round(5000 * 0.30) = 1500) minus already-reversed (0) = reverse 1500.
    (stripe.applicationFees.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: 'fee_1', amount: 5000, amount_refunded: 0 }],
    });
    const res1 = await postWebhook(
      makeChargeRefundedEvent('pi_test_refund_1', 30000, undefined, {
        account: 'acct_test', chargeId: 'ch_1', chargeAmount: 100000,
        eventId: 'evt_charge_refunded_partial_1', refundId: 're_partial_1',
      }),
    );
    expect(res1.status).toBe(200);
    expect(stripe.applicationFees.createRefund).toHaveBeenNthCalledWith(1, 'fee_1', { amount: 1500 });

    // 2nd dashboard refund: charge now cumulatively 60% refunded (60000c). Stripe now reports
    // appFee.amount_refunded = 1500 — what the first reversal actually left behind. Target
    // (round(5000 * 0.60) = 3000) minus already-reversed (1500) = reverse 1500 more (NOT 3000
    // again, which is what the old absolute-target code would have done).
    (stripe.applicationFees.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: 'fee_1', amount: 5000, amount_refunded: 1500 }],
    });
    const res2 = await postWebhook(
      makeChargeRefundedEvent('pi_test_refund_1', 60000, undefined, {
        account: 'acct_test', chargeId: 'ch_1', chargeAmount: 100000,
        eventId: 'evt_charge_refunded_partial_2', refundId: 're_partial_2',
      }),
    );
    expect(res2.status).toBe(200);
    expect(stripe.applicationFees.createRefund).toHaveBeenNthCalledWith(2, 'fee_1', { amount: 1500 });
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledTimes(2);
  });

  it('does not reverse the application fee when the application fee is already fully refunded', async () => {
    const directOrg = { id: 'org_1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'] };
    mockPrisma.organization.findFirst.mockResolvedValue(directOrg);
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    mockPrisma.refund.findFirst.mockResolvedValue(null);
    mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin_1' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        refund: { create: vi.fn() },
        payment: { update: vi.fn() },
        invoice: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      await fn(tx);
      return tx;
    });
    const { stripe } = getStripeForOrg({ stripe_account_id: null });
    (stripe.applicationFees.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: 'fee_1', amount: 5000, amount_refunded: 5000 }],
    });

    const res = await postWebhook(
      makeChargeRefundedEvent('pi_test_refund_1', 100000, undefined, {
        account: 'acct_test', chargeId: 'ch_1', chargeAmount: 100000,
      }),
    );

    expect(res.status).toBe(200);
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

    it('in-app refund "record only" branch tolerates P2002 and still returns 200', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
      mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000, { source: 'in_app' }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('already-recorded dashboard refund "record only" branch tolerates P2002 and still returns 200', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
      mockPrisma.refund.findFirst.mockResolvedValue({ id: 're_row_existing' });
      mockPrisma.stripeEvent.create.mockRejectedValue(p2002Error());

      const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

// ─── Phase 2c: charge.dispute.* webhooks (chargebacks) ────────────────────────────
describe('charge.dispute.* webhooks', () => {
  const DISPUTE_ORG = { id: 'org_1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'CHECK'] };

  // Payment fixture used both by resolveOrgFromEvent (org resolution via PI) and the handler.
  const DISPUTE_PAYMENT = {
    id: 'pay_disp_1',
    invoice_id: 'inv_disp_1',
    amount: 1000,
    method: 'CARD',
    stripe_payment_intent_id: 'pi_disp_1',
    voided_at: null,
    void_category: null,
    invoice: {
      id: 'inv_disp_1',
      status: 'PAID',
      organization_id: 'org_1',
      invoice_number: 'I00010',
      stripe_dispute_id: null,
      kind: 'STANDARD',
      organization: DISPUTE_ORG,
    },
  };

  function makeDisputeEvent(type: string, obj: Record<string, unknown>, id = 'evt_dispute_1') {
    return { id, type, data: { object: { object: 'dispute', ...obj } } };
  }

  beforeEach(() => {
    // resolveOrgFromEvent for a dispute resolves org via payment_intent → payment → invoice.organization.
    mockPrisma.payment.findFirst.mockResolvedValue(DISPUTE_PAYMENT);
  });

  describe('charge.dispute.created', () => {
    it('flags the invoice DISPUTED, sets stripe_dispute_id, writes INVOICE_DISPUTED timeline, no reversal', async () => {
      const captured: any = {};
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          invoice: { update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate = a; return {}; }) },
          payment: { update: vi.fn() },
          timelineEvent: { create: vi.fn().mockImplementation((a: any) => { captured.timeline = a; return {}; }) },
        };
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      // Invoice flagged DISPUTED + dispute id stored.
      expect(captured.invoiceUpdate.where).toEqual({ id: 'inv_disp_1' });
      expect(captured.invoiceUpdate.data).toEqual(expect.objectContaining({ status: 'DISPUTED', stripe_dispute_id: 'dp_1' }));
      // Timeline event written.
      expect(captured.timeline.data).toEqual(expect.objectContaining({ event_type: 'INVOICE_DISPUTED', entity_type: 'INVOICE' }));
      // No payment void (the dispute may be won).
      expect(captured.invoiceUpdate.data.amount_due).toBeUndefined();
      // Task 3.2 (door 3 negative): dispute CREATED must never reverse the platform fee —
      // only a LOST dispute does. Flag-only, per the brief.
      const { stripe } = getStripeForOrg({ stripe_account_id: null });
      expect(stripe.applicationFees.list).not.toHaveBeenCalled();
      expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
    });

    it('is idempotent on stripe_dispute_id (replay → record event only, no $transaction)', async () => {
      // The resolved invoice already carries this dispute id.
      mockPrisma.payment.findFirst.mockResolvedValue({
        ...DISPUTE_PAYMENT,
        invoice: { ...DISPUTE_PAYMENT.invoice, status: 'DISPUTED', stripe_dispute_id: 'dp_1' },
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('records the event only when no Payment matches the dispute payment_intent', async () => {
      // resolveOrgFromEvent fails to find a payment → org unresolved → 200, event recorded.
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.created', { id: 'dp_x', payment_intent: 'pi_unknown', charge: 'ch_x' }),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });
  });

  describe('charge.dispute.closed — won', () => {
    it('clears the flag and restores PAID, no payment void', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv_disp_1', status: 'DISPUTED', organization_id: 'org_1', invoice_number: 'I00010',
        total_amount: 1000, amount_due: 0, kind: 'STANDARD',
      });
      const captured: any = {};
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          invoice: { update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate = a; return {}; }) },
          payment: { update: vi.fn().mockImplementation((a: any) => { captured.paymentUpdate = a; return {}; }), updateMany: vi.fn() },
          depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'won', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      expect(captured.invoiceUpdate.data).toEqual(expect.objectContaining({ status: 'PAID', stripe_dispute_id: null }));
      // No payment voided on a won dispute.
      expect(captured.paymentUpdate).toBeUndefined();
      // Task 3.2 (door 3 negative): a WON dispute must never reverse the platform fee —
      // ServWave is entitled to keep it (the org kept the money too).
      const { stripe } = getStripeForOrg({ stripe_account_id: null });
      expect(stripe.applicationFees.list).not.toHaveBeenCalled();
      expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
    });

    it('is idempotent when the invoice is no longer DISPUTED (already resolved)', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv_disp_1', status: 'PAID', organization_id: 'org_1', invoice_number: 'I00010',
        total_amount: 1000, amount_due: 0, kind: 'STANDARD',
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'won', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });
  });

  describe('charge.dispute.closed — lost', () => {
    it('records a system void-payment (CHARGEBACK) that reopens amount_due, keeps stripe_dispute_id', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv_disp_1', status: 'DISPUTED', organization_id: 'org_1', invoice_number: 'I00010',
        total_amount: 1000, amount_due: 0, kind: 'STANDARD',
      });
      // The disputed CARD Payment re-found by stripe_payment_intent_id.
      mockPrisma.payment.findFirst.mockResolvedValue({
        ...DISPUTE_PAYMENT,
        invoice: { ...DISPUTE_PAYMENT.invoice, status: 'DISPUTED', stripe_dispute_id: 'dp_1' },
      });

      const captured: any = {};
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          invoice: {
            update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate = a; return {}; }),
            findFirst: vi.fn(),
          },
          payment: {
            update: vi.fn().mockImplementation((a: any) => { captured.paymentUpdate = a; return {}; }),
            updateMany: vi.fn(),
          },
          depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
          timelineEvent: { create: vi.fn().mockImplementation((a: any) => { (captured.timelines ??= []).push(a.data); return {}; }) },
        };
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'lost', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      // The disputed CARD/PI Payment is voided with CHARGEBACK by the system (voided_by null).
      expect(captured.paymentUpdate.data).toEqual(expect.objectContaining({ void_category: 'CHARGEBACK', voided_by: null }));
      // amount_due reopens by the payment amount; status drops below PAID; stripe_dispute_id stays set (charged-back marker).
      expect(Number(captured.invoiceUpdate.data.amount_due)).toBe(1000);
      expect(captured.invoiceUpdate.data.stripe_dispute_id).not.toBe(null);
      // A CHARGEBACK timeline is written.
      expect((captured.timelines ?? []).some((t: any) => t.event_type === 'CHARGEBACK')).toBe(true);
      // Task 3.2 (door 3 guard): this Payment has no stripe_account_id (legacy platform-account
      // charge) — it never had an application fee, so no reversal is attempted.
      const { stripe } = getStripeForOrg({ stripe_account_id: null });
      expect(stripe.applicationFees.list).not.toHaveBeenCalled();
    });

    // ─── Task 3.2 — door 3: a LOST dispute reverses the FULL remaining platform fee ──────
    it('reverses the FULL remaining application fee for a direct-charge dispute that is LOST', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv_disp_1', status: 'DISPUTED', organization_id: 'org_1', invoice_number: 'I00010',
        total_amount: 1000, amount_due: 0, kind: 'STANDARD',
      });
      // The disputed CARD Payment carries its own stripe_account_id snapshot (direct charge).
      mockPrisma.payment.findFirst.mockResolvedValue({
        ...DISPUTE_PAYMENT,
        stripe_account_id: 'acct_test',
        invoice: { ...DISPUTE_PAYMENT.invoice, status: 'DISPUTED', stripe_dispute_id: 'dp_1' },
      });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          invoice: { update: vi.fn(), findFirst: vi.fn() },
          payment: { update: vi.fn(), updateMany: vi.fn() },
          depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
          timelineEvent: { create: vi.fn() },
        };
        await fn(tx);
        return tx;
      });
      const { stripe } = getStripeForOrg({ stripe_account_id: null });
      (stripe.applicationFees.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [{ id: 'fee_disp_1', amount: 5000, amount_refunded: 0 }],
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'lost', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      expect(stripe.applicationFees.list).toHaveBeenCalledWith({ charge: 'ch_1', limit: 1 });
      // FULL remaining fee reversed — the entire charge is clawed back, not a partial proportion.
      expect(stripe.applicationFees.createRefund).toHaveBeenCalledWith('fee_disp_1', { amount: 5000 });
    });

    it('is idempotent when the disputed payment is already CHARGEBACK-voided', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv_disp_1', status: 'SENT', organization_id: 'org_1', invoice_number: 'I00010',
        total_amount: 1000, amount_due: 1000, kind: 'STANDARD',
      });
      mockPrisma.payment.findFirst.mockResolvedValue({
        ...DISPUTE_PAYMENT,
        voided_at: new Date(),
        void_category: 'CHARGEBACK',
        invoice: { ...DISPUTE_PAYMENT.invoice, stripe_dispute_id: 'dp_1' },
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'lost', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
    });

    it('cascades on a DEPOSIT-kind invoice: un-applies DepositCreditApplications', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'dep-inv-1', status: 'DISPUTED', organization_id: 'org_1', invoice_number: 'I00007',
        total_amount: 500, amount_due: 0, kind: 'DEPOSIT',
      });
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: 'pay_dep_disp', invoice_id: 'dep-inv-1', amount: 500, method: 'CARD',
        stripe_payment_intent_id: 'pi_disp_1', voided_at: null, void_category: null,
        invoice: { id: 'dep-inv-1', status: 'DISPUTED', organization_id: 'org_1', invoice_number: 'I00007', stripe_dispute_id: 'dp_1', kind: 'DEPOSIT', organization: DISPUTE_ORG },
      });

      const captured: any = { targetUpdates: [] };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          stripeEvent: { create: vi.fn() },
          invoice: {
            update: vi.fn().mockImplementation((a: any) => { captured.targetUpdates.push(a.data); return {}; }),
            findFirst: vi.fn().mockResolvedValue({ id: 'target-inv', amount_due: 0, total_amount: 5000, status: 'PAID', invoice_number: 'I00009' }),
          },
          payment: {
            update: vi.fn(),
            updateMany: vi.fn().mockImplementation((a: any) => { captured.creditVoid = a; return {}; }),
          },
          depositCreditApplication: {
            findMany: vi.fn().mockResolvedValue([{ id: 'dca_1', target_invoice_id: 'target-inv', amount: 500 }]),
            updateMany: vi.fn().mockImplementation((a: any) => { captured.appReverse = a.data; return {}; }),
          },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        };
        await fn(tx);
        return tx;
      });

      const res = await postWebhook(
        makeDisputeEvent('charge.dispute.closed', { id: 'dp_1', status: 'lost', payment_intent: 'pi_disp_1', charge: 'ch_1' }),
      );

      expect(res.status).toBe(200);
      // The deposit-credit application is reversed and the target invoice's amount_due rose.
      expect(captured.appReverse.reversed_at).toBeInstanceOf(Date);
      expect(captured.targetUpdates.some((u: any) => Number(u.amount_due) === 500)).toBe(true);
      expect(captured.creditVoid.where.reference_number).toBe('DEPOSIT-CREDIT');
    });
  });

  it('resolveOrgFromEvent resolves the owning org for a dispute via payment_intent', async () => {
    // A dispute carrying a known PI resolves through payment.findFirst → invoice.organization.
    // (Org-resolution success is proven by the handler proceeding past the CARD gate to flag DISPUTED.)
    const captured: any = {};
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        invoice: { update: vi.fn().mockImplementation((a: any) => { captured.invoiceUpdate = a; return {}; }) },
        payment: { update: vi.fn() },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      await fn(tx);
      return tx;
    });

    const res = await postWebhook(
      makeDisputeEvent('charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_disp_1', charge: 'ch_2' }),
    );

    expect(res.status).toBe(200);
    // Reached the handler body → org was resolved AND passed the CARD gate.
    expect(captured.invoiceUpdate.data).toEqual(expect.objectContaining({ status: 'DISPUTED' }));
  });
});

// ─── Task 1.6: account-lifecycle webhooks (pre-gate) ──────────────────────────
// account.updated / account.application.deauthorized must be handled BEFORE the
// §4.5 accepted_payment_methods gate: a mid-onboarding org does not yet accept CARD,
// so if this branch ran after the gate, the gate would silently swallow these events
// (200 + recorded — no error, no retry, no flag sync). These tests prove the branch
// runs first, fetches live truth via retrieveAccount (not the event payload), and is
// idempotent on the CARD auto-add.
describe('account-lifecycle webhooks (pre-gate)', () => {
  function makeAccountEvent(type: string, account: string, id = 'evt_acct_1', dataObject: object = {}) {
    return { id, type, account, data: { object: dataObject } };
  }

  it('account.updated writes flags for a mid-onboarding org (bypasses the CARD gate)', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org1', stripe_account_id: 'acct_1', accepted_payment_methods: [] });
    mockRetrieveAccount.mockResolvedValue({
      charges_enabled: true, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    });

    const res = await postWebhook(makeAccountEvent('account.updated', 'acct_1'));

    expect(res.status).toBe(200);
    // Proves pre-gate placement: this org's accepted_payment_methods is empty, so if the
    // lifecycle branch ran AFTER the §4.5 gate, the gate would short-circuit with
    // `ignored: 'org_does_not_accept_card'` and organization.update would never fire.
    expect(res.body).not.toEqual(expect.objectContaining({ ignored: 'org_does_not_accept_card' }));
    expect(mockPrisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stripe_charges_enabled: true, accepted_payment_methods: ['CARD'] }),
    }));
  });

  it('uses retrieveAccount truth, not a stale/out-of-order event payload', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org2', stripe_account_id: 'acct_2', accepted_payment_methods: [] });
    // The event payload snapshot says charges are OFF — simulating an out-of-order delivery
    // where a newer account.updated arrived and was processed before this older one.
    const staleEvent = makeAccountEvent('account.updated', 'acct_2', 'evt_acct_2', {
      charges_enabled: false, payouts_enabled: false, details_submitted: false,
    });
    // The live account fetch says charges ARE on. The handler must trust the fetch, not the payload.
    mockRetrieveAccount.mockResolvedValue({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    });

    const res = await postWebhook(staleEvent);

    expect(res.status).toBe(200);
    expect(mockRetrieveAccount).toHaveBeenCalledWith('acct_2');
    expect(mockPrisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stripe_charges_enabled: true, stripe_payouts_enabled: true }),
    }));
  });

  it('does not append a duplicate CARD when accepted_payment_methods already contains it', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({
      id: 'org3', stripe_account_id: 'acct_3', accepted_payment_methods: ['CARD'],
      stripe_charges_enabled: true, stripe_payouts_enabled: true,
    });
    mockRetrieveAccount.mockResolvedValue({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    });

    const res = await postWebhook(makeAccountEvent('account.updated', 'acct_3', 'evt_acct_3'));

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.organization.update.mock.calls[0][0];
    // addCard computes false because 'CARD' is already present — the key is omitted entirely,
    // never re-written as a duplicate-laden array.
    expect(updateCall.data.accepted_payment_methods).toBeUndefined();
  });

  it('account.application.deauthorized nulls flags and sets disabled_reason=deauthorized (no retrieveAccount fetch)', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org4', stripe_account_id: 'acct_4', accepted_payment_methods: ['CARD'] });

    const res = await postWebhook(makeAccountEvent('account.application.deauthorized', 'acct_4', 'evt_acct_4'));

    expect(res.status).toBe(200);
    expect(mockPrisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org4' },
      data: expect.objectContaining({
        stripe_charges_enabled: false,
        stripe_payouts_enabled: false,
        stripe_details_submitted: false,
        stripe_requirements_due: [],
        stripe_disabled_reason: 'deauthorized',
      }),
    }));
    // Deauthorization is a pure teardown — no need to fetch the (now-revoked) account.
    expect(mockRetrieveAccount).not.toHaveBeenCalled();
  });

  it('records the event and returns 200 without crashing when no org matches the connected account', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue(null);

    const res = await postWebhook(makeAccountEvent('account.updated', 'acct_unknown', 'evt_acct_unknown'));

    expect(res.status).toBe(200);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  // ── Task 1.8 — the 4 verbs fired here (emitPaymentsNotif) are registered in
  // templates.ts/resolveRecipients.ts. Before Task 1.8, emit() silently no-op'd
  // via isKnownVerb() — org flags still synced (proven by the tests above) but
  // no Notification row was ever created. These tests drive the real webhook
  // path end-to-end (not renderTemplate/resolveRecipients in isolation) to prove
  // the no-op is gone: a real Notification + NotificationRecipient row persist.
  describe('account-lifecycle notifications go live (Task 1.8 — verbs now registered)', () => {
    it('billing.payments_activated: charges flips false→true creates a real Notification for org ADMINs (FEED)', async () => {
      mockPrisma.organization.findFirst.mockResolvedValue({
        id: 'org_notif_1', stripe_account_id: 'acct_notif_1', accepted_payment_methods: [],
        stripe_charges_enabled: false, stripe_payouts_enabled: false, name: 'Acme Plumbing',
      });
      mockRetrieveAccount.mockResolvedValue({
        charges_enabled: true, payouts_enabled: false, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin1', role: 'ADMIN', email: 'admin1@acme.test' }]);
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'notif1' });

      const res = await postWebhook(makeAccountEvent('account.updated', 'acct_notif_1', 'evt_notif_1'));

      expect(res.status).toBe(200);
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: 'org_notif_1',
          verb: 'billing.payments_activated',
          category: 'BILLING',
          object_type: 'ORGANIZATION',
          priority: 'FEED',
          needs_action: false,
          dedup_key: 'billing.payments_activated:activated:acct_notif_1',
        }),
      }));
      expect(prisma.notificationRecipient.createMany).toHaveBeenCalledWith({
        data: [{ notification_id: 'notif1', organization_id: 'org_notif_1', recipient_id: 'admin1', priority: 'FEED', needs_action: false }],
      });
      // Task 1.9: activation is a FEED-only nudge — no action-needed email.
      expect(sendPaymentsActionNeededEmail).not.toHaveBeenCalled();
    });

    it('billing.payments_action_needed: requirements due creates a real Notification for org ADMINs (INTERRUPT + needs_action)', async () => {
      mockPrisma.organization.findFirst.mockResolvedValue({
        id: 'org_notif_2', stripe_account_id: 'acct_notif_2', accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true, stripe_payouts_enabled: true, name: 'Acme Plumbing',
      });
      mockRetrieveAccount.mockResolvedValue({
        charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: ['individual.verification.document'], disabled_reason: null },
      });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin2', role: 'ADMIN', email: 'admin2@acme.test' }]);
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'notif2' });

      const res = await postWebhook(makeAccountEvent('account.updated', 'acct_notif_2', 'evt_notif_2'));

      expect(res.status).toBe(200);
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: 'org_notif_2',
          verb: 'billing.payments_action_needed',
          category: 'BILLING',
          object_type: 'ORGANIZATION',
          priority: 'INTERRUPT',
          needs_action: true,
          dedup_key: 'billing.payments_action_needed:action:acct_notif_2:individual.verification.document',
        }),
      }));
      expect(prisma.notificationRecipient.createMany).toHaveBeenCalledWith({
        data: [{ notification_id: 'notif2', organization_id: 'org_notif_2', recipient_id: 'admin2', priority: 'INTERRUPT', needs_action: true }],
      });
      // Task 1.9: the "Interrupt + email" half — co-branded action-needed email to the admin.
      expect(sendPaymentsActionNeededEmail).toHaveBeenCalledWith({
        organizationId: 'org_notif_2',
        to: 'admin2@acme.test',
        orgName: 'Acme Plumbing',
        fixUrl: 'http://localhost:5173/settings/payments',
      });
    });

    // ── Task 1.9 — deferred-bank nudge + co-branded action-needed email ──────
    it('billing.payments_paused: disabled_reason set creates a real Notification for org ADMINs (INTERRUPT + needs_action) and emails each active admin', async () => {
      mockPrisma.organization.findFirst.mockResolvedValue({
        id: 'org_notif_3', stripe_account_id: 'acct_notif_3', accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: false, stripe_payouts_enabled: false, name: 'Acme Plumbing',
      });
      mockRetrieveAccount.mockResolvedValue({
        charges_enabled: false, payouts_enabled: false, details_submitted: true,
        requirements: { currently_due: [], disabled_reason: 'requirements.past_due' },
      });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin3', role: 'ADMIN', email: 'admin3@acme.test' }]);
      (prisma.notification.findFirst as any).mockResolvedValue(undefined);
      (prisma.notification.create as any).mockResolvedValue({ id: 'notif3' });

      const res = await postWebhook(makeAccountEvent('account.updated', 'acct_notif_3', 'evt_notif_3'));

      expect(res.status).toBe(200);
      expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          organization_id: 'org_notif_3',
          verb: 'billing.payments_paused',
          category: 'BILLING',
          object_type: 'ORGANIZATION',
          priority: 'INTERRUPT',
          needs_action: true,
          dedup_key: 'billing.payments_paused:paused:acct_notif_3:requirements.past_due',
        }),
      }));
      expect(sendPaymentsActionNeededEmail).toHaveBeenCalledWith({
        organizationId: 'org_notif_3',
        to: 'admin3@acme.test',
        orgName: 'Acme Plumbing',
        fixUrl: 'http://localhost:5173/settings/payments',
      });
    });

    it('does not re-send the action-needed email (or re-create the Notification) when the same requirements-hash was already notified — a re-delivered account.updated must not re-email', async () => {
      mockPrisma.organization.findFirst.mockResolvedValue({
        id: 'org_notif_4', stripe_account_id: 'acct_notif_4', accepted_payment_methods: ['CARD'],
        stripe_charges_enabled: true, stripe_payouts_enabled: true, name: 'Acme Plumbing',
      });
      mockRetrieveAccount.mockResolvedValue({
        charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements: { currently_due: ['individual.verification.document'], disabled_reason: null },
      });
      (prisma.user.findMany as any).mockResolvedValue([{ id: 'admin4', role: 'ADMIN', email: 'admin4@acme.test' }]);
      // A Notification with this exact dedup_key already exists (from a prior delivery) —
      // proves the pre-check gates the email even though emit() itself also no-ops.
      (prisma.notification.findFirst as any).mockResolvedValue({ id: 'existing_notif' });

      const res = await postWebhook(makeAccountEvent('account.updated', 'acct_notif_4', 'evt_notif_4'));

      expect(res.status).toBe(200);
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(sendPaymentsActionNeededEmail).not.toHaveBeenCalled();
    });
  });
});
