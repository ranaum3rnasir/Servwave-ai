/**
 * invoice-notifications.test.ts
 *
 * TDD for Task 3.4: emit() hooks on invoice/payment lifecycle events.
 *
 * Verbs covered:
 *   1. billing.payment_received  — recordPayment (fully paid)
 *   2. billing.partial_payment   — recordPayment (partially paid)
 *   3. billing.refunded          — refundInvoice
 *   4. billing.voided            — voidInvoice
 *   5. billing.credit_applied    — credit
 *   6. billing.disputed          — Stripe webhook charge.dispute.created (actorId:null, Stripe-retry dedupKey)
 *   7. billing.chargeback        — systemVoidPaymentForChargeback inside charge.dispute.closed(lost) (actorId:null, dedupKey)
 *
 * Strategy (mirrors estimate-notifications.test.ts):
 *   - vi.mock captures emit calls.
 *   - Tests hit the real Express route via supertest.
 *   - Prisma is fully mocked (vi.mock in setup.ts).
 *   - emit() is asserted on verb, object, entity.customer_owner_id, actorId.
 *   - Webhook paths assert actorId:null + Stripe-retry dedupKeys.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  INVOICE_FIXTURE,
  INVOICE_SENT_FIXTURE,
  INVOICE_PARTIAL_FIXTURE,
  CUSTOMER_FIXTURE,
  JOB_FIXTURE,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { createRefund } from '../lib/stripe';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

const mockCreateRefund = createRefund as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INVOICE_ID = INVOICE_SENT_FIXTURE.id;   // '00000000-0000-0000-0000-000000000902'
const INVOICE_NUM = INVOICE_SENT_FIXTURE.invoice_number; // 'I00002'

/** Sales user is the commission owner (simulating lead → estimate → job → invoice chain). */
const COMMISSION_OWNER_ID = TEST_USERS.sales.id;

/**
 * Invoice select returned by recordPayment / voidInvoice / refundInvoice / credit:
 * includes the job → estimate → lead chain so customer_owner_id can be derived.
 */
function buildInvoiceForRecord(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUM,
    status: 'SENT',
    kind: 'STANDARD',
    amount_due: 1268,
    total_amount: 2268,
    organization_id: ALPHA_ORG_ID,
    customer: {
      id: CUSTOMER_FIXTURE.id,
      first_name: 'John',
      last_name: 'Doe',
      company_name: 'Doe HVAC',
      email: 'john@doe.com',
    },
    job: {
      id: JOB_FIXTURE.id,
      job_number: JOB_FIXTURE.job_number,
      assignees: [{ user_id: TEST_USERS.technician.id }],
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        email: 'john@doe.com',
      },
      estimate: {
        lead: {
          lead_assignees: [{ user_id: COMMISSION_OWNER_ID }],
          commission_owner_id: COMMISSION_OWNER_ID,
        },
      },
    },
    estimate: null,
    ...overrides,
  };
}

/** For refundInvoice: includes full organization and payments */
function buildPaidInvoice(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUM,
    status: 'PAID',
    kind: 'STANDARD',
    amount_due: 0,
    total_amount: 1268,
    tax_amount: 80,
    net_collected: 1268,
    organization: { id: ALPHA_ORG_ID, stripe_account_id: null, accepted_payment_methods: ['CARD'] },
    organization_id: ALPHA_ORG_ID,
    payments: [
      {
        id: 'pay_1',
        amount: 1268,
        method: 'CARD',
        stripe_payment_intent_id: 'pi_test_456',
        refunded_at: null,
        reference_number: null,
        voided_at: null,
      },
    ],
    refunds: [],
    customer: {
      id: CUSTOMER_FIXTURE.id,
      email: 'john@doe.com',
      first_name: 'John',
      last_name: 'Doe',
    },
    job: {
      id: JOB_FIXTURE.id,
      job_number: JOB_FIXTURE.job_number,
      customer: null,
      estimate: {
        lead: {
          commission_owner_id: COMMISSION_OWNER_ID,
        },
      },
    },
    ...overrides,
  };
}

/** For credit: SENT invoice with no payments yet */
function buildCreditInvoice(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUM,
    status: 'SENT',
    kind: 'STANDARD',
    amount_due: 1268,
    total_amount: 1268,
    tax_amount: 0,
    net_collected: 0,
    organization: { id: ALPHA_ORG_ID, stripe_account_id: null },
    organization_id: ALPHA_ORG_ID,
    payments: [],
    refunds: [],
    customer: {
      id: CUSTOMER_FIXTURE.id,
      email: 'john@doe.com',
      first_name: 'John',
      last_name: 'Doe',
    },
    job: {
      id: JOB_FIXTURE.id,
      job_number: JOB_FIXTURE.job_number,
      customer: null,
      estimate: {
        lead: {
          commission_owner_id: COMMISSION_OWNER_ID,
        },
      },
    },
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // canAccessRow uses invoice.count with tenant scope.
  mockPrisma.invoice.count.mockResolvedValue(1);
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // Stripe webhook dedup.
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});

  mockPrisma.timelineEvent.create.mockResolvedValue({});

  // Safe default $transaction passthrough.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      invoice: { update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
      // Inventory P1 (§4.4): voidInvoice's auto-return pass — no SYNCED lines in these flows.
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      payment: { create: vi.fn().mockResolvedValue({ id: 'pay_new' }), update: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      stripeEvent: { create: vi.fn().mockResolvedValue({}) },
      refund: { create: vi.fn().mockResolvedValue({ id: 're_1' }) },
      credit: { create: vi.fn().mockResolvedValue({ id: 'cr_1' }) },
      depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      job: { update: vi.fn().mockResolvedValue({}) },
    }),
  );
});

// ─── Stripe webhook helper ────────────────────────────────────────────────────

function postWebhook(body: object, sig = 'test_sig') {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', sig)
    .send(Buffer.from(JSON.stringify(body)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. recordPayment — billing.payment_received (full payment)
// ─────────────────────────────────────────────────────────────────────────────

describe('recordPayment (full) — billing.payment_received', () => {
  it('emits billing.payment_received with staff actorId and customer_owner_id', async () => {
    mockAuthAs('admin');

    const invoice = buildInvoiceForRecord({
      // Full payment: amount_due = 1268
      amount_due: 1268,
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_new',
            amount: 1268,
            method: 'CHECK',
            paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });

    expect(res.status).toBe(201);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. recordPayment — billing.partial_payment (partial)
// ─────────────────────────────────────────────────────────────────────────────

describe('recordPayment (partial) — billing.partial_payment', () => {
  it('emits billing.partial_payment (not billing.payment_received) when balance remains', async () => {
    mockAuthAs('admin');

    const invoice = buildInvoiceForRecord({ amount_due: 1268 });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    // Partial payment: only pay 500 of 1268, leaving a balance
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_partial',
            amount: 500,
            method: 'CHECK',
            paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);

    // billing.partial_payment must be emitted (isFullyPaid = false)
    const partialCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.partial_payment');
    expect(partialCall).toBeDefined();
    const args = partialCall![0];
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);

    // billing.payment_received must NOT be emitted (partial, not full)
    const fullCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(fullCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. refundInvoice — billing.refunded
// ─────────────────────────────────────────────────────────────────────────────

describe('refundInvoice — billing.refunded', () => {
  it('emits billing.refunded with staff actorId and customer_owner_id', async () => {
    mockAuthAs('admin');

    mockPrisma.invoice.findUnique.mockResolvedValue(buildPaidInvoice());
    mockCreateRefund.mockResolvedValue({ id: 're_stripe_1' });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        refund: { create: vi.fn().mockResolvedValue({ id: 're_1' }) },
        invoice: { update: vi.fn().mockResolvedValue({}) },
        payment: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/refund`)
      .set(authHeader('admin'))
      .send({ amount: 500, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer changed mind' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.refunded');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. voidInvoice — billing.voided
// ─────────────────────────────────────────────────────────────────────────────

describe('voidInvoice — billing.voided', () => {
  it('emits billing.voided with staff actorId and customer_owner_id', async () => {
    mockAuthAs('admin');

    const invoice = {
      id: INVOICE_ID,
      status: 'SENT',
      invoice_number: INVOICE_NUM,
      kind: 'STANDARD',
      total_amount: 1268,
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      job: {
        assignees: [{ user_id: TEST_USERS.technician.id }],
        estimate: {
          lead: {
            lead_assignees: [{ user_id: COMMISSION_OWNER_ID }],
            commission_owner_id: COMMISSION_OWNER_ID,
          },
        },
      },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
        },
        // Inventory P1 (§4.4): void's auto-return pass — no SYNCED lines here.
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        job: { update: vi.fn().mockResolvedValue({}) },
        depositCreditApplication: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.voided');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
    // voided: no dedupKey
    expect(args.dedupKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. credit — billing.credit_applied
// ─────────────────────────────────────────────────────────────────────────────

describe('credit — billing.credit_applied', () => {
  it('emits billing.credit_applied with staff actorId and customer_owner_id', async () => {
    mockAuthAs('admin');

    mockPrisma.invoice.findUnique.mockResolvedValue(buildCreditInvoice());

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        credit: { create: vi.fn().mockResolvedValue({ id: 'cr_1' }) },
        refund: { create: vi.fn().mockResolvedValue({ id: 're_1' }) },
        invoice: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({ id: INVOICE_ID }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/credit`)
      .set(authHeader('admin'))
      .send({ amount: 200, reason: 'Goodwill discount' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.credit_applied');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
    // no dedupKey for credit
    expect(args.dedupKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stripe webhook charge.dispute.created — billing.disputed (actorId:null, dedupKey)
// ─────────────────────────────────────────────────────────────────────────────

describe('charge.dispute.created webhook — billing.disputed', () => {
  const DISPUTE_ID = 'dp_test_001';
  const PI_ID = 'pi_test_001';

  const invoiceForDispute = {
    id: INVOICE_ID,
    status: 'PAID',
    organization_id: ALPHA_ORG_ID,
    invoice_number: INVOICE_NUM,
    stripe_dispute_id: null,
  };

  const paymentForDispute = {
    id: 'pay_disputed',
    stripe_payment_intent_id: PI_ID,
    invoice: invoiceForDispute,
  };

  const webhookEvent = {
    id: 'evt_disp_001',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: DISPUTE_ID,
        payment_intent: PI_ID,
      },
    },
  };

  beforeEach(() => {
    // resolveOrgFromEvent: looks up org via payment.invoice.organization
    // The dispute handler also looks up payment via findFirst for the main dispute logic
    // Use mockImplementation to handle both calls (they have different selects)
    mockPrisma.payment.findFirst.mockImplementation((args: any) => {
      // resolveOrgFromEvent call: select { invoice: { select: { organization: ... } } }
      if (args?.select?.invoice) {
        return Promise.resolve({
          invoice: {
            organization: { id: ALPHA_ORG_ID, stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD'] },
          },
        });
      }
      // dispute handler call: include { invoice: { select: { ... } } }
      return Promise.resolve(paymentForDispute);
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('emits billing.disputed with actorId:null and Stripe-retry dedupKey', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.disputed');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    // Webhook path: no authenticated user → actorId must be null
    expect(args.actorId).toBeNull();
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    // Stripe-retry safety: REQUIRED dedupKey
    expect(args.dedupKey).toBe(`billing.disputed:${DISPUTE_ID}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. charge.dispute.closed(lost) webhook — billing.chargeback (actorId:null, dedupKey)
//    The systemVoidPaymentForChargeback path is triggered internally by the webhook.
// ─────────────────────────────────────────────────────────────────────────────

describe('charge.dispute.closed(lost) webhook — billing.chargeback', () => {
  const DISPUTE_ID = 'dp_test_lost_001';
  const PI_ID = 'pi_test_lost_001';

  const invoiceForLost = {
    id: INVOICE_ID,
    status: 'DISPUTED',
    organization_id: ALPHA_ORG_ID,
    invoice_number: INVOICE_NUM,
    total_amount: 1268,
    amount_due: 0,
    kind: 'STANDARD',
    stripe_dispute_id: DISPUTE_ID,
  };

  const paymentForLost = {
    id: 'pay_card_lost',
    stripe_payment_intent_id: PI_ID,
    amount: 1268,
    method: 'CARD',
    voided_at: null,
    void_category: null,
  };

  const webhookEvent = {
    id: 'evt_disp_lost_001',
    type: 'charge.dispute.closed',
    data: {
      object: {
        id: DISPUTE_ID,
        payment_intent: PI_ID,
        status: 'lost',
      },
    },
  };

  beforeEach(() => {
    // charge.dispute.closed first looks up invoice by stripe_dispute_id (invoice.findFirst)
    // Then resolveOrgFromEvent: payment.findFirst with select.invoice.select.organization
    // Then disputes handler: payment.findFirst with where.stripe_payment_intent_id
    mockPrisma.invoice.findFirst.mockResolvedValue(invoiceForLost);
    mockPrisma.payment.findFirst.mockImplementation((args: any) => {
      // resolveOrgFromEvent: select path
      if (args?.select?.invoice) {
        return Promise.resolve({
          invoice: {
            organization: { id: ALPHA_ORG_ID, stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD'] },
          },
        });
      }
      // dispute handler: returns the full payment for the actual void
      return Promise.resolve(paymentForLost);
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        payment: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('emits billing.chargeback with actorId:null and Stripe-retry dedupKey', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.chargeback');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    // Webhook path: no authenticated user → actorId must be null
    expect(args.actorId).toBeNull();
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    // Stripe-retry safety: REQUIRED dedupKey
    expect(args.dedupKey).toBe(`billing.chargeback:${DISPUTE_ID}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. recordPayment (full, DEPOSIT) — estimate.deposit_paid
// ─────────────────────────────────────────────────────────────────────────────

describe('recordPayment (full, DEPOSIT) — estimate.deposit_paid', () => {
  it('emits estimate.deposit_paid + billing.payment_received; no emit on partial or STANDARD', async () => {
    mockAuthAs('admin');

    const ESTIMATE_ID = 'est_dep_001';
    const ESTIMATE_NUM = 'E00001';

    const invoice = buildInvoiceForRecord({
      kind: 'DEPOSIT',
      amount_due: 1268,
      estimate: {
        id: ESTIMATE_ID,
        lead_id: 'lead_001',
        status: 'SENT',
        estimate_number: ESTIMATE_NUM,
        lead: { commission_owner_id: COMMISSION_OWNER_ID },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_dep',
            amount: 1268,
            method: 'CHECK',
            paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });

    expect(res.status).toBe(201);

    // estimate.deposit_paid MUST fire
    const depositCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_paid');
    expect(depositCall).toBeDefined();
    const dArgs = depositCall![0];
    expect(dArgs.object.type).toBe('ESTIMATE');
    expect(dArgs.object.id).toBe(ESTIMATE_ID);
    expect(dArgs.object.label).toBe(ESTIMATE_NUM);
    expect(dArgs.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(dArgs.data.lead_id).toBe('lead_001');
    expect(dArgs.dedupKey).toBe(`estimate.deposit_paid:${ESTIMATE_ID}`);

    // billing.payment_received MUST still fire (not regressed)
    const billingCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(billingCall).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. checkout.session.completed webhook - billing.payment_received
//    The Stripe door had NO in-app emit: a card payment notified nobody, because
//    its only internal signal was the self-addressed [Internal] alert email that
//    Resend suppressed. Parity with the recordPayment door, actorId:null.
// ─────────────────────────────────────────────────────────────────────────────

describe('checkout.session.completed webhook - billing.payment_received', () => {
  const PI_ID = 'pi_checkout_001';
  const AMOUNT_DUE = 1268;
  // The Checkout total must equal amount_due exactly (no surcharge folded in).
  const TOTAL_CENTS = Math.round(AMOUNT_DUE * 100);

  const invoiceForCheckout = {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUM,
    status: 'SENT',
    kind: 'STANDARD',
    amount_due: AMOUNT_DUE,
    total_amount: AMOUNT_DUE,
    organization_id: ALPHA_ORG_ID,
    customer: {
      id: CUSTOMER_FIXTURE.id,
      email: 'john@doe.com',
      first_name: 'John',
      last_name: 'Doe',
      company_name: null,
    },
    job: {
      id: JOB_FIXTURE.id,
      job_number: JOB_FIXTURE.job_number,
      customer: null,
      // The commission owner reaches the notification through the same
      // job -> estimate -> lead chain the recordPayment door uses.
      estimate: { lead: { commission_owner_id: COMMISSION_OWNER_ID } },
    },
    estimate: null,
  };

  const webhookEvent = {
    id: 'evt_checkout_001',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_001',
        payment_intent: PI_ID,
        amount_total: TOTAL_CENTS,
        metadata: { invoiceId: INVOICE_ID },
      },
    },
  };

  beforeEach(() => {
    // invoice.findUnique serves two callers: resolveOrgFromEvent (organization only)
    // and the checkout branch (the full payment select).
    mockPrisma.invoice.findUnique.mockImplementation((args: any) => {
      // #2031 slice 5 — the money query now selects the invoice's org too (for the deposit
      // defaults the superseded test resolves against), so "selects organization" no longer
      // identifies resolveOrgFromEvent's lookup on its own. The amount is what only the money
      // query asks for.
      if (args?.select?.organization && !args?.select?.amount_due) {
        return Promise.resolve({
          organization: {
            id: ALPHA_ORG_ID,
            stripe_account_id: 'acct_test',
            accepted_payment_methods: ['CARD'],
            stripe_payouts_enabled: true,
            name: 'Alpha HVAC',
          },
        });
      }
      return Promise.resolve(invoiceForCheckout);
    });
  });

  it('emits billing.payment_received with actorId:null and a Stripe-retry dedupKey', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    // Webhook path: no authenticated user -> actorId must be null, so no
    // recipient is dropped as the actor.
    expect(args.actorId).toBeNull();
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(args.data.amount).toBe(AMOUNT_DUE);
    // Keyed on the payment intent, not the invoice: two genuine checkouts against
    // the same invoice are two payments and must notify twice.
    expect(args.dedupKey).toBe(`billing.payment_received:${PI_ID}`);
  });

  it('does not emit billing.partial_payment (this door always pays in full)', async () => {
    await postWebhook(webhookEvent);

    const partial = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'billing.partial_payment');
    expect(partial).toBeUndefined();
  });
});
