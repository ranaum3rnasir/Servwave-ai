/**
 * Roles & Permissions Overhaul, PRD 6 / S06.7 - notes added and money movements on the job's own
 * timeline.
 *
 * Adding a job note writes one history entry naming who added it. A payment, an applied deposit, a
 * refund and a payment void on one of the job's invoices each write a JOB timeline entry (entity_type
 * 'JOB') with the amount and method. A standalone invoice writes no job entry.
 *
 * Harness: supertest against `app`, prisma mocked by setup.ts. The timeline table is replaced by an
 * in-memory feed so the history is read back through GET /api/jobs/:id/timeline, the door the job's
 * Activity panel uses, rather than by peeking at what a controller handed prisma.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, INVOICE_FIXTURE, CUSTOMER_FIXTURE, LOCATION_FIXTURE, ESTIMATE_APPROVED_FIXTURE, withLedgerReads, mockRoleSwitches } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = JOB_FIXTURE.id;
const INVOICE_ID = INVOICE_FIXTURE.id;
const INVOICE_NUMBER = INVOICE_FIXTURE.invoice_number;

// ─── The job's timeline, in memory ─────────────────────

let feed: any[] = [];

function useInMemoryTimeline() {
  feed = [];
  mockPrisma.timelineEvent.create.mockImplementation(({ data }: { data: any }) => {
    const row = {
      id: `ev-${feed.length + 1}`,
      created_at: new Date(Date.UTC(2026, 9, 8, 12, 0, feed.length)),
      creator: { id: data.created_by, first_name: 'Test', last_name: 'Person' },
      ...data,
    };
    feed.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.timelineEvent.findMany.mockImplementation(({ where }: { where: any }) =>
    Promise.resolve(
      feed.filter(
        (e) =>
          e.organization_id === where.organization_id &&
          where.OR.some((c: any) =>
            c.entity_type === e.entity_type &&
            (typeof c.entity_id === 'string' ? c.entity_id === e.entity_id : c.entity_id.in.includes(e.entity_id)),
          ),
      ),
    ),
  );
}

/** Reads the job's activity the way the Activity panel does. */
async function readHistory(as: 'admin' | 'technician' = 'admin') {
  const res = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader(as));
  expect(res.status).toBe(200);
  return res.body.events as any[];
}

const ofType = (events: any[], type: string) => events.filter((e) => e.event_type === type);

/** Entries written ON THE JOB itself (not the invoice's own timeline). */
const jobEntries = () => feed.filter((e) => e.entity_type === 'JOB');

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  useInMemoryTimeline();
  mockAuthAs('admin');
  mockPrisma.$transaction.mockImplementation(async (fn: Function) =>
    fn({
      note: { create: mockPrisma.note.create },
      timelineEvent: { create: mockPrisma.timelineEvent.create },
    } as any),
  );
  mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.invoice.findMany.mockResolvedValue([{ id: INVOICE_ID }]);
});

// ════════════════════════════════════════════════════════════════════════════
// Notes
// ════════════════════════════════════════════════════════════════════════════
describe('job notes on the job history', () => {
  const NOTE_ID = 'bb000000-0000-0000-0000-000000000001';

  function noteCreated() {
    mockPrisma.note.create.mockResolvedValue({
      id: NOTE_ID,
      content: 'Customer wants the unit by Friday',
      created_at: new Date('2026-10-08T12:00:00Z'),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
  }

  it('adding a job note writes ONE history entry naming who added it', async () => {
    noteCreated();

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'Customer wants the unit by Friday' });
    expect(res.status).toBe(201);

    const added = ofType(await readHistory(), 'JOB_NOTE_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0].creator.id).toBe(TEST_USERS.admin.id);
    expect(added[0].metadata.note_id).toBe(NOTE_ID);
    // It is an entry on the JOB itself.
    expect(jobEntries().map((e) => e.entity_id)).toEqual([JOB_ID]);
  });

  it('a note that is refused writes no history entry', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ add_notes: false });
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'Not allowed' });
    expect(res.status).toBe(403);
    expect(feed).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Money movements on the job's invoices
// ════════════════════════════════════════════════════════════════════════════
const PAYMENT_ID = 'cc000000-0000-0000-0000-000000000001';

/** The money entries a reader sees on the job, whatever their type. */
const MONEY_TYPES = ['JOB_PAYMENT_RECORDED', 'JOB_DEPOSIT_APPLIED', 'JOB_REFUND_ISSUED', 'JOB_PAYMENT_VOIDED'];
const moneyEntries = (events: any[]) => events.filter((e) => MONEY_TYPES.includes(e.event_type));

/** What the invoice doors read before they open their transaction. */
function jobInvoice(over: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUMBER,
    organization_id: ALPHA_ORG_ID,
    status: 'SENT',
    kind: 'STANDARD',
    job_id: JOB_ID,
    amount_due: 1000,
    total_amount: 1000,
    tax_amount: 0,
    net_collected: 0,
    customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: null, email: null },
    organization: { id: ALPHA_ORG_ID, stripe_account_id: null },
    payments: [],
    refunds: [],
    estimate: null,
    job: {
      id: JOB_ID,
      job_number: JOB_FIXTURE.job_number,
      assignees: [{ user_id: TEST_USERS.technician.id }],
      visits: [],
      customer: null,
      estimate: { lead: { lead_assignees: [], commission_owner_id: null } },
    },
    ...over,
  };
}

/** A transaction client whose timeline is the in-memory feed and whose ledger reads are caller-set. */
function useTransaction(extra: Record<string, any> = {}) {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) =>
    fn(withLedgerReads({
      $executeRaw: vi.fn().mockResolvedValue(1),
      note: { create: mockPrisma.note.create },
      timelineEvent: { create: mockPrisma.timelineEvent.create },
      ...extra,
    }) as any),
  );
}

describe('payment recorded on the job', () => {
  function recordPaymentTx(amountDue = 1000) {
    useTransaction({
      payment: {
        create: vi.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: PAYMENT_ID, ...data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } })),
      },
      invoice: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: amountDue, status: 'SENT' }),
        update: vi.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: INVOICE_ID, invoice_number: INVOICE_NUMBER, line_items: [], refunds: [], credits: [], payments: [], customer: null, job: null, ...data })),
      },
    });
  }

  it('recording a payment writes ONE job entry with the amount, the method and the invoice', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(jobInvoice());
    recordPaymentTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 400, method: 'CHECK', reference_number: 'CHK-9' });
    expect(res.status).toBe(201);

    const recorded = ofType(await readHistory(), 'JOB_PAYMENT_RECORDED');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].metadata).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: INVOICE_NUMBER,
      payment_id: PAYMENT_ID,
      amount: 400,
      method: 'CHECK',
    });
    expect(recorded[0].creator.id).toBe(TEST_USERS.admin.id);
    expect(jobEntries().map((e) => e.entity_id)).toEqual([JOB_ID]);
  });

  it('a payment on a standalone invoice writes no job entry', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(jobInvoice({ job_id: null, job: null }));
    recordPaymentTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 400, method: 'CASH' });
    expect(res.status).toBe(201);

    expect(jobEntries()).toEqual([]);
    // The invoice's own record of it is untouched.
    expect(feed.some((e) => e.entity_type === 'INVOICE' && e.event_type === 'PAYMENT_RECEIVED')).toBe(true);
  });
});

describe('payment voided on the job', () => {
  const VOID_PAYMENT = {
    id: PAYMENT_ID, invoice_id: INVOICE_ID, amount: 400, method: 'CHECK',
    stripe_payment_intent_id: null, voided_at: null, state: 'SUCCEEDED',
  };

  function voidTx() {
    useTransaction({
      payment: {
        update: vi.fn().mockResolvedValue({}),
        findUniqueOrThrow: vi.fn().mockResolvedValue(VOID_PAYMENT),
      },
      invoice: {
        update: vi.fn().mockResolvedValue({}),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'PAID', amount_due: 0, total_amount: 400 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      depositCreditApplication: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    });
  }

  it('voiding a payment writes ONE job entry with the amount, the method and the invoice', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(jobInvoice({ status: 'PAID', amount_due: 0, total_amount: 400 }));
    mockPrisma.payment.findFirst.mockResolvedValue(VOID_PAYMENT);
    voidTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/void-payment`)
      .set(authHeader('admin'))
      .send({ payment_id: PAYMENT_ID, void_category: 'BOUNCED', reason: 'check bounced' });
    expect(res.status).toBe(200);

    const voided = ofType(await readHistory(), 'JOB_PAYMENT_VOIDED');
    expect(voided).toHaveLength(1);
    expect(voided[0].metadata).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: INVOICE_NUMBER,
      payment_id: PAYMENT_ID,
      amount: 400,
      method: 'CHECK',
    });
    expect(voided[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('a void on a standalone invoice writes no job entry', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(jobInvoice({ status: 'PAID', amount_due: 0, total_amount: 400, job_id: null, job: null }));
    mockPrisma.payment.findFirst.mockResolvedValue(VOID_PAYMENT);
    voidTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/void-payment`)
      .set(authHeader('admin'))
      .send({ payment_id: PAYMENT_ID, void_category: 'ERROR', reason: 'typo' });
    expect(res.status).toBe(200);
    expect(jobEntries()).toEqual([]);
  });
});

describe('refund issued on the job', () => {
  const CASH_PAYMENT = {
    id: PAYMENT_ID, amount: 500, method: 'CASH', stripe_payment_intent_id: null,
    refunded_at: null, reference_number: null, voided_at: null, state: 'SUCCEEDED',
  };

  /** A paid invoice with one cash payment; the refund doors write the Refund row then re-read the ledger. */
  function refundTx() {
    let created: any = null;
    useTransaction({
      refund: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => created),
        findMany: vi.fn().mockImplementation(async () => (created ? [{ ...created, created_at: new Date() }] : [])),
        create: vi.fn().mockImplementation(({ data }: any) => { created = { id: 'dd000000-0000-0000-0000-000000000001', ...data }; return Promise.resolve(created); }),
      },
      invoice: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => ({
          status: 'PAID',
          amount_due: 0,
          payments: [CASH_PAYMENT],
          refunds: created ? [{ amount: created.amount, state: created.state ?? 'SUCCEEDED', payment_id: created.payment_id ?? null }] : [],
        })),
      },
      payment: { update: vi.fn().mockResolvedValue({}) },
    });
  }

  const paidJobInvoice = (over: Record<string, any> = {}) =>
    jobInvoice({ status: 'PAID', amount_due: 0, total_amount: 500, net_collected: 500, payments: [CASH_PAYMENT], ...over });

  it('a refund writes ONE job entry with the amount, the method and the invoice', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(paidJobInvoice());
    refundTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/refund`)
      .set(authHeader('admin'))
      .send({ amount: 200, reason_category: 'CUSTOMER_REQUEST', reason: 'part of the work was not done' });
    expect(res.status).toBe(200);

    const refunded = ofType(await readHistory(), 'JOB_REFUND_ISSUED');
    expect(refunded).toHaveLength(1);
    expect(refunded[0].metadata).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: INVOICE_NUMBER,
      refund_id: 'dd000000-0000-0000-0000-000000000001',
      amount: 200,
      method: 'CASH',
    });
    expect(refunded[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('a cash give-back through the credit door writes ONE job entry too', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(paidJobInvoice());
    refundTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/credit`)
      .set(authHeader('admin'))
      .send({ amount: 150, reason: 'overpaid', refund_instead: true });
    expect(res.status).toBe(200);

    const refunded = ofType(await readHistory(), 'JOB_REFUND_ISSUED');
    expect(refunded).toHaveLength(1);
    expect(refunded[0].metadata).toMatchObject({ invoice_id: INVOICE_ID, amount: 150, method: 'CASH' });
  });

  it('a refund on a standalone invoice writes no job entry', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(paidJobInvoice({ job_id: null, job: null }));
    refundTx();

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/refund`)
      .set(authHeader('admin'))
      .send({ amount: 200, reason_category: 'CUSTOMER_REQUEST', reason: 'part of the work was not done' });
    expect(res.status).toBe(200);
    expect(jobEntries()).toEqual([]);
  });
});

describe('deposit applied on the job', () => {
  const DEPOSIT_INVOICE_ID = 'dep-inv-1';

  /** A completed job whose approved estimate has a paid $1000 deposit invoice, ready to be invoiced. */
  function jobWithPaidDeposit() {
    return {
      id: JOB_ID,
      job_number: 'J00001',
      status: 'COMPLETED',
      assignees: [{ user_id: TEST_USERS.technician.id }],
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      customer: { id: CUSTOMER_FIXTURE.id, payment_type: null, tax_exempt: false },
      service_location: { state: 'TX' },
      tax_rate: 0.08,
      discount_amount: 0,
      estimate: { id: ESTIMATE_APPROVED_FIXTURE.id, estimate_number: 'E00003', tax_rate: 0.08, discount_amount: 0, line_items: [] },
      linked_estimates: [],
      job_line_items: [
        {
          id: 'jli00000-0000-0000-0000-000000000001', sequence: 1, description: 'AC Unit replacement', quantity: 1,
          unit_price: 1800, is_taxable: true, line_total: 1800, item_type: 'MATERIAL', price_book_item_id: null,
          unit_cost: null, markup_percent: null,
        },
      ],
      charges: [],
    };
  }

  function invoiceTx(createdInvoice: Record<string, unknown>) {
    useTransaction({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: {
        findMany: async (args: any) => (args?.where?.kind === 'DEPOSIT' ? [{ id: DEPOSIT_INVOICE_ID }] : []),
        findFirst: async () => null,
        create: (args: any) => ({ ...createdInvoice, ...args.data }),
      },
      payment: {
        aggregate: async () => ({ _sum: { amount: 1000 } }),
        create: (args: any) => ({ id: PAYMENT_ID, ...args.data }),
      },
      depositCreditApplication: {
        aggregate: async () => ({ _sum: { amount: 0 } }),
        create: (args: any) => ({ id: 'dca-1', ...args.data }),
      },
      refund: { aggregate: async () => ({ _sum: { amount: 0 } }) },
    });
  }

  it('making the invoice from the job writes ONE job entry per deposit drawn, with the amount and the invoice', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobWithPaidDeposit());
    invoiceTx({ id: INVOICE_ID, invoice_number: INVOICE_NUMBER });

    const res = await request(app).post('/api/invoices').set(authHeader('admin')).send({ job_id: JOB_ID });
    expect(res.status).toBe(201);

    const applied = ofType(await readHistory(), 'JOB_DEPOSIT_APPLIED');
    expect(applied).toHaveLength(1);
    expect(applied[0].metadata).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: INVOICE_NUMBER,
      deposit_invoice_id: DEPOSIT_INVOICE_ID,
      payment_id: PAYMENT_ID,
      amount: 1000,
      method: 'DEPOSIT_CREDIT',
    });
    expect(applied[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('an invoice made with no deposit to draw writes no deposit entry', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobWithPaidDeposit());
    useTransaction({
      job: { update: vi.fn().mockResolvedValue({}) },
      invoice: { findMany: async () => [], findFirst: async () => null, create: (args: any) => ({ id: INVOICE_ID, invoice_number: INVOICE_NUMBER, ...args.data }) },
    });

    const res = await request(app).post('/api/invoices').set(authHeader('admin')).send({ job_id: JOB_ID });
    expect(res.status).toBe(201);
    expect(ofType(await readHistory(), 'JOB_DEPOSIT_APPLIED')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Reading the history back
// ════════════════════════════════════════════════════════════════════════════
describe('reading the money movements back', () => {
  function recordPaymentTx() {
    useTransaction({
      payment: {
        create: vi.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: PAYMENT_ID, ...data, collector: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } })),
      },
      invoice: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ amount_due: 1000, status: 'SENT' }),
        update: vi.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ id: INVOICE_ID, invoice_number: INVOICE_NUMBER, line_items: [], refunds: [], credits: [], payments: [], customer: null, job: null, ...data })),
      },
    });
  }

  async function recordAPayment() {
    mockPrisma.invoice.findUnique.mockResolvedValue(jobInvoice());
    recordPaymentTx();
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/payments`)
      .set(authHeader('admin'))
      .send({ amount: 400, method: 'CHECK' });
    expect(res.status).toBe(201);
  }

  it("lists a payment once on the job's Activity: the job entry stands in for the invoice-level one it mirrors", async () => {
    await recordAPayment();
    // Both exist where they are written: one on the invoice's own timeline, one on the job.
    expect(feed.filter((e) => e.event_type === 'PAYMENT_RECEIVED' && e.entity_type === 'INVOICE')).toHaveLength(1);
    expect(feed.filter((e) => e.event_type === 'JOB_PAYMENT_RECORDED' && e.entity_type === 'JOB')).toHaveLength(1);

    const seen = await readHistory();
    expect(seen.filter((e) => e.event_type === 'PAYMENT_RECEIVED')).toEqual([]);
    expect(ofType(seen, 'JOB_PAYMENT_RECORDED')).toHaveLength(1);
    // The job entry carries the figure and the method in words.
    expect(ofType(seen, 'JOB_PAYMENT_RECORDED')[0].description).toBe(`Invoice ${INVOICE_NUMBER} payment recorded via Check`);
  });

  it('keeps a payment recorded before this existed: with no job entry beside it, the invoice-level one still shows', async () => {
    feed.push({
      id: 'old-1', organization_id: ALPHA_ORG_ID, entity_type: 'INVOICE', entity_id: INVOICE_ID,
      event_type: 'PAYMENT_RECEIVED', description: 'Payment of $250.00 received via CASH', metadata: null,
      created_at: new Date('2026-01-05T09:00:00Z'), created_by: TEST_USERS.admin.id,
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
    await recordAPayment();

    const seen = await readHistory();
    expect(ofType(seen, 'PAYMENT_RECEIVED').map((e) => e.description)).toEqual(['Payment of $250.00 received via CASH']);
    expect(ofType(seen, 'JOB_PAYMENT_RECORDED')).toHaveLength(1);
  });

  it('does not add the entry-matching fields to what the Activity panel receives', async () => {
    await recordAPayment();
    for (const e of await readHistory()) {
      expect(e).not.toHaveProperty('entity_type');
      expect(e).not.toHaveProperty('entity_id');
    }
  });

  it('a reader who cannot see pricing gets no money entries and no figures', async () => {
    await recordAPayment();
    mockPrisma.note.create.mockResolvedValue({
      id: 'bb000000-0000-0000-0000-000000000002', content: 'Paid by check', created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
    const noted = await request(app).post(`/api/jobs/${JOB_ID}/notes`).set(authHeader('admin')).send({ content: 'Paid by check' });
    expect(noted.status).toBe(201);

    mockAuthAs('technician');
    // Granted by switch, not by role name: may read the job, but no `read Pricing`.
    const seen = await readHistory('technician');

    expect(moneyEntries(seen)).toEqual([]);
    // The note is not money: it stays.
    expect(ofType(seen, 'JOB_NOTE_ADDED')).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('400');
  });
});
