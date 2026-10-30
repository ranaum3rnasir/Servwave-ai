/**
 * Roles & Permissions Overhaul, PRD 6 / S06.5 - job line, scope and discount changes on the job's
 * own history.
 *
 * Every add, change and removal of a job line, every scope change and every job discount change
 * writes a TimelineEvent on the JOB (entity_type 'JOB') with structured old/new values in its
 * metadata: name, quantity, unit price, line total, discount. The office-review panel (S06.8)
 * reads these entries. They carry PRICES, never costs, and a requester who cannot see pricing
 * does not get the prices back out of the job's activity.
 *
 * Harness: supertest against `app`, prisma mocked by setup.ts. The timeline table is replaced by
 * an in-memory feed so the tests read the history back through GET /api/jobs/:id/timeline, the
 * same door the job's Activity panel uses, rather than peeking at what the controller handed prisma.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000001';

// ─── Fixtures ──────────────────────────────────────────

function lineRow(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    job_id: JOB_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 640,
    markup_percent: 56.25,
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

function scopeRow(over: Record<string, unknown> = {}) {
  return {
    id: SCOPE_ID,
    title: 'Permit fee',
    body: 'City permit',
    flat_price: 300,
    is_taxable: true,
    internal_cost: 120,
    ...over,
  };
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    source_plan_id: null,
    job_number: 'J00001',
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    customer: { tax_exempt: false },
    assignees: [{ user_id: TEST_USERS.technician.id }],
    job_line_items: [] as any[],
    invoices: [] as any[],
    scopes: [] as any[],
    ...over,
  };
}

// ─── The job's history, in memory ──────────────────────

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
          where.OR.some((c: any) => c.entity_type === e.entity_type && c.entity_id === e.entity_id),
      ),
    ),
  );
}

/** Reads the job's activity the way the Activity panel does. */
async function readHistory(as: 'admin' | 'technician' = 'admin', kind?: string) {
  const res = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader(as));
  expect(res.status).toBe(200);
  const events = res.body.events as any[];
  return kind ? events.filter((e) => e.event_type === kind) : events;
}

const COST_KEYS = ['unit_cost', 'markup_percent', 'internal_cost'];

function priceBlindTech() {
  mockAuthAs('technician');
  // Granted by switch, not by role name: may manage the job's lines, but no `read Pricing`.
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  useInMemoryTimeline();
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mockPrisma) : Promise.all(arg as Promise<unknown>[]),
  );
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
});

// ════════════════════════════════════════════════════════════════════════════
// Job lines
// ════════════════════════════════════════════════════════════════════════════
describe('job line history', () => {
  it('adding a line writes ONE entry on the job with the new values and who added it', async () => {
    mockAuthAs('admin');
    mockPrisma.jobLineItem.create.mockResolvedValue(
      lineRow({ description: 'Labor', quantity: 2, unit_price: 100, line_total: 200, unit_cost: null, markup_percent: null }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Labor', quantity: 2, unit_price: 100, is_taxable: true, item_type: 'SERVICE' });
    expect(res.status).toBe(201);

    const added = await readHistory('admin', 'JOB_LINE_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0].metadata.old).toBeNull();
    expect(added[0].metadata.new).toMatchObject({ name: 'Labor', quantity: 2, unit_price: 100, line_total: 200 });
    expect(added[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('changing a line writes ONE entry with the old and the new name, quantity, unit price and line total', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ job_line_items: [lineRow()] }));
    mockPrisma.jobLineItem.update.mockResolvedValue(
      lineRow({ description: 'AC Unit (14 SEER)', quantity: 2, unit_price: 900, line_total: 1800 }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'AC Unit (14 SEER)', quantity: 2, unit_price: 900 });
    expect(res.status).toBe(200);

    const changed = await readHistory('admin', 'JOB_LINE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.old).toMatchObject({ name: 'AC Unit', quantity: 1, unit_price: 1000, line_total: 1000 });
    expect(changed[0].metadata.new).toMatchObject({ name: 'AC Unit (14 SEER)', quantity: 2, unit_price: 900, line_total: 1800 });
    expect(changed[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('a save that changes nothing writes no entry', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ job_line_items: [lineRow()] }));
    mockPrisma.jobLineItem.update.mockResolvedValue(lineRow());

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 1, unit_price: 1000 });
    expect(res.status).toBe(200);

    expect(await readHistory()).toEqual([]);
  });

  it('removing a line writes ONE entry with the removed values and no new side', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ job_line_items: [lineRow({ quantity: 3, line_total: 3000 })] }));
    mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const removed = await readHistory('admin', 'JOB_LINE_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0].metadata.new).toBeNull();
    expect(removed[0].metadata.old).toMatchObject({ name: 'AC Unit', quantity: 3, unit_price: 1000, line_total: 3000 });
    expect(removed[0].creator.id).toBe(TEST_USERS.admin.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scopes of work
// ════════════════════════════════════════════════════════════════════════════

/** The two job reads a scope handler makes: the guard load, then the fresh in-transaction re-read. */
function mockScopeReads(scopes: unknown[]) {
  mockPrisma.job.findUnique
    .mockResolvedValueOnce(jobRow({ scopes }))
    .mockResolvedValueOnce({ scopes });
}

describe('scope history', () => {
  it('adding a scope writes ONE entry with its name and price', async () => {
    mockAuthAs('admin');
    mockScopeReads([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', body: 'City permit', flat_price: 300, internal_cost: 120 });
    expect(res.status).toBe(201);

    const added = await readHistory('admin', 'JOB_SCOPE_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0].metadata.old).toBeNull();
    expect(added[0].metadata.new).toMatchObject({ name: 'Permit fee', flat_price: 300 });
    expect(added[0].metadata.scope_id).toBe(res.body.scopes[0].id);
    expect(added[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('changing a scope writes ONE entry with the old and the new values', async () => {
    mockAuthAs('admin');
    mockScopeReads([scopeRow()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ title: 'Permit and inspection', flat_price: 450 });
    expect(res.status).toBe(200);

    const changed = await readHistory('admin', 'JOB_SCOPE_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.scope_id).toBe(SCOPE_ID);
    expect(changed[0].metadata.old).toMatchObject({ name: 'Permit fee', flat_price: 300 });
    expect(changed[0].metadata.new).toMatchObject({ name: 'Permit and inspection', flat_price: 450 });
  });

  it('a scope save that changes nothing writes no entry', async () => {
    mockAuthAs('admin');
    mockScopeReads([scopeRow()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 300 });
    expect(res.status).toBe(200);

    expect(await readHistory()).toEqual([]);
  });

  it('removing a scope writes ONE entry with the removed values and no new side', async () => {
    mockAuthAs('admin');
    mockScopeReads([scopeRow()]);

    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'));
    expect(res.status).toBe(200);

    const removed = await readHistory('admin', 'JOB_SCOPE_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0].metadata.new).toBeNull();
    expect(removed[0].metadata.old).toMatchObject({ name: 'Permit fee', flat_price: 300 });
  });

  it('reordering scopes writes no entry: no value moved', async () => {
    mockAuthAs('admin');
    const other = scopeRow({ id: 'cc000000-0000-0000-0000-000000000002', title: 'Disposal' });
    mockScopeReads([scopeRow(), other]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [other.id, SCOPE_ID] });
    expect(res.status).toBe(200);

    expect(await readHistory()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The job's discount
// ════════════════════════════════════════════════════════════════════════════
describe('job discount history', () => {
  // The pre-edit row PATCH /api/jobs/:id loads: one $1000 taxable line to resolve a rate against.
  const priorJob = (over: Record<string, unknown> = {}) => ({
    ...JOB_FIXTURE,
    customer: { ...JOB_FIXTURE.customer, tax_exempt: false },
    job_line_items: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
    scopes: [],
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    ...over,
  });

  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
  });

  it('adding a discount writes ONE entry with the old and the new discount', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(priorJob());

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('admin'))
      .send({ discount_type: 'PERCENTAGE', discount_value: 10 });
    expect(res.status).toBe(200);

    const changed = await readHistory('admin', 'JOB_DISCOUNT_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.old).toEqual({ discount_type: null, discount_value: null, discount_amount: 0 });
    // 10% of the job's own $1000 subtotal, as the server resolved it.
    expect(changed[0].metadata.new).toEqual({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 });
    expect(changed[0].creator.id).toBe(TEST_USERS.admin.id);
  });

  it('raising an existing discount records the discount it replaced', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      priorJob({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 }),
    );

    await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('admin'))
      .send({ discount_type: 'FIXED_AMOUNT', discount_value: 250 });

    const changed = await readHistory('admin', 'JOB_DISCOUNT_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.old).toEqual({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 });
    expect(changed[0].metadata.new).toEqual({ discount_type: 'FIXED_AMOUNT', discount_value: 250, discount_amount: 250 });
  });

  it('removing the discount writes an entry that ends at no discount', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      priorJob({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 }),
    );

    await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('admin')).send({ discount_type: null });

    const changed = await readHistory('admin', 'JOB_DISCOUNT_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata.new).toEqual({ discount_type: null, discount_value: 10, discount_amount: 0 });
  });

  it('re-sending the discount it already has writes no entry', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      priorJob({ discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100 }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('admin'))
      .send({ discount_type: 'PERCENTAGE', discount_value: 10 });
    expect(res.status).toBe(200);

    expect(await readHistory()).toEqual([]);
  });

  it('a job edit that does not touch the discount writes no discount entry', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(priorJob());

    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('admin')).send({ scope_notes: 'Bring a ladder' });
    expect(res.status).toBe(200);

    expect(await readHistory()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Prices, never costs
// ════════════════════════════════════════════════════════════════════════════
describe('what the history carries', () => {
  // Distinctive figures, so a cost leaking in under ANY key name still shows up in the text.
  const COST_FIGURES = ['641.37', '37.5', '123.45'];

  it('no entry carries a cost figure, whatever the edit', async () => {
    mockAuthAs('admin');
    const costly = lineRow({ unit_cost: 641.37, markup_percent: 37.5 });

    // add
    mockPrisma.jobLineItem.create.mockResolvedValue(costly);
    expect(
      (await request(app)
        .post(`/api/jobs/${JOB_ID}/line-items`)
        .set(authHeader('admin'))
        .send({ description: 'AC Unit', quantity: 1, unit_price: 1000, unit_cost: 641.37, markup_percent: 37.5 })).status,
    ).toBe(201);
    // change
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ job_line_items: [costly] }));
    mockPrisma.jobLineItem.update.mockResolvedValue({ ...costly, quantity: 2, line_total: 2000 });
    expect((await request(app).patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin')).send({ quantity: 2 })).status).toBe(200);
    // remove
    mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 1 });
    expect((await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin'))).status).toBe(200);
    // scope add, change, remove
    const costlyScope = scopeRow({ internal_cost: 123.45 });
    mockScopeReads([]);
    expect(
      (await request(app)
        .post(`/api/jobs/${JOB_ID}/scopes`)
        .set(authHeader('admin'))
        .send({ title: 'Permit fee', flat_price: 300, internal_cost: 123.45 })).status,
    ).toBe(201);
    mockScopeReads([costlyScope]);
    expect((await request(app).patch(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin')).send({ flat_price: 350 })).status).toBe(200);
    mockScopeReads([costlyScope]);
    expect((await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'))).status).toBe(200);

    const history = await readHistory();
    expect(history.map((e) => e.event_type).sort()).toEqual([
      'JOB_LINE_ADDED',
      'JOB_LINE_CHANGED',
      'JOB_LINE_REMOVED',
      'JOB_SCOPE_ADDED',
      'JOB_SCOPE_CHANGED',
      'JOB_SCOPE_REMOVED',
    ]);
    const text = JSON.stringify(history);
    for (const key of COST_KEYS) expect(text).not.toContain(`"${key}"`);
    for (const figure of COST_FIGURES) expect(text).not.toContain(figure);
  });

  it('a reader who cannot see pricing gets the changes without their prices', async () => {
    // An office user with pricing makes a price cut, a discount and a scope change ...
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ job_line_items: [lineRow()] }));
    mockPrisma.jobLineItem.update.mockResolvedValue(lineRow({ unit_price: 800, line_total: 800 }));
    await request(app).patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin')).send({ unit_price: 800 });
    mockScopeReads([scopeRow()]);
    await request(app).patch(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin')).send({ flat_price: 250 });
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      customer: { ...JOB_FIXTURE.customer, tax_exempt: false },
      job_line_items: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
      scopes: [],
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
    });
    mockPrisma.job.update.mockResolvedValue({ ...JOB_FIXTURE });
    await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('admin'))
      .send({ discount_type: 'PERCENTAGE', discount_value: 10 });
    expect(await readHistory('admin')).toHaveLength(3);

    // ... and a user without `read Pricing` opens the job's activity.
    priceBlindTech();
    const seen = await readHistory('technician');

    // The price cut is still there, with what it was about, but not what it cost.
    const lineChange = seen.find((e) => e.event_type === 'JOB_LINE_CHANGED');
    expect(lineChange.metadata.old).toMatchObject({ name: 'AC Unit', quantity: 1 });
    expect(lineChange.metadata.new).toMatchObject({ name: 'AC Unit', quantity: 1 });
    const scopeChange = seen.find((e) => e.event_type === 'JOB_SCOPE_CHANGED');
    expect(scopeChange.metadata.new).toMatchObject({ name: 'Permit fee' });
    // The discount entry is nothing but money.
    expect(seen.find((e) => e.event_type === 'JOB_DISCOUNT_CHANGED')).toBeUndefined();

    const text = JSON.stringify(seen);
    for (const key of ['unit_price', 'line_total', 'flat_price', 'discount_value', 'discount_amount']) {
      expect(text).not.toContain(`"${key}"`);
    }
    for (const figure of ['1000', '800', '250']) expect(text).not.toContain(figure);
  });
});
