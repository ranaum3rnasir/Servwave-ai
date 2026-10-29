/**
 * #2031 slice 5, F1 — a card capture the system refuses to apply must not vanish.
 *
 * When the checkout's total does not agree with what the invoice is owed, the webhook declines to
 * write a Payment. That is right: the figures do not reconcile, and guessing is worse. But the
 * customer's card HAS been charged by then — the money exists — and the branch used to leave
 * nothing behind but a log line, while still recording the event so the processor never
 * re-delivers it. A silent orphaned capture: no Payment, no timeline entry, nobody told.
 *
 * Before this slice a live deposit's amount_due essentially never moved, so the branch was close
 * to unreachable. Now every resend re-prices, so it is on the ordinary path.
 *
 * Second entry to the same record: a deposit whose estimate has moved on. Expiring the open
 * sessions (deposit-checkout-expiry.test.ts) is what stops the money moving at all — this is the
 * backstop for when that external call failed, and it is deliberately amount-aware so it never
 * refuses a deposit that is still asking for exactly the right figure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  notificationAlreadyExists: vi.fn().mockResolvedValue(false),
}));

import { emit } from '../services/notifications/notificationService';

const mockEmit = emit as unknown as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as unknown as Record<string, any>;

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

/** A deposit invoice for $500 whose estimate is in step with it (a $1,000 total at 50%). */
function depositInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 'd1000000-0000-0000-0000-000000000001',
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
      status: 'SENT',
      modified_after_send: false,
      deposit_type: null,
      deposit_value: null,
      creator: { email: 'creator@example.com' },
      organization: { name: 'Test Org', logo_url: null, brand_color: null },
      customer: null,
      lead: { commission_owner_id: null, status: 'ESTIMATED', customer: null },
    },
    ...over,
  };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_123',
    object: 'checkout.session',
    payment_intent: 'pi_test_abc',
    amount_total: 50000,
    metadata: { invoiceId: depositInvoice().id },
    ...over,
  };
}

function postWebhook(body: object) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test_sig')
    .send(Buffer.from(JSON.stringify({ id: 'evt_unapplied_1', type: 'checkout.session.completed', data: { object: body } })));
}

function timelineRows() {
  return mockPrisma.timelineEvent.create.mock.calls.map((c: any[]) => c[0].data);
}

function auditRows() {
  return mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
});

describe('a card capture the webhook will not apply', () => {
  it('leaves a findable record on the invoice when the figures do not reconcile', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice());

    const res = await postWebhook(session({ amount_total: 99999 }));

    expect(res.status).toBe(200);
    // Still no Payment — the figures do not reconcile and guessing is worse.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    const row = timelineRows().find((d: any) => d.event_type === 'PAYMENT_UNRECORDED');
    expect(row).toBeDefined();
    expect(row.entity_type).toBe('INVOICE');
    expect(row.entity_id).toBe(depositInvoice().id);
    expect(row.organization_id).toBe(ORG.id);
    // The figures a human needs in order to go and find the charge.
    expect(row.metadata).toMatchObject({
      reason: 'AMOUNT_MISMATCH',
      expected_cents: 50000,
      charged_cents: 99999,
      payment_intent: 'pi_test_abc',
    });
  });

  it('tells somebody, rather than only writing it down', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice());

    await postWebhook(session({ amount_total: 99999 }));

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const emitted = mockEmit.mock.calls[0][0];
    expect(emitted.verb).toBe('billing.payment_unrecorded');
    expect(emitted.organizationId).toBe(ORG.id);
    expect(emitted.object).toMatchObject({ type: 'INVOICE', id: depositInvoice().id });
    // The processor retries; the notification must not multiply.
    expect(emitted.dedupKey).toContain('evt_unapplied_1');
  });

  it('files it on the audit trail too', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice());

    await postWebhook(session({ amount_total: 99999 }));

    const row = auditRows().find((d: any) => d.action === 'billing.payment_unrecorded');
    expect(row).toBeDefined();
    expect(row.resource_type).toBe('Invoice');
    expect(row.resource_id).toBe(depositInvoice().id);
  });

  it('records nothing of the sort when the payment applies normally', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice());
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        invoice: { update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay_1' }) },
      };
      await fn(tx);
      return tx;
    });

    await postWebhook(session());

    expect(timelineRows().find((d: any) => d.event_type === 'PAYMENT_UNRECORDED')).toBeUndefined();
    expect(auditRows().find((d: any) => d.action === 'billing.payment_unrecorded')).toBeUndefined();
  });
});

describe('a deposit whose estimate moved on before the webhook arrived', () => {
  it('refuses to book it, and leaves the same record behind', async () => {
    // The estimate went from $1,000 to $1,800, so the deposit should now be $900 — but the
    // re-price has not run, amount_due is still $500, and the session settles against it cleanly.
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice({
      estimate: { ...depositInvoice().estimate, modified_after_send: true, total_amount: 1800 },
    }));

    const res = await postWebhook(session());

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    const row = timelineRows().find((d: any) => d.event_type === 'PAYMENT_UNRECORDED');
    expect(row).toBeDefined();
    expect(row.metadata).toMatchObject({ reason: 'DEPOSIT_SUPERSEDED' });
  });

  // F4's rule applies here too, and it matters more: refusing here costs the customer a charge
  // that is never credited to them.
  it('books it normally when the edit did not move the deposit figure', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice({
      estimate: {
        ...depositInvoice().estimate,
        modified_after_send: true,
        total_amount: 1800,
        deposit_type: 'FIXED',
        deposit_value: 500,
      },
    }));
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        invoice: { update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay_1' }) },
      };
      await fn(tx);
      return tx;
    });

    await postWebhook(session());

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(timelineRows().find((d: any) => d.event_type === 'PAYMENT_UNRECORDED')).toBeUndefined();
  });

  // Under a mocked Prisma the row is whatever the double returns, so the gate proves nothing
  // unless the handler actually asks the database for what it compares.
  it('selects what the comparison needs on the webhook lookup', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(depositInvoice());

    await postWebhook(session());

    // The first lookup is resolveOrgFromEvent's own; the money query is the one that reads the
    // amount.
    const args = mockPrisma.invoice.findUnique.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.select?.amount_due === true);
    expect(args).toBeDefined();
    expect(args.select.estimate.select.modified_after_send).toBe(true);
    expect(args.select.estimate.select.deposit_type).toBe(true);
    expect(args.select.estimate.select.deposit_value).toBe(true);
    expect(args.select.organization.select.deposit_default_percentage).toBe(true);
  });
});
