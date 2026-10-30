/**
 * Roles & Permissions Overhaul, PRD 6 / S06.6 - invoice line and discount changes on the job's
 * own timeline.
 *
 * Every line add, change and removal and every discount change on one of a job's invoices, draft
 * or sent, writes a JOB timeline entry (entity_type 'JOB') in the same shape as the job-line
 * entries of S06.5, tagged with the invoice it belongs to. The invoice-level "edited after it was
 * sent" entry is untouched, and the resend reminder still reads it. A standalone invoice (no job)
 * writes no job entry. Prices only, never costs.
 *
 * Harness: supertest against `app`, prisma mocked by setup.ts. The timeline table is replaced by an
 * in-memory feed so the tests read the history back through GET /api/jobs/:id/timeline, the same
 * door the job's Activity panel uses, rather than peeking at what the controller handed prisma.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, INVOICE_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = JOB_FIXTURE.id;
const INVOICE_ID = INVOICE_FIXTURE.id;
const INVOICE_NUMBER = INVOICE_FIXTURE.invoice_number;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const SENT_AT = new Date('2026-07-01T00:00:00Z');

// ─── Fixtures ──────────────────────────────────────────

/** The row loadGuardedInvoice reads: the money fields plus the owner chain. */
function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUMBER,
    status: 'DRAFT',
    sent_at: null,
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: 1080,
    amount_due: 1080,
    tax_rate: 0.08,
    discount_amount: 0,
    tip: 0,
    scopes: [],
    credits: [],
    job_id: JOB_ID,
    customer: { tax_exempt: false },
    job: {
      assignees: [{ user_id: TEST_USERS.technician.id }],
      customer: { tax_exempt: false },
      estimate: { lead: { lead_assignees: [] } },
    },
    ...over,
  };
}

function sentRow(over: Record<string, unknown> = {}) {
  return invoiceRow({ status: 'SENT', sent_at: SENT_AT, ...over });
}

function lineRow(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    invoice_id: INVOICE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 641.37,
    markup_percent: 37.5,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    stock_status: 'NOT_TRACKED',
    stock_location_id: null,
    ...over,
  };
}

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

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) =>
    fn({
      invoiceLineItem: {
        findMany: mockPrisma.invoiceLineItem.findMany,
        findFirst: mockPrisma.invoiceLineItem.findFirst,
        create: mockPrisma.invoiceLineItem.create,
        update: mockPrisma.invoiceLineItem.update,
        deleteMany: mockPrisma.invoiceLineItem.deleteMany,
      },
      invoice: { findUnique: mockPrisma.invoice.findUnique, update: mockPrisma.invoice.update },
      timelineEvent: { create: mockPrisma.timelineEvent.create },
      // S06.20: a job-history write asks which jobs it touches are in Ready to close.
      job: { findMany: mockPrisma.job.findMany },
    } as any),
  );
}

/** What the invoice update returns: the posted data over a minimal detail shape. */
function echoInvoiceUpdate() {
  mockPrisma.invoice.update.mockImplementation((args: any) =>
    Promise.resolve({ id: INVOICE_ID, line_items: [], refunds: [], credits: [], payments: [], customer: null, job: null, ...args.data }),
  );
}

function priceBlindTech() {
  mockAuthAs('technician');
  // Granted by switch, not by role name: may manage the invoice's lines, but no `read Pricing`.
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  useInMemoryTimeline();
  setupTransaction();
  echoInvoiceUpdate();
  mockAuthAs('admin');
  mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
  mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
  mockPrisma.invoice.findMany.mockResolvedValue([{ id: INVOICE_ID }]);
  mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue([lineRow()]);
  mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(lineRow());
  mockPrisma.invoiceLineItem.create.mockResolvedValue({ id: 'new-line' });
  mockPrisma.invoiceLineItem.update.mockResolvedValue({ id: LINE_ID });
  mockPrisma.invoiceLineItem.deleteMany.mockResolvedValue({ count: 1 });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines, draft and sent
// ════════════════════════════════════════════════════════════════════════════
describe('invoice line history on the job', () => {
  it('editing a line on a DRAFT invoice writes ONE job entry with old and new values and the invoice', async () => {
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'AC Unit (14 SEER)', quantity: 2, unit_price: 900 });
    expect(res.status).toBe(200);

    const changed = ofType(await readHistory(), 'JOB_INVOICE_LINE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.invoice_id).toBe(INVOICE_ID);
    expect(changed[0].metadata.invoice_number).toBe(INVOICE_NUMBER);
    expect(changed[0].metadata.line_id).toBe(LINE_ID);
    expect(changed[0].metadata.old).toMatchObject({ name: 'AC Unit', quantity: 1, unit_price: 1000, line_total: 1000 });
    expect(changed[0].metadata.new).toMatchObject({ name: 'AC Unit (14 SEER)', quantity: 2, unit_price: 900, line_total: 1800 });
    expect(changed[0].creator.id).toBe(TEST_USERS.admin.id);
    // It is an entry on the JOB, not only on the invoice.
    expect(jobEntries().map((e) => e.entity_id)).toEqual([JOB_ID]);
    // A draft was never sent, so there is no "edited after it was sent" entry.
    expect(feed.filter((e) => e.event_type === 'INVOICE_EDITED')).toEqual([]);
  });

  it('editing a line on a SENT invoice writes the job entry AND leaves the invoice-level entry as it was', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(sentRow());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 800 });
    expect(res.status).toBe(200);

    const changed = ofType(await readHistory(), 'JOB_INVOICE_LINE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.invoice_id).toBe(INVOICE_ID);
    expect(changed[0].metadata.old).toMatchObject({ unit_price: 1000, line_total: 1000 });
    expect(changed[0].metadata.new).toMatchObject({ unit_price: 800, line_total: 800 });

    // The resend reminder reads this entry; it is the same entry, on the invoice, as before.
    const invoiceEdited = feed.filter((e) => e.event_type === 'INVOICE_EDITED');
    expect(invoiceEdited).toHaveLength(1);
    expect(invoiceEdited[0]).toMatchObject({
      entity_type: 'INVOICE',
      entity_id: INVOICE_ID,
      description: 'Invoice edited after it was sent',
      metadata: { fields: ['line_items'] },
    });
  });

  it('adding a line writes ONE entry with the new values and no old side', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra labor', item_type: 'SERVICE', quantity: 2, unit_price: 100, is_taxable: true });
    expect(res.status).toBe(200);

    const added = ofType(await readHistory(), 'JOB_INVOICE_LINE_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0].metadata.old).toBeNull();
    expect(added[0].metadata.new).toMatchObject({ name: 'Extra labor', quantity: 2, unit_price: 100, line_total: 200 });
    expect(added[0].metadata.invoice_id).toBe(INVOICE_ID);
    expect(added[0].metadata.line_id).toBe('new-line');
  });

  it('removing a line writes ONE entry with the removed values and no new side', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(lineRow({ quantity: 3, line_total: 3000 }));

    const res = await request(app).delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const removed = ofType(await readHistory(), 'JOB_INVOICE_LINE_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0].metadata.new).toBeNull();
    expect(removed[0].metadata.old).toMatchObject({ name: 'AC Unit', quantity: 3, unit_price: 1000, line_total: 3000 });
    expect(removed[0].metadata.invoice_id).toBe(INVOICE_ID);
  });

  it('a line save that changes nothing writes no job entry', async () => {
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 1, unit_price: 1000 });
    expect(res.status).toBe(200);

    expect(jobEntries()).toEqual([]);
  });

  it('a line discount change shows in the entry', async () => {
    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ discount_type: 'PERCENTAGE', discount_value: 10 });
    expect(res.status).toBe(200);

    const changed = ofType(await readHistory(), 'JOB_INVOICE_LINE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.old).toMatchObject({ discount_type: null, discount_amount: 0 });
    expect(changed[0].metadata.new).toMatchObject({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 });
  });

  it('a refused edit (invoice already paid) writes nothing', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PAID' }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 800 });
    expect(res.status).toBe(400);

    expect(feed).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The invoice's discount
// ════════════════════════════════════════════════════════════════════════════
describe('invoice discount history on the job', () => {
  it('changing the invoice discount writes ONE entry with the old and the new discount', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ discount_amount: 50 }));

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ discount_amount: 120 });
    expect(res.status).toBe(200);

    const changed = ofType(await readHistory(), 'JOB_INVOICE_DISCOUNT_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.invoice_id).toBe(INVOICE_ID);
    expect(changed[0].metadata.invoice_number).toBe(INVOICE_NUMBER);
    expect(changed[0].metadata.old).toEqual({ discount_amount: 50 });
    expect(changed[0].metadata.new).toEqual({ discount_amount: 120 });
    expect(changed[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('a discount change on a SENT invoice also leaves the invoice-level entry as it was', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(sentRow());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ discount_amount: 75 });
    expect(res.status).toBe(200);

    expect(ofType(await readHistory(), 'JOB_INVOICE_DISCOUNT_CHANGED')).toHaveLength(1);
    const invoiceEdited = feed.filter((e) => e.event_type === 'INVOICE_EDITED');
    expect(invoiceEdited).toHaveLength(1);
    expect(invoiceEdited[0].metadata).toEqual({ fields: ['discount_amount'] });
  });

  it('re-sending the discount it already has, or changing only the tip, writes no entry', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ discount_amount: 50 }));

    expect(
      (await request(app).patch(`/api/invoices/${INVOICE_ID}/billing`).set(authHeader('admin')).send({ discount_amount: 50 })).status,
    ).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/billing`).set(authHeader('admin')).send({ tip: 20 })).status).toBe(200);

    expect(jobEntries()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A standalone invoice has no job
// ════════════════════════════════════════════════════════════════════════════
describe('a standalone invoice (no job)', () => {
  beforeEach(() => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ job_id: null, job: null, discount_amount: 50 }));
  });

  it('writes no job entry for any line or discount edit', async () => {
    const as = authHeader('admin');
    expect((await request(app).post(`/api/invoices/${INVOICE_ID}/line-items`).set(as).send({ description: 'Labor', quantity: 1, unit_price: 100 })).status).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(as).send({ unit_price: 800 })).status).toBe(200);
    expect((await request(app).delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(as)).status).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/billing`).set(as).send({ discount_amount: 120 })).status).toBe(200);

    expect(feed).toEqual([]);
  });

  it('a standalone SENT invoice still writes its invoice-level entry', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(sentRow({ job_id: null, job: null }));

    expect(
      (await request(app).patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(authHeader('admin')).send({ unit_price: 800 })).status,
    ).toBe(200);

    expect(jobEntries()).toEqual([]);
    expect(feed.filter((e) => e.event_type === 'INVOICE_EDITED')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Prices, never costs
// ════════════════════════════════════════════════════════════════════════════
describe('what the entries carry', () => {
  it('no entry carries a cost figure, whatever the edit', async () => {
    const as = authHeader('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ discount_amount: 10 }));
    expect(
      (await request(app).post(`/api/invoices/${INVOICE_ID}/line-items`).set(as).send({
        description: 'AC Unit', item_type: 'SERVICE', quantity: 1, unit_price: 1000, unit_cost: 641.37, markup_percent: 37.5,
      })).status,
    ).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(as).send({ quantity: 2 })).status).toBe(200);
    expect((await request(app).delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(as)).status).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/billing`).set(as).send({ discount_amount: 99 })).status).toBe(200);

    const history = jobEntries();
    expect(history.map((e) => e.event_type).sort()).toEqual([
      'JOB_INVOICE_DISCOUNT_CHANGED',
      'JOB_INVOICE_LINE_ADDED',
      'JOB_INVOICE_LINE_CHANGED',
      'JOB_INVOICE_LINE_REMOVED',
    ]);
    const text = JSON.stringify(history);
    for (const key of ['unit_cost', 'markup_percent', 'internal_cost']) expect(text).not.toContain(`"${key}"`);
    for (const figure of ['641.37', '37.5']) expect(text).not.toContain(figure);
  });

  it('a reader who cannot see pricing gets the changes without their prices', async () => {
    const as = authHeader('admin');
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`).set(as).send({ unit_price: 800 })).status).toBe(200);
    expect((await request(app).patch(`/api/invoices/${INVOICE_ID}/billing`).set(as).send({ discount_amount: 120 })).status).toBe(200);
    expect(jobEntries()).toHaveLength(2);

    priceBlindTech();
    const seen = await readHistory('technician');

    const lineChange = seen.find((e) => e.event_type === 'JOB_INVOICE_LINE_CHANGED');
    expect(lineChange.metadata.old).toMatchObject({ name: 'AC Unit', quantity: 1 });
    expect(lineChange.metadata.new).toMatchObject({ name: 'AC Unit', quantity: 1 });
    // The discount entry is nothing but money.
    expect(seen.find((e) => e.event_type === 'JOB_INVOICE_DISCOUNT_CHANGED')).toBeUndefined();

    const text = JSON.stringify(seen);
    for (const key of ['unit_price', 'line_total', 'discount_amount']) expect(text).not.toContain(`"${key}"`);
    for (const figure of ['1000', '800', '120']) expect(text).not.toContain(figure);
  });
});
