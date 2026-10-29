/**
 * Creator tracking on Lead, Invoice, Customer, Payment and Attachment (audit only) - spec Part A, PR 4.
 *
 * PR 1 did the same for Job. These tests pin the three columns that make "who created this"
 * answerable: created_by_id (the acting user, or null), created_by_name (a snapshot that survives a
 * permanent user delete, since the FK is ON DELETE SET NULL) and created_by_source.
 *
 * NOTHING reads these for authorization. What is under test is only that every production creation
 * path stamps the truth, and that a client cannot dictate it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  LEAD_FIXTURE,
  INVOICE_SENT_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { applyDepositCreditsWithPayments } from '../lib/deposit-credit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

/** The `data` object handed to each model's create inside the request's transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const captured: Record<string, Record<string, any> | null> = {};

const DISPATCHER_STAMP = {
  created_by_id: TEST_USERS.dispatcher.id,
  created_by_name: 'Test Dispatcher',
  created_by_source: 'USER',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  for (const k of Object.keys(captured)) delete captured[k];
});

/** A tx model stub that records the `data` it was handed under `captured[key]`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capture(key: string, result: unknown) {
  return vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
    captured[key] = args.data;
    return Promise.resolve(result);
  });
}

describe('POST /api/leads - the acting user is recorded as the lead creator', () => {
  it('stamps source USER, the acting user id and their name on the existing-customer path', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        visit: { create: vi.fn().mockResolvedValue({ id: 'wt-1' }) },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: capture('lead', LEAD_FIXTURE) },
        serviceLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'primary-loc-id' }) },
      }),
    );

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'AC not cooling' });

    expect(res.status).toBe(201);
    expect(captured.lead).toMatchObject(DISPATCHER_STAMP);
  });

  it('stamps BOTH the lead and the inline new customer on the new-customer path', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        visit: { create: vi.fn().mockResolvedValue({ id: 'wt-1' }) },
        customer: {
          create: capture('customer', {
            id: CUSTOMER_FIXTURE.id,
            service_locations: [{ id: 'new-primary-loc-id' }],
          }),
        },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: capture('lead', LEAD_FIXTURE) },
      }),
    );

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('dispatcher'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(captured.lead).toMatchObject(DISPATCHER_STAMP);
    expect(captured.customer).toMatchObject(DISPATCHER_STAMP);
  });
});

describe('POST /api/customers - the acting user is recorded as the customer creator', () => {
  const VALID_BODY = { first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.example', phone: '5559876543' };

  function wireCustomerTx() {
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ customer: { create: capture('customer', { id: CUSTOMER_FIXTURE.id, service_locations: [] }) } }),
    );
  }

  it('stamps source USER, the acting user id and their name', async () => {
    mockAuthAs('dispatcher');
    wireCustomerTx();

    const res = await request(app).post('/api/customers').set(authHeader('dispatcher')).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(captured.customer).toMatchObject(DISPATCHER_STAMP);
  });

  it('ignores creator fields supplied in the request body (immutable, unspoofable)', async () => {
    // This path is the sharpest test of immutability in the whole slice: the controller spreads the
    // parsed body wholesale (`...rest` through withRequiredCustomerFields). It is safe only because
    // the zod create schema does not declare these keys, so validate() strips them before the
    // controller ever sees them. If someone adds them to the schema, this test goes red.
    mockAuthAs('dispatcher');
    wireCustomerTx();

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('dispatcher'))
      .send({
        ...VALID_BODY,
        created_by_id: TEST_USERS.admin.id,
        created_by_name: 'Somebody Else',
        created_by_source: 'SYSTEM',
      });

    expect(res.status).toBe(201);
    expect(captured.customer).toMatchObject(DISPATCHER_STAMP);
  });
});

describe('POST /api/jobs with an inline new customer - the customer is stamped too', () => {
  it('stamps the acting user on the customer the job-create path mints', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      if (typeof fn !== 'function') return Promise.all(fn as unknown as Promise<unknown>[]);
      return fn({
        customer: {
          create: capture('customer', {
            id: CUSTOMER_FIXTURE.id,
            service_locations: [{ id: 'new-primary-loc-id' }],
          }),
        },
        job: { create: capture('job', { id: 'j-1', job_number: 'J00001', assignees: [] }) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        jobAssignee: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({
        new_customer: {
          first_name: 'New',
          last_name: 'Client',
          phone: '5551112222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
      });

    expect(res.status).toBe(201);
    expect(captured.customer).toMatchObject(DISPATCHER_STAMP);
  });
});

describe('POST /api/attachments/:entityType/:entityId - the uploader is recorded as the creator', () => {
  // A real PNG header - the controller sniffs magic bytes and rejects anything whose content
  // disagrees with the declared type, so a dummy text buffer would 400 before reaching the create.
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);

  it('stamps source USER, the acting user id and their name alongside uploaded_by', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
    mockPrisma.attachment.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      captured.attachment = args.data;
      return Promise.resolve({ id: 'att-1', file_name: 'photo.png' });
    });

    const res = await request(app)
      .post(`/api/attachments/CUSTOMER/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('dispatcher'))
      .field('display_name', 'Site photo')
      .field('description', '')
      .attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(captured.attachment).toMatchObject(DISPATCHER_STAMP);
    // uploaded_by is the pre-existing actor column and keeps its meaning - the new columns sit
    // beside it rather than replacing it.
    expect(captured.attachment).toMatchObject({ uploaded_by: TEST_USERS.dispatcher.id });
  });
});

// ─── Payment: the source column earns its keep here ──────────────────────────
// Three doors write payments and only one has an acting user. A bare nullable FK could not tell
// the other two apart; created_by_source can.

describe('POST /api/invoices/:id/payments - a payment collected by staff', () => {
  it('stamps source USER and the collecting user, matching collected_by', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.count.mockResolvedValue(1);
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_SENT_FIXTURE.id,
      invoice_number: INVOICE_SENT_FIXTURE.invoice_number,
      status: 'SENT',
      amount_due: 1268,
      total_amount: 2268,
      job: {
        id: 'j0000000-0000-0000-0000-0000000000a1',
        assignees: [],
        customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', email: 'john@doe.example' },
        estimate: { lead: { lead_assignees: [] } },
      },
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1268, status: 'SENT' }),
          update: vi.fn().mockResolvedValue({ id: INVOICE_SENT_FIXTURE.id, status: 'PARTIAL' }),
        },
        payment: { create: capture('payment', { id: 'pay-1', collector: null }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_SENT_FIXTURE.id}/payments`)
      .set(authHeader('dispatcher'))
      .send({ amount: 500, method: 'CHECK', reference_number: 'CHK-1234' });

    expect(res.status).toBe(201);
    expect(captured.payment).toMatchObject(DISPATCHER_STAMP);
    // The two columns agree on this door - staff collected the money and staff caused the row.
    expect(captured.payment).toMatchObject({ collected_by: TEST_USERS.dispatcher.id });
  });
});

describe('Stripe checkout.session.completed - the customer paid themselves', () => {
  it('stamps source CLIENT with a null creator id, and invents no collecting user', async () => {
    const INVOICE_ID = INVOICE_SENT_FIXTURE.id;
    mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
    mockPrisma.invoice.findUnique.mockImplementation((args: { select?: Record<string, unknown> }) => {
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
      return Promise.resolve({
        id: INVOICE_ID,
        invoice_number: 'I00001',
        status: 'SENT',
        kind: 'STANDARD',
        amount_due: 1268,
        total_amount: 1268,
        organization_id: ALPHA_ORG_ID,
        customer: { id: CUSTOMER_FIXTURE.id, email: 'john@doe.example', first_name: 'John', last_name: 'Doe', company_name: null },
        job: { id: 'j0000000-0000-0000-0000-0000000000a1', job_number: 'J00001', customer: null, estimate: { lead: { commission_owner_id: null } } },
        estimate: null,
      });
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: capture('payment', { id: 'pay-webhook-1' }) },
        invoice: { update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig')
      .send(
        Buffer.from(
          JSON.stringify({
            id: 'evt_creator_001',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_creator_001',
                payment_intent: 'pi_creator_001',
                amount_total: 126800,
                metadata: { invoiceId: INVOICE_ID },
              },
            },
          }),
        ),
      );

    expect(res.status).toBe(200);
    expect(captured.payment).toMatchObject({
      created_by_id: null,
      created_by_name: null,
      created_by_source: 'CLIENT',
      collected_by: null,
    });
  });
});

describe('deposit-credit drawdown - a ledger payment nobody collected', () => {
  it('stamps source SYSTEM with a null creator id', async () => {
    // Not a real payment: applyDepositCreditsWithPayments mints a synthetic post-tax Payment row so
    // an already-paid deposit shows on the target invoice. No user chose it and no customer paid it,
    // so it is neither USER nor CLIENT.
    const paymentCreate = vi.fn().mockResolvedValue({ id: 'pay-credit-1' });
    const tx = {
      payment: {
        create: paymentCreate,
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 500 } }),
      },
      depositCreditApplication: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        create: vi.fn().mockResolvedValue({}),
      },
      refund: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    };

    await applyDepositCreditsWithPayments(
      tx as never,
      [{ id: 'dep-inv-1' }],
      'target-inv-1',
      1000,
      ALPHA_ORG_ID,
    );

    expect(paymentCreate).toHaveBeenCalledTimes(1);
    expect(paymentCreate.mock.calls[0][0].data).toMatchObject({
      created_by_id: null,
      created_by_name: null,
      created_by_source: 'SYSTEM',
      collected_by: null,
    });
  });
});

describe('POST /api/invoices - the acting user is recorded as the invoice creator', () => {
  it('stamps source USER, the acting user id and their name on the job-anchored door', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue({
      id: 'j0000000-0000-0000-0000-0000000000a1',
      job_number: 'J00001',
      status: 'COMPLETED',
      assignees: [],
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      customer: { id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false },
      service_location: { state: 'TX' },
      tax_rate: 0,
      discount_amount: 0,
      estimate: null,
      linked_estimates: [],
      job_line_items: [
        {
          id: 'jli00000-0000-0000-0000-000000000001',
          sequence: 1,
          description: 'Labor',
          quantity: 1,
          unit_price: 500,
          is_taxable: false,
          line_total: 500,
          item_type: 'SERVICE',
          price_book_item_id: null,
          unit_cost: null,
          markup_percent: null,
        },
      ],
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        job: { update: vi.fn().mockResolvedValue({}) },
        invoice: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
          create: capture('invoice', { id: 'inv-1', invoice_number: 'I00001', line_items: [] }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('dispatcher'))
      .send({ job_id: 'j0000000-0000-0000-0000-0000000000a1' });

    expect(res.status).toBe(201);
    expect(captured.invoice).toMatchObject(DISPATCHER_STAMP);
  });
});

describe('POST /api/service-plans/:id/activate - a plan-billing invoice is SYSTEM', () => {
  it('stamps source SYSTEM with a null creator id, not the activating user', async () => {
    // Consistent with PR 1's plan visit job: the invoice is materialised by the plan's own billing
    // schedule, not authored by whoever happened to press Activate. The same code will run from a
    // scheduler where there is no user at all.
    mockAuthAs('admin');
    const PLAN = {
      id: 'sp000000-0000-0000-0000-000000000001',
      service_plan_number: 'SP00001',
      organization_id: ALPHA_ORG_ID,
      name: 'Annual monitoring',
      status: 'DRAFT',
      visit_cadence: 'MONTHLY',
      customer_id: CUSTOMER_FIXTURE.id,
      start_date: new Date('2026-01-01T00:00:00.000Z'),
      end_date: new Date('2026-12-31T00:00:00.000Z'),
      contract_price: '1200.00',
      renewals_count: 0,
      line_items: [{ name: 'Annual visit', quantity: 1, unit_price: 1200, position: 0 }],
      material_lines: [],
      visits: [],
      customer: { id: CUSTOMER_FIXTURE.id, tax_exempt: true, company_name: null, first_name: 'John', last_name: 'Doe' },
      service_location: { id: LOCATION_FIXTURE.id, state: 'TX', address_line1: '1 Main St', city: 'Austin' },
    };
    mockPrisma.servicePlan.findFirst.mockResolvedValue(PLAN);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { create: capture('invoice', { id: 'inv-plan-1', invoice_number: 'I00001' }) },
        servicePlan: { update: vi.fn().mockResolvedValue({ ...PLAN, status: 'ACTIVE' }) },
      }),
    );

    const res = await request(app)
      .post('/api/service-plans/sp000000-0000-0000-0000-000000000001/activate')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(captured.invoice).toMatchObject({
      created_by_id: null,
      created_by_name: null,
      created_by_source: 'SYSTEM',
    });
  });
});

describe('the creator-tracking migration for the remaining five tables', () => {
  const TABLES = ['leads', 'invoices', 'customers', 'payments', 'attachments'] as const;
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260805140000_creator_tracking_remaining/migration.sql'),
    'utf8',
  );

  it.each(TABLES)('leaves every existing %s row reading back UNKNOWN', (table) => {
    // The only thing that can answer for pre-migration rows is the column default, so it must be
    // NOT NULL DEFAULT 'UNKNOWN' - a nullable or undefaulted column would read back null instead.
    expect(sql).toContain(
      `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN'`,
    );
  });

  it.each(TABLES)('adds the id and name columns on %s idempotently', (table) => {
    expect(sql).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "created_by_id" UUID`);
    expect(sql).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT`);
  });

  it.each(TABLES)(
    'links %s to its creator with ON DELETE SET NULL, guarded, so a permanent user delete cannot fail or cascade',
    (table) => {
      expect(sql).toContain(
        `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_created_by_id_fkey')`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_created_by_id_fkey"\n      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      );
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "${table}_created_by_id_idx" ON "${table}"("created_by_id")`);
    },
  );

  it('never uses RESTRICT - that would block permanent deletion of anyone who ever made one of these rows', () => {
    expect(sql).not.toMatch(/REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/REFERENCES "users"\("id"\) ON DELETE CASCADE/);
  });

  it('re-declares the CreatedBySource enum idempotently rather than assuming PR 1 already ran', () => {
    // PR 1's migration creates this enum. This one must still apply to a database that has never
    // seen PR 1, and must be a no-op on one that has.
    expect(sql).toContain(
      `CREATE TYPE "CreatedBySource" AS ENUM ('USER', 'CLIENT', 'SYSTEM', 'IMPORT', 'UNKNOWN')`,
    );
    expect(sql).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
  });

  it('is portable to vanilla Postgres - no Supabase-only roles or auth schema', () => {
    expect(sql).not.toMatch(/\bauth\./);
    expect(sql).not.toMatch(/TO (authenticated|anon|service_role)\b/);
  });
});
