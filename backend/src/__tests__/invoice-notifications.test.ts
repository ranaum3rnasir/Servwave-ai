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
 *   - The billing alerts go out through M6's two-lane chain (S06.28): a route queues the alert and the webhook sends it, so the
 *     tests assert what is ASKED FOR (verb, object, actorId, key). Who it reaches is permission-billing-alerts-db.test.ts.
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
  withCheckoutLedger,
  servedBy,
  withLedgerReads,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { createRefund } from '../lib/stripe';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// The deposit paid estimate alert goes through M6's two-lane chain (S06.26): the route queues it for after its response, so a route
// test sees what was asked for; who is told is permission-lead-estimate-alerts-db.test.ts.
vi.mock('../services/notifications/leadEstimateAlerts', () => ({
  queueEstimateAlert: vi.fn(),
  alertEstimate: vi.fn().mockResolvedValue(undefined),
}));

// The billing alerts go through M6's two-lane chain (S06.28): the routes queue them for after the response and the payment webhook
// sends them itself, so a test here sees what was asked for; who is told is permission-billing-alerts-db.test.ts.
vi.mock('../services/notifications/invoiceBillingAlerts', async (original) => ({
  ...(await original<typeof import('../services/notifications/invoiceBillingAlerts')>()),
  queueInvoiceAlert: vi.fn(),
  alertInvoice: vi.fn().mockResolvedValue([]),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
import { queueEstimateAlert } from '../services/notifications/leadEstimateAlerts';
import { queueInvoiceAlert, alertInvoice } from '../services/notifications/invoiceBillingAlerts';

const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockQueuedInvoiceAlert = queueInvoiceAlert as ReturnType<typeof vi.fn>;
const mockSentInvoiceAlert = alertInvoice as ReturnType<typeof vi.fn>;
/** Every billing alert asked for, whether a route queued it or the webhook sent it. */
const billingAlerts = () => [...mockQueuedInvoiceAlert.mock.calls, ...mockSentInvoiceAlert.mock.calls];
const mockQueuedEstimateAlert = queueEstimateAlert as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

const mockCreateRefund = createRefund as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INVOICE_ID = INVOICE_SENT_FIXTURE.id;   // '00000000-0000-0000-0000-000000000902'
const INVOICE_NUM = INVOICE_SENT_FIXTURE.invoice_number; // 'I00002'

/** Sales user is the commission owner (simulating lead → estimate → job → invoice chain). */
const COMMISSION_OWNER_ID = TEST_USERS.sales.id;

/**
 * The Owner of the lead the job came from, a DIFFERENT user from the job's Sold By (S03.9): the
 * notification addressed to the seller reads the job's stored Sold By, so a test that still saw the
 * lead's Owner there would name the wrong person.
 */
const LEAD_OWNER_ID = TEST_USERS.dispatcher.id;

/**
 * The job's stored Sold By set, then cleared. The route no longer names a "seller" (S06.28): the alert's sender works out the job's
 * people itself, so what the route asks for is the same whoever sold the job.
 */
const SOLD_BY_CASES: Array<[string, string | null, string | null]> = [
  ['the job has a Sold By', COMMISSION_OWNER_ID, COMMISSION_OWNER_ID],
  ['the job has no Sold By', null, null],
];

/** The invoice as the door reads it, with the job's stored Sold By set to `soldById`. */
function withSoldBy<T extends { job?: any }>(invoice: T, soldById: string | null): T {
  return { ...invoice, job: { ...invoice.job, salesperson_id: soldById } };
}

/**
 * Invoice select returned by recordPayment / voidInvoice / refundInvoice / credit:
 * includes the job → estimate → lead chain (the alert sender works out the people from it).
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
      salesperson_id: COMMISSION_OWNER_ID,
      estimate: {
        lead: {
          lead_assignees: [{ user_id: LEAD_OWNER_ID }],
          commission_owner_id: LEAD_OWNER_ID,
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
      salesperson_id: COMMISSION_OWNER_ID,
      estimate: {
        lead: {
          commission_owner_id: LEAD_OWNER_ID,
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
      salesperson_id: COMMISSION_OWNER_ID,
      estimate: {
        lead: {
          commission_owner_id: LEAD_OWNER_ID,
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


  // canAccessRow uses invoice.count with tenant scope.
  mockPrisma.invoice.count.mockResolvedValue(1);
  mockPrisma.invoice.findFirst.mockResolvedValue(null);

  // Stripe webhook dedup.
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});

  mockPrisma.timelineEvent.create.mockResolvedValue({});

  // Safe default $transaction passthrough (with the card-checkout reconciler's reads, slice 08).
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withCheckoutLedger({
      $executeRaw: vi.fn().mockResolvedValue(1), // #891: the checkout locks the invoice row
      invoice: { findUnique: vi.fn().mockResolvedValue({ status: 'SENT' }), update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
      // Inventory P1 (§4.4): voidInvoice's auto-return pass — no SYNCED lines in these flows.
      invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      payment: { create: vi.fn().mockResolvedValue({ id: 'pay_new' }), update: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      stripeEvent: { create: vi.fn().mockResolvedValue({}) },
      refund: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 're_1' }) },
      credit: { create: vi.fn().mockResolvedValue({ id: 'cr_1' }) },
      depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      job: { update: vi.fn().mockResolvedValue({}) },
    }, await servedBy(mockPrisma.invoice.findUnique))),
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
  it.each(SOLD_BY_CASES)('asks for billing.payment_received with the staff actorId, and names no seller, when %s', async (_label, soldById) => {
    mockAuthAs('admin');

    const invoice = withSoldBy(buildInvoiceForRecord({
      // Full payment: amount_due = 1268
      amount_due: 1268,
    }), soldById);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(withLedgerReads({
        $executeRaw: vi.fn().mockResolvedValue(1), // recordPayment locks the invoice row
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
      })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });

    expect(res.status).toBe(201);

    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the job's people
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. recordPayment — billing.partial_payment (partial)
// ─────────────────────────────────────────────────────────────────────────────

describe('recordPayment (partial) — billing.partial_payment', () => {
  it.each(SOLD_BY_CASES)('asks for billing.partial_payment (not billing.payment_received) when balance remains and %s', async (_label, soldById) => {
    mockAuthAs('admin');

    const invoice = withSoldBy(buildInvoiceForRecord({ amount_due: 1268 }), soldById);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    // Partial payment: only pay 500 of 1268, leaving a balance
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(withLedgerReads({
        $executeRaw: vi.fn().mockResolvedValue(1), // recordPayment locks the invoice row
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
      })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 500, method: 'CHECK' });

    expect(res.status).toBe(201);

    // billing.partial_payment must be emitted (isFullyPaid = false)
    const partialCall = billingAlerts().find((c: any[]) => c[0].verb === 'billing.partial_payment');
    expect(partialCall).toBeDefined();
    const args = partialCall![0];
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the job's people

    // billing.payment_received must NOT be emitted (partial, not full)
    const fullCall = billingAlerts().find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(fullCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. refundInvoice — billing.refunded
// ─────────────────────────────────────────────────────────────────────────────

describe('refundInvoice — billing.refunded', () => {
  it.each(SOLD_BY_CASES)('asks for billing.refunded with the staff actorId, and names no seller, when %s', async (_label, soldById) => {
    mockAuthAs('admin');

    mockPrisma.invoice.findUnique.mockResolvedValue(withSoldBy(buildPaidInvoice(), soldById));
    mockCreateRefund.mockResolvedValue({ id: 're_stripe_1' });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1), // slice 05: the refund door locks the invoice
        // Slice 08: the payment's refund stamp is re-derived from its refund rows.
        // Slice 29: the refund row is held (PENDING) under the lock, then completed.
        refund: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 're_1' }),
          findFirstOrThrow: vi.fn().mockResolvedValue({ id: 're_1', stripe_refund_id: null }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 're_1' }),
          update: vi.fn().mockResolvedValue({ id: 're_1' }),
        },
        // The caps are re-read under the lock: the invoice as it stands.
        invoice: {
          update: vi.fn().mockResolvedValue({}),
          findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ status: 'PAID', payments: buildPaidInvoice().payments, refunds: [] })),
          // The totals and status re-derived from the ledger rows (rederiveRefundTotals).
          findFirstOrThrow: vi.fn().mockImplementation(async () => ({ status: 'PAID', amount_due: 0, payments: [], refunds: [] })),
        },
        payment: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/refund`)
      .set(authHeader('admin'))
      .send({ amount: 500, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer changed mind' });

    expect(res.status).toBe(200);

    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.refunded');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the job's people
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. voidInvoice — billing.voided
// ─────────────────────────────────────────────────────────────────────────────

describe('voidInvoice — billing.voided', () => {
  it.each(SOLD_BY_CASES)('asks for billing.voided with the staff actorId, and names no seller, when %s', async (_label, soldById) => {
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
        salesperson_id: soldById,
        estimate: {
          lead: {
            lead_assignees: [{ user_id: LEAD_OWNER_ID }],
            commission_owner_id: LEAD_OWNER_ID,
          },
        },
      },
    };
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1), // slice 05: the void locks the invoice and re-checks it
        invoice: {
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'SENT' }),
        },
        // Inventory P1 (§4.4): void's auto-return pass — no SYNCED lines here.
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        job: { update: vi.fn().mockResolvedValue({}) },
        depositCreditApplication: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        payment: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);

    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.voided');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the job's people
    // voided: no dedupKey
    expect(args.dedupKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. credit — billing.credit_applied
// ─────────────────────────────────────────────────────────────────────────────

describe('credit — billing.credit_applied', () => {
  it.each(SOLD_BY_CASES)('asks for billing.credit_applied with the staff actorId, and names no seller, when %s', async (_label, soldById) => {
    mockAuthAs('admin');

    mockPrisma.invoice.findUnique.mockResolvedValue(withSoldBy(buildCreditInvoice(), soldById));

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1), // slice 07: the give-back locks the invoice
        credit: { create: vi.fn().mockResolvedValue({ id: 'cr_1' }) },
        refund: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 're_1' }) },
        invoice: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({ id: INVOICE_ID }),
          // Slice 18: the credit re-reads the invoice under its lock - unchanged since the pre-read.
          findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'SENT', amount_due: 1268, payments: [], refunds: [] }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/credit`)
      .set(authHeader('admin'))
      .send({ amount: 200, reason: 'Goodwill discount' });

    expect(res.status).toBe(200);

    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.credit_applied');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the job's people
    // no dedupKey for credit
    expect(args.dedupKey).toBeUndefined();
  });
});

// Sections 6-7 (charge.dispute.created -> billing.disputed, charge.dispute.closed(lost) ->
// billing.chargeback) moved with the dispute path into the payment event reconciler (payments
// go-live slice 09). disputes-reconciler-db.test.ts proves both against a real database: null
// actor, one alert per dispute id however often the event is delivered.


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
      fn(withLedgerReads({
        $executeRaw: vi.fn().mockResolvedValue(1), // recordPayment locks the invoice row
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
      })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });

    expect(res.status).toBe(201);

    // estimate.deposit_paid MUST fire
    const depositCall = mockQueuedEstimateAlert.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_paid');
    expect(depositCall).toBeDefined();
    const dArgs = depositCall![0];
    expect(dArgs.estimateId).toBe(ESTIMATE_ID);
    expect(dArgs.organizationId).toBe(ALPHA_ORG_ID);
    expect(dArgs.actorId).toBe(TEST_USERS.admin.id);
    expect(dArgs.data.lead_id).toBe('lead_001');
    expect(dArgs.dedupKey).toBe(`estimate.deposit_paid:${ESTIMATE_ID}`);
    // ...and it is the chain's job to send it: the route itself writes no estimate alert.
    expect(mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_paid')).toBeUndefined();

    // billing.payment_received MUST still fire (not regressed)
    const billingCall = billingAlerts().find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(billingCall).toBeDefined();
  });
});

describe('recordPayment (full, DEPOSIT with no job yet) - billing.payment_received', () => {
  it('asks for the alert on the deposit invoice itself: the sender works out its estimate\'s lead and that lead\'s Owner', async () => {
    mockAuthAs('admin');

    const invoice = buildInvoiceForRecord({
      kind: 'DEPOSIT',
      amount_due: 1268,
      job: null,
      estimate: {
        id: 'est_dep_002',
        lead_id: 'lead_002',
        status: 'SENT',
        estimate_number: 'E00002',
        lead: { commission_owner_id: LEAD_OWNER_ID },
      },
    });
    mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(withLedgerReads({
        $executeRaw: vi.fn().mockResolvedValue(1),
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_ID, invoice_number: INVOICE_NUM }),
        },
        payment: {
          create: vi.fn().mockResolvedValue({
            id: 'pay_dep2',
            amount: 1268,
            method: 'CHECK',
            paid_at: new Date(),
            collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      })),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 1268, method: 'CHECK' });

    expect(res.status).toBe(201);
    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(call![0].object).toMatchObject({ type: 'INVOICE', id: INVOICE_ID });
    expect(call![0]).not.toHaveProperty('entity');
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
      // The seller reaches the notification through the job's stored Sold By, the same field the
      // recordPayment door reads; the lead's Owner is somebody else.
      salesperson_id: COMMISSION_OWNER_ID,
      estimate: { lead: { commission_owner_id: LEAD_OWNER_ID } },
    },
    estimate: null,
  };
  let servedInvoice: typeof invoiceForCheckout = invoiceForCheckout;

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
    servedInvoice = invoiceForCheckout;
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
      return Promise.resolve(servedInvoice);
    });
  });

  it('emits billing.payment_received with actorId:null and a Stripe-retry dedupKey', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = billingAlerts().find((c: any[]) => c[0].verb === 'billing.payment_received');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    // Webhook path: no authenticated user -> actorId must be null, so no
    // recipient is dropped as the actor.
    expect(args.actorId).toBeNull();
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(INVOICE_ID);
    expect(args.object.label).toBe(INVOICE_NUM);
    expect(args).not.toHaveProperty('entity'); // no seller named: the sender reads the invoice's job or lead
    // Slice 33b: a string, the form the template reads (a number printed no amount).
    expect(args.data.amount).toBe(AMOUNT_DUE.toFixed(2));
    // Keyed on the payment intent, not the invoice: two genuine checkouts against
    // the same invoice are two payments and must notify twice.
    expect(args.dedupKey).toBe(`billing.payment_received:${PI_ID}`);
  });

  it('does not emit billing.partial_payment (this door always pays in full)', async () => {
    await postWebhook(webhookEvent);

    const partial = billingAlerts().find((c: any[]) => c[0].verb === 'billing.partial_payment');
    expect(partial).toBeUndefined();
  });
});
