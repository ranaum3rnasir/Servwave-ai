/**
 * SERV10X-38 Task 3 — Job line-item CRUD (job-owned items, pre-invoice).
 *
 * CRITICAL invariants asserted here:
 *   - Adding / editing a job line NEVER creates an Invoice (the whole point of job-owned
 *     items is deferring invoice creation) and NEVER calls prisma.priceBookItem.update/
 *     .upsert (no write-back to the catalog/inventory) — mirrors invoice-lines.test.ts.
 *   - Gate: canDo('update','Job') [canDo('read','Job') for list] + canAccessRow(Job).
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts), grants via setCachedGrants
 * (mirrors invoice-lines.test.ts's harness exactly).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, mockScopedFindFirst } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';
import { addLineSchema as jobAddLineSchema } from '../controllers/job-lines.controller';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  jobLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  invoice: {
    create: ReturnType<typeof vi.fn>;
  };
  priceBookItem: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: {
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';

// An existing line on the job (returned by the guard-load + used by update/delete tests).
function existingLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    job_id: JOB_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
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

// The owner-chain + billing-input shape the controller's findUnique loads, so canAccessRow /
// computeJobBilling have data. Mirrors the task-3-brief.md skeleton.
// job-owns-tax-discount (E1/E2) - the job carries its OWN tax_rate/discount_*, no longer a
// resolver over an attached estimate.
function jobRow({
  sourcePlanId = null as string | null,
  techId = TEST_USERS.technician.id as string,
  jobLineItems = [] as any[],
  invoices = [] as any[],
  scopes = null as unknown[] | null,
  taxRate = 0 as number,
  discountType = null as 'PERCENTAGE' | 'FIXED_AMOUNT' | null,
  discountValue = null as number | null,
  discountAmount = 0 as number,
} = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    source_plan_id: sourcePlanId,
    job_number: 'J00001',
    tax_rate: taxRate,
    discount_type: discountType,
    discount_value: discountValue,
    discount_amount: discountAmount,
    customer: { tax_exempt: false },
    assignees: [{ user_id: techId }],
    job_line_items: jobLineItems,
    invoices,
    scopes,
  };
}

// A scope-of-work fixture, as stored in the JSONB Job.scopes column (scopes.ts ScopeOfWork).
function scopeFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000001',
    title: 'Permit fee',
    body: '',
    flat_price: 300,
    is_taxable: true,
    internal_cost: null,
    ...over,
  };
}

// $transaction runs the callback synchronously against a tx proxy delegating to the mocked
// job.findUnique/update — mirrors invoice-lines.test.ts's identical helper. Handles BOTH forms
// job-lines.controller.ts uses: the callback form (the scope handlers — re-read-then-write race
// fix) and the array form (reorderLines' per-line prisma.jobLineItem.update array, unchanged) —
// the array's underlying calls already ran eagerly when the array was built, so Promise.all just
// awaits them (previously $transaction was never mocked at all, so it silently returned undefined
// there — awaiting undefined was harmless only because reorderLines never uses the return value).
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        job: {
          findUnique: mockPrisma.job.findUnique,
          update: mockPrisma.job.update,
        },
        // P1: addLine/updateLine (and later deleteLine) are tx-wrapped for the stock movements —
        // delegating to the same bare mocks keeps every pre-P1 assertion in this file green.
        jobLineItem: {
          create: mockPrisma.jobLineItem.create,
          update: mockPrisma.jobLineItem.update,
          deleteMany: mockPrisma.jobLineItem.deleteMany,
        },
        priceBookItem: {
          findFirst: mockPrisma.priceBookItem.findFirst,
          findMany: mockPrisma.priceBookItem.findMany,
        },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: {
          upsert: mockPrisma.stockBalance.upsert,
          updateMany: mockPrisma.stockBalance.updateMany,
          findUnique: mockPrisma.stockBalance.findUnique,
        },
        organization: { findUnique: mockPrisma.organization.findUnique },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

// Queues the exact job.findUnique call sequence a scope handler now makes (mirrored inside
// $transaction via the job.findUnique proxy in setupTransaction):
//   1. loadGuardedJob's guard-shaped read (outside the tx).
//   2. the handler's own pre-mutation FRESH `{ scopes }` re-read (inside the tx) — this is the
//      read that closes the race: it may return something DIFFERENT than what loadGuardedJob saw,
//      simulating a concurrent scope mutation that landed in between.
// Unlike invoice-lines' 3-deep mockScopeReads, there is no third "post-recompute" read to queue —
// job billing is computed-on-read from the local post-mutation array, never persisted.
function mockScopeReads(guardScopes: unknown[], freshScopes: unknown[], guardOverrides: Record<string, unknown> = {}) {
  mockPrisma.job.findUnique
    .mockResolvedValueOnce(jobRow({ ...guardOverrides, scopes: guardScopes }))
    .mockResolvedValueOnce({ scopes: freshScopes });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  // P1 stock defaults: catalog lookups resolve nothing (free-text/untracked behavior), org
  // policy = warn mode — pre-P1 tests keep their exact movement-free behavior.
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
  mockPrisma.jobLineItem.create.mockResolvedValue({
    id: 'jli-1',
    job_id: JOB_ID,
    sequence: 1,
    description: 'Labor',
    quantity: 1,
    unit_price: 100,
    unit_cost: null,
    markup_percent: null,
    line_total: 100,
    is_taxable: false,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/:id/line-items — add a job line (NO invoice, NO price-book write-back)
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/jobs/:id/line-items — add', () => {
  it('ADMIN creates a JobLineItem and does NOT create an invoice or write the price book', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100, is_taxable: false, item_type: 'SERVICE' });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(createArg.data.job_id).toBe(JOB_ID);
    expect(createArg.data.sequence).toBe(1);
    expect(Number(createArg.data.line_total)).toBe(100);
    // ← no premature invoice, no catalog write-back.
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
    expect(res.body.line).toBeDefined();
    expect(res.body.billing).toMatchObject({ total: expect.any(Number), invoiced: expect.any(Number), remaining: expect.any(Number) });
  });

  it('adds from a price_book_item_id as an INDEPENDENT snapshot — stores ref id, NEVER writes back', async () => {
    mockAuthAs('admin');
    const PB_ID = 'bb000000-0000-0000-0000-000000000009';

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Filter', quantity: 3, unit_price: 25, is_taxable: true, item_type: 'MATERIAL', price_book_item_id: PB_ID });

    expect(res.status).toBe(201);
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(createArg.data.price_book_item_id).toBe(PB_ID);
    expect(createArg.data.item_type).toBe('MATERIAL');
    expect(Number(createArg.data.line_total)).toBe(75);
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
  });

  it('next sequence = max(existing) + 1', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ id: 'l1', sequence: 1 }, { id: 'l2', sequence: 3 }] }),
    );

    await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(createArg.data.sequence).toBe(4);
  });

  it('computes billing.total including the newly-added line', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ quantity: 1, unit_price: 50, is_taxable: false }] }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Labor', quantity: 1, unit_price: 100, is_taxable: false });

    // existing 50 + new 100 = 150 (jobRow() defaults tax_rate to 0 in this fixture).
    expect(res.body.billing.total).toBe(150);
    expect(res.body.billing.remaining).toBe(150);
  });

  it("billing.total includes the job's OWN tax_rate (E1) and discount_amount (E2)", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [{ quantity: 1, unit_price: 1000, is_taxable: true }],
        taxRate: 0.0625,
        discountAmount: 100,
      }),
    );

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    // subtotal 1000, $100 discount (already-resolved, E2 - never re-derived from a rate against
    // the live subtotal) → discounted 900 * 6.25% tax = 56.25
    expect(res.body.billing.subtotal).toBe(1000);
    expect(res.body.billing.discount_amount).toBe(100);
    expect(res.body.billing.tax_rate).toBe(0.0625);
    expect(res.body.billing.tax_amount).toBe(56.25);
    expect(res.body.billing.total).toBe(956.25);
  });

  it('a brand-new job previews at 0% tax and $0 discount (schema defaults)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ quantity: 1, unit_price: 100, is_taxable: true }] }),
    );

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));

    expect(res.body.billing.tax_rate).toBe(0);
    expect(res.body.billing.tax_amount).toBe(0);
    expect(res.body.billing.discount_amount).toBe(0);
  });

  it('a tax-exempt customer still shows $0 tax even with a taxed job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...jobRow({
        jobLineItems: [{ quantity: 1, unit_price: 100, is_taxable: true }],
        taxRate: 0.08,
      }),
      customer: { tax_exempt: true },
    });

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));

    expect(res.body.billing.tax_amount).toBe(0);
  });

  it('blocks a service-plan visit job → 400, no create', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001' }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan/i);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(404);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (qty <= 0) → 400', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 0, unit_price: 10 });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  // #1991: markup_percent is Decimal(8,2) on JobLineItem (max representable 999999.99) and the Zod
  // bound is 0..100000 — the cap exists so an out-of-range value is refused with a 400 rather than
  // passing validation and 22003-overflowing Prisma's write into an opaque 500. The bound is
  // deliberately BELOW the column width, so the 400 is always the one the user meets. Mirrors
  // invoice-lines.controller.ts's identical .max(100000) cap on the same field.
  it('rejects markup_percent over the 100000 cap → 400, no create (not a 500)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10, markup_percent: 100001 });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('accepts markup_percent at exactly the 100000 cap boundary → 201', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x', quantity: 1, unit_price: 10, markup_percent: 100000 });
    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create).toHaveBeenCalled();
  });
});

// ─── RBAC matrix: add-line is gated `update` Job ──────────────────────────────
describe('POST /api/jobs/:id/line-items — RBAC (update Job)', () => {
  it('DISPATCHER (unconditional update Job) can add', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('dispatcher'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create).toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('TECHNICIAN granted "Edit own jobs" (update Job, OWN_JOB) can add on OWN job', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    // canAccessRow(Job) → scoped job.findFirst resolves truthy for an owned row.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create).toHaveBeenCalled();
  });

  it('TECHNICIAN (granted update Job) still gets 403 on a FOREIGN job, never mutates', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ techId: '99999999-9999-9999-9999-999999999999' }));
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('SALES has NO update:Job by default → 403 at the route guard, no mutation', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'x', quantity: 1, unit_price: 10 });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/jobs/:id/line-items — list (read Job)
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/jobs/:id/line-items — list', () => {
  it('returns the job\'s lines + a billing preview', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].id).toBe(LINE_ID);
    expect(res.body.billing).toMatchObject({ total: 1000, invoiced: 0, remaining: 1000 });
  });

  it('TECHNICIAN with only the default read:Job (no update) grant can still list their OWN job', async () => {
    mockAuthAs('technician');
    // Default TECHNICIAN grants (defaultGrants.ts) already include read:Job scoped OWN_JOB —
    // list is gated `read`, not `update`, so no per-user opt-in is required here. The
    // conditional grant means canAccessRow does a real scoped lookup (prisma.job.findFirst).
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  // ── Items-editor port: the line select must carry the catalog photo ──
  // The Job → Items grid renders the shared LineItemRow, whose Item cell leads with the price
  // book item's photo. Without the nested price_book_item relation on this select, a
  // catalog-backed line silently falls back to the no-photo placeholder forever. Mirrors the
  // invoice detail select's identical requirement (invoices.test.ts, "detail select exposes
  // line discount fields + price_book_item photo for the editor").
  it('list select exposes the price_book_item photo for the editor row', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [
          existingLine({
            price_book_item_id: 'pbi-1',
            price_book_item: { image_url: 'http://img/closer.png', photo_url: null },
          }),
        ],
      }),
    );

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = mockPrisma.job.findUnique.mock.calls[0][0] as {
      select: { job_line_items: { select: Record<string, unknown> } };
    };
    expect(call.select.job_line_items.select).toEqual(
      expect.objectContaining({
        price_book_item_id: true,
        price_book_item: expect.objectContaining({
          select: expect.objectContaining({ image_url: true, photo_url: true }),
        }),
      }),
    );
    // Carried back on the response for the editor row.
    expect(res.body.lines[0].price_book_item.image_url).toBe('http://img/closer.png');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/jobs/:id/line-items/:lineId — edit a line (update Job)
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/jobs/:id/line-items/:lineId — edit', () => {
  beforeEach(() => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));
    mockPrisma.jobLineItem.update.mockResolvedValue(existingLine({ quantity: 3, line_total: 3000 }));
  });

  it('ADMIN edits qty, recomputes line_total, never touches the price book', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    const updArg = mockPrisma.jobLineItem.update.mock.calls[0][0];
    // scoped to the line AND its parent job — no cross-job edit.
    expect(JSON.stringify(updArg.where)).toContain(LINE_ID);
    expect(JSON.stringify(updArg.where)).toContain(JOB_ID);
    expect(Number(updArg.data.line_total)).toBe(3000);
    expect(res.body.billing.total).toBe(3000);
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.priceBookItem.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('blocks editing on a service-plan visit job → 400, no update', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', jobLineItems: [existingLine()] }),
    );
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('404s a line id not on the job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [] }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });
    expect(res.status).toBe(404);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  // #1991: markup_percent is Decimal(8,2) on JobLineItem (max representable 999999.99) and the Zod
  // bound is 0..100000 — the cap exists so an out-of-range value is refused with a 400 rather than
  // passing validation and 22003-overflowing Prisma's write into an opaque 500. The bound is
  // deliberately BELOW the column width, so the 400 is always the one the user meets. Mirrors
  // invoice-lines.controller.ts's identical .max(100000) cap on the same field.
  it('rejects markup_percent over the 100000 cap → 400, no update (not a 500)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ markup_percent: 100001 });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('accepts markup_percent at exactly the 100000 cap boundary → 200', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ markup_percent: 100000 });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
  });

  it('DISPATCHER (unconditional update Job) can edit', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('dispatcher'))
      .send({ quantity: 3 });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
  });

  // Was: "TECHNICIAN with default grants can edit a line on their own job -> 200", justified by
  // Spec A D3 making `update Job` an own-scoped role default. That stopped being true when the
  // technician-ownership spec (Part C) moved the line-item routes onto `manage_lines Job` and
  // scoped it to the CREATOR - being on the crew is no longer enough. The test kept passing only
  // because a truthy `job.findFirst` leaks into this describe from an earlier one (vi.clearAllMocks
  // clears calls, not implementations), so the scope probe never really ran.
  //
  // Both halves of the new rule are asserted here, with a findFirst that actually evaluates the
  // fragment, because the pair is the property - either alone is satisfiable by a broken gate.
  it('TECHNICIAN with default grants can edit a line on a job they CREATED -> 200', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...jobRow({ jobLineItems: [existingLine()] }),
      created_by_id: TEST_USERS.technician.id,
    });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.technician.id,
      assignees: [{ user_id: TEST_USERS.technician.id }],
    });
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3 });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalled();
  });

  it('TECHNICIAN with default grants CANNOT edit a line on a job they are only assigned to -> 403', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...jobRow({ jobLineItems: [existingLine()] }),
      created_by_id: TEST_USERS.admin.id,
    });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      id: JOB_ID,
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      assignees: [{ user_id: TEST_USERS.technician.id }],
    });
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3 });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN granted "Edit own jobs" gets 403 on a FOREIGN job — bare technician on someone else\'s job, no mutation', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ techId: '99999999-9999-9999-9999-999999999999', jobLineItems: [existingLine()] }),
    );
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 3 });

    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/jobs/:id/line-items/:lineId — remove a line (update Job)
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/jobs/:id/line-items/:lineId — delete', () => {
  beforeEach(() => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingLine()] }));
    mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('ADMIN deletes a line (scoped to job + tenant), returns recomputed billing', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const delArg = mockPrisma.jobLineItem.deleteMany.mock.calls[0][0];
    expect(JSON.stringify(delArg.where)).toContain(LINE_ID);
    expect(JSON.stringify(delArg.where)).toContain(JOB_ID);
    expect(res.body.billing).toMatchObject({ total: 0, invoiced: 0, remaining: 0 });
    expect(mockPrisma.priceBookItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.create).not.toHaveBeenCalled();
  });

  it('blocks deleting on a service-plan visit job → 400, no delete', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', jobLineItems: [existingLine()] }),
    );
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('404s a line id not on the job (no delete)', async () => {
    mockAuthAs('admin');
    mockPrisma.jobLineItem.deleteMany.mockResolvedValue({ count: 0 });
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('DISPATCHER (unconditional update Job) can delete', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.deleteMany).toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('a bare TECHNICIAN on ANOTHER technician\'s job gets 403, never mutates (canAccessRow)', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ techId: '99999999-9999-9999-9999-999999999999', jobLineItems: [existingLine()] }),
    );
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app).delete(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.deleteMany).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/jobs/:id/line-items/reorder — persist a full drag-and-drop reorder (update Job).
// The frontend splices a within-group drag back into the FULL flat top-to-bottom order before
// calling this — the backend has no notion of "groups"; it just persists sequence 1..N exactly
// as given, atomically, or 400s without touching anything.
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/jobs/:id/line-items/reorder — reorder', () => {
  const LINE_A = LINE_ID; // 'aa000000-0000-0000-0000-000000000001'
  const LINE_B = 'aa000000-0000-0000-0000-000000000002';
  const LINE_C = 'aa000000-0000-0000-0000-000000000003';

  function threeLines() {
    return [
      existingLine({ id: LINE_A, sequence: 1, description: 'A' }),
      existingLine({ id: LINE_B, sequence: 2, description: 'B' }),
      existingLine({ id: LINE_C, sequence: 3, description: 'C' }),
    ];
  }

  beforeEach(() => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: threeLines() }));
    mockPrisma.jobLineItem.update.mockResolvedValue({});
  });

  it('a valid full permutation reassigns sequence 1..N to match the given order exactly', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_C, LINE_A, LINE_B] });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalledTimes(3);
    const sequenceOf = (id: string) =>
      mockPrisma.jobLineItem.update.mock.calls.find((c) => c[0].where.id === id)?.[0].data.sequence;
    expect(sequenceOf(LINE_C)).toBe(1);
    expect(sequenceOf(LINE_A)).toBe(2);
    expect(sequenceOf(LINE_B)).toBe(3);
    // Every write is scoped to the line AND its parent job — no cross-job reorder.
    mockPrisma.jobLineItem.update.mock.calls.forEach((c) => expect(c[0].where.job_id).toBe(JOB_ID));

    // Fresh read: re-fetching the lines afterward reflects the persisted order (the mock doesn't
    // apply real writes, so re-mock job.findUnique with what the transaction just persisted).
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [
          existingLine({ id: LINE_C, sequence: 1, description: 'C' }),
          existingLine({ id: LINE_A, sequence: 2, description: 'A' }),
          existingLine({ id: LINE_B, sequence: 3, description: 'B' }),
        ],
      }),
    );
    const listRes = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('admin'));
    expect(listRes.body.lines.map((l: { id: string }) => l.id)).toEqual([LINE_C, LINE_A, LINE_B]);
  });

  it('400s when the submitted order is missing one of the current line ids, no mutation', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B] }); // LINE_C missing
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains an id that is not one of this job\'s lines, no mutation', async () => {
    mockAuthAs('admin');
    const FOREIGN_ID = 'ff000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B, FOREIGN_ID] });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains a duplicate id, no mutation', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_A, LINE_B] }); // LINE_C missing, LINE_A duplicated
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('a mixed MATERIAL+SERVICE set of lines reorders correctly across the full set (no "groups" on the backend)', async () => {
    mockAuthAs('admin');
    const LINE_D = 'aa000000-0000-0000-0000-000000000004';
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [
          existingLine({ id: LINE_A, sequence: 1, item_type: 'SERVICE' }),
          existingLine({ id: LINE_B, sequence: 2, item_type: 'MATERIAL' }),
          existingLine({ id: LINE_C, sequence: 3, item_type: 'SERVICE' }),
          existingLine({ id: LINE_D, sequence: 4, item_type: 'MATERIAL' }),
        ],
      }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_B, LINE_D, LINE_A, LINE_C] }); // MATERIAL, MATERIAL, SERVICE, SERVICE

    expect(res.status).toBe(200);
    const sequenceOf = (id: string) =>
      mockPrisma.jobLineItem.update.mock.calls.find((c) => c[0].where.id === id)?.[0].data.sequence;
    expect(sequenceOf(LINE_B)).toBe(1);
    expect(sequenceOf(LINE_D)).toBe(2);
    expect(sequenceOf(LINE_A)).toBe(3);
    expect(sequenceOf(LINE_C)).toBe(4);
  });

  it('blocks reordering on a service-plan visit job → 400, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', jobLineItems: threeLines() }),
    );
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_A] });
    expect(res.status).toBe(404);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  // ─── RBAC: reorder is gated `update` Job — the SAME gate PATCH .../:lineId (updateLine) uses ───
  it('DISPATCHER (unconditional update Job) can reorder', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('dispatcher'))
      .send({ order: [LINE_C, LINE_B, LINE_A] });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalledTimes(3);
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('technician'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN granted "Edit own jobs" (update Job, OWN_JOB) can reorder on OWN job', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow → true

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('technician'))
      .send({ order: [LINE_C, LINE_A, LINE_B] });

    expect(res.status).toBe(200);
    expect(mockPrisma.jobLineItem.update).toHaveBeenCalledTimes(3);
  });

  // Mirrors job-lines-pricing-leak.test.ts's ABSENT-vs-visible pattern: a requester granted
  // `update` Job (OWN_JOB) but NOT `read` Invoice must never see unit_cost/markup_percent on
  // the reorder response — the SAME canSeePricing()/stripLinesPricing() gate the list/add/edit
  // endpoints already enforce, applied here to reorderLines's `line` array too.
  it('a low-privilege requester (update Job, no read Invoice) gets unit_cost/markup_percent stripped from the reorder response', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    // Real (non-null) cost data on every line — stripping an already-null field would prove nothing.
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [
          existingLine({ id: LINE_A, sequence: 1, description: 'A', unit_cost: 500, markup_percent: 50 }),
          existingLine({ id: LINE_B, sequence: 2, description: 'B', unit_cost: 300, markup_percent: 40 }),
          existingLine({ id: LINE_C, sequence: 3, description: 'C', unit_cost: 200, markup_percent: 20 }),
        ],
      }),
    );
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow → true

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('technician'))
      .send({ order: [LINE_C, LINE_A, LINE_B] });

    expect(res.status).toBe(200);
    expect(res.body.line).toHaveLength(3);
    (res.body.line as Array<Record<string, unknown>>).forEach((l) => {
      expect(l.unit_cost).toBeUndefined();
      expect(l.markup_percent).toBeUndefined();
    });
    // Work detail (non-cost fields) is preserved, not stripped along with it.
    expect(res.body.line.map((l: { description: string }) => l.description)).toEqual(['C', 'A', 'B']);
  });

  it('TECHNICIAN (granted update Job) still gets 403 on a FOREIGN job, never mutates', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ techId: '99999999-9999-9999-9999-999999999999', jobLineItems: threeLines() }),
    );
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('technician'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });

    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });

  it('SALES has NO update:Job by default → 403 at the route guard, no mutation', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/reorder`)
      .set(authHeader('sales'))
      .send({ order: [LINE_A, LINE_B, LINE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Stage 5/6 (part 2) — Job scope-of-work CRUD (GET/POST/PATCH/DELETE .../scopes).
// Job.scopes is a JSONB array of flat-priced, non-line-item blocks (scopes.ts), mirroring
// Invoice.scopes — but Job needs its OWN GET /:id/scopes route (jobDetailSelect doesn't embed
// job_line_items either, same reason GET /:id/line-items exists). No $transaction wrapping
// (job billing is computed-on-read, never persisted) — a plain prisma.job.update on the
// scopes column.
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/jobs/:id/scopes — list', () => {
  it("returns [] when the job's scopes column is null", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: null }));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toEqual([]);
    expect(res.body.billing).toMatchObject({ total: 0, invoiced: 0, remaining: 0 });
  });

  it("returns the job's scopes array alongside a billing preview", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        scopes: [scopeFixture({ flat_price: 300 })],
        jobLineItems: [{ quantity: 1, unit_price: 100, is_taxable: false }],
      }),
    );

    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].title).toBe('Permit fee');
    // 100 (line) + 300 (scope) = 400.
    expect(res.body.billing).toMatchObject({ total: 400, invoiced: 0, remaining: 400 });
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  // #2053 round 2 guard — withOptionalDefaults (lib/scopes.ts) is estimate-only. A keyless
  // legacy scope block (no is_optional/is_selected, same shape every Job scope has always had)
  // must come back keyless here too: this route runs through the plain asScopeArray, never the
  // estimate-only defaulting helper.
  it('#2053 guard: a keyless scope block stays keyless (withOptionalDefaults never runs here)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixture()] }));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/scopes`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scopes[0]).not.toHaveProperty('is_optional');
    expect(res.body.scopes[0]).not.toHaveProperty('is_selected');
  });
});

describe('POST /api/jobs/:id/scopes — add', () => {
  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({});
  });

  it('ADMIN adds a scope with a flat_price; billing.total includes it', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [{ quantity: 1, unit_price: 100, is_taxable: false }] }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });

    expect(res.status).toBe(201);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes).toHaveLength(1);
    expect(updateArg.data.scopes[0].title).toBe('Permit fee');
    expect(updateArg.data.scopes[0].flat_price).toBe(300);
    expect(typeof updateArg.data.scopes[0].id).toBe('string');
    expect(updateArg.data.scopes[0].id.length).toBeGreaterThan(0);
    // 100 (line) + 300 (scope) = 400.
    expect(res.body.billing.total).toBe(400);
  });

  it('blocks adding a scope on a service-plan visit job → 400, no update', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001' }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan/i);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (empty title) → 400', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('technician'))
      .send({ title: 'x' });
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/jobs/:id/scopes/:idx — update', () => {
  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({});
  });

  it("updates a scope's is_taxable flag; billing recomputes accordingly", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ scopes: [scopeFixture({ flat_price: 300, is_taxable: false })] }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ is_taxable: true });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes[0].is_taxable).toBe(true);
    // Untouched fields are preserved (merge, not replace).
    expect(updateArg.data.scopes[0].flat_price).toBe(300);
    expect(updateArg.data.scopes[0].id).toBe('cc000000-0000-0000-0000-000000000001');
    expect(res.body.billing.total).toBe(300);
  });

  it('404s when idx is out of range, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixture()] }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/5`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Scope not found');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('blocks updating a scope on a service-plan visit job → 400, no update', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', scopes: [scopeFixture()] }),
    );
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(404);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixture()] }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/0`)
      .set(authHeader('technician'))
      .send({ flat_price: 500 });
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/jobs/:id/scopes/:idx — delete', () => {
  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({});
  });

  it('removes a scope; billing.total drops by its flat_price', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        jobLineItems: [{ quantity: 1, unit_price: 100, is_taxable: false }],
        scopes: [scopeFixture({ flat_price: 300 })],
      }),
    );

    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes).toHaveLength(0);
    // 100 (line only) — the deleted scope's 300 no longer contributes.
    expect(res.body.billing.total).toBe(100);
  });

  it('404s when idx is out of range, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixture()] }));
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/9`).set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Scope not found');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('blocks deleting a scope on a service-plan visit job → 400, no update', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', scopes: [scopeFixture()] }),
    );
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: [scopeFixture()] }));
    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/jobs/:id/scopes/reorder — reorder
//
// Closes the Move-up/down lost-update race: a "Move up/down" click used to fire TWO concurrent
// index-addressed PATCH /scopes/:idx requests that swapped two blocks' field content by diffing
// the target order against the current one — each a non-atomic whole-column read-modify-write
// with no locking (and, on the Job side, not even wrapped in a transaction), so whichever
// committed last silently clobbered the other's change from a stale snapshot. This single
// all-or-nothing reorder call — mirrors line-items' own /reorder route exactly — replaces that
// with one read-then-write per request.
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/jobs/:id/scopes/reorder — reorder', () => {
  const SCOPE_A = 'cc000000-0000-0000-0000-000000000001';
  const SCOPE_B = 'cc000000-0000-0000-0000-000000000002';
  const SCOPE_C = 'cc000000-0000-0000-0000-000000000003';

  function threeScopes() {
    return [
      scopeFixture({ id: SCOPE_A, title: 'A', flat_price: 100 }),
      scopeFixture({ id: SCOPE_B, title: 'B', flat_price: 200 }),
      scopeFixture({ id: SCOPE_C, title: 'C', flat_price: 300 }),
    ];
  }

  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({});
  });

  it('a valid full permutation rewrites the WHOLE scopes column in ONE call, content traveling WITH its id (the swap the race used to corrupt)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_C, SCOPE_A, SCOPE_B] });

    expect(res.status).toBe(200);
    // Exactly ONE job.update call — NOT a per-index PATCH loop.
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    const scopeArg = mockPrisma.job.update.mock.calls[0][0].data.scopes;
    expect(scopeArg.map((s: { id: string }) => s.id)).toEqual([SCOPE_C, SCOPE_A, SCOPE_B]);
    // Each block's own content (title/flat_price) travels WITH its id to its new position —
    // never swapped/lost the way the two-concurrent-PATCH race could corrupt it.
    expect(scopeArg[0].title).toBe('C');
    expect(scopeArg[0].flat_price).toBe(300);
    expect(scopeArg[1].title).toBe('A');
    expect(scopeArg[1].flat_price).toBe(100);
    expect(scopeArg[2].title).toBe('B');
    expect(scopeArg[2].flat_price).toBe(200);
    // billing.total is unaffected by mere reordering (100+200+300 = 600 either way).
    expect(res.body.billing.total).toBe(600);
    expect(res.body.scopes.map((s: { id: string }) => s.id)).toEqual([SCOPE_C, SCOPE_A, SCOPE_B]);
  });

  it('400s when the submitted order is missing one of the current scope ids, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B] }); // SCOPE_C missing
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it("400s when the submitted order contains an id that is not one of this job's scopes, no mutation", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));
    const FOREIGN_ID = 'ff000000-0000-0000-0000-000000000099';
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B, FOREIGN_ID] });
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('400s when the submitted order contains a duplicate id, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_A, SCOPE_B] }); // SCOPE_C missing, SCOPE_A duplicated
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('blocks reordering on a service-plan visit job → 400, no mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ sourcePlanId: 'plan-uuid-0000-0000-0000-000000000001', scopes: threeScopes() }),
    );
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(400);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('tenant isolation: cross-org job id → 404', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_A] });
    expect(res.status).toBe(404);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('a bare TECHNICIAN is refused on a job they neither created nor were assigned -> 403, no mutation', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('technician'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('TECHNICIAN granted "Edit own jobs" (update Job, OWN_JOB) can reorder on OWN job', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ scopes: threeScopes() }));
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow → true

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('technician'))
      .send({ order: [SCOPE_C, SCOPE_A, SCOPE_B] });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
  });

  // Mirrors job-lines-pricing-leak.test.ts's ABSENT-vs-visible pattern: a requester granted
  // `update` Job (OWN_JOB) but NOT `read` Invoice must never see internal_cost on the reorder
  // response — the SAME canSeePricing()/stripScopeCost() gate the list/add/update endpoints
  // already enforce, applied here to reorderScopes's response too.
  it('a low-privilege requester (update Job, no read Invoice) gets internal_cost stripped from the reorder response', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({
        scopes: [
          scopeFixture({ id: SCOPE_A, title: 'A', internal_cost: 50 }),
          scopeFixture({ id: SCOPE_B, title: 'B', internal_cost: 75 }),
        ],
      }),
    );
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // canAccessRow → true

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('technician'))
      .send({ order: [SCOPE_B, SCOPE_A] });

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(2);
    (res.body.scopes as Array<Record<string, unknown>>).forEach((s) => {
      expect(s.internal_cost).toBeUndefined();
    });
    expect(res.body.scopes.map((s: { title: string }) => s.title)).toEqual(['B', 'A']);
  });

  it('TECHNICIAN (granted update Job) still gets 403 on a FOREIGN job, never mutates', async () => {
    mockAuthAs('technician');
    const OWN_JOB = { assignees: { some: { user_id: '{{userId}}' } } };
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
      { action: 'update', subject: 'Job', conditions: OWN_JOB },
      // `manage_lines Job` is the gate on the line-item and scope routes since the
      // technician-ownership split (PR 2). It is granted here alongside `update Job`, under the
      // same condition, because that is exactly how the real grants pair them - defaultGrants.ts
      // for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing ones. The seam
      // itself (one action without the other) is pinned in job-manage-lines-routes.test.ts.
      { action: 'manage_lines', subject: 'Job', conditions: OWN_JOB },
    ] as any);
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ techId: '99999999-9999-9999-9999-999999999999', scopes: threeScopes() }),
    );
    mockPrisma.job.findFirst.mockResolvedValue(null); // canAccessRow → false

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('technician'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('SALES has NO update:Job by default → 403, no mutation', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('sales'))
      .send({ order: [SCOPE_A, SCOPE_B, SCOPE_C] });
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Race safety — addScope/updateScope/deleteScope/reorderScopes must re-read Job.scopes FRESH
// inside a prisma.$transaction immediately before writing, never trust loadGuardedJob's
// once-per-request snapshot. Without this, two concurrent scope mutations on the same job (e.g.
// an addScope racing a reorderScopes, or two reorderScopes calls) can race: whichever
// prisma.job.update commits second silently overwrites the other's change using its own stale
// in-memory copy, permanently losing data. Mirrors invoice-lines.controller.ts's four scope
// handlers, which already wrap read-validate-write in prisma.$transaction with a fresh
// tx.invoice.findUnique read happening INSIDE the transaction immediately before the write.
// ════════════════════════════════════════════════════════════════════════════
describe('Scope mutations re-read Job.scopes fresh inside a transaction (race safety)', () => {
  const SCOPE_A = 'cc000000-0000-0000-0000-000000000001';
  const SCOPE_B = 'cc000000-0000-0000-0000-000000000002';
  const SCOPE_C = 'cc000000-0000-0000-0000-000000000003';
  const SCOPE_D = 'cc000000-0000-0000-0000-000000000004';

  function scopeA() {
    return scopeFixture({ id: SCOPE_A, title: 'A', flat_price: 100 });
  }
  function scopeB() {
    return scopeFixture({ id: SCOPE_B, title: 'B', flat_price: 200 });
  }
  function scopeC() {
    return scopeFixture({ id: SCOPE_C, title: 'C', flat_price: 300 });
  }
  function scopeD() {
    return scopeFixture({ id: SCOPE_D, title: 'D', flat_price: 400 });
  }

  beforeEach(() => {
    mockPrisma.job.update.mockResolvedValue({});
  });

  // ─── The required reorderScopes race test ───
  it('reorderScopes 400s (mismatched id set) when a concurrent write landed between the guard load and the transaction, instead of blindly overwriting with stale data', async () => {
    mockAuthAs('admin');
    // loadGuardedJob's snapshot sees [A, B, C] — the client built its reorder request off this
    // view. But by the time the transaction's fresh read runs, a concurrent addScope has already
    // landed and persisted [A, B, C, D] — a DIFFERENT array than loadGuardedJob originally saw.
    mockScopeReads([scopeA(), scopeB(), scopeC()], [scopeA(), scopeB(), scopeC(), scopeD()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_C, SCOPE_A, SCOPE_B] }); // built from the STALE 3-item view

    // Correctly rejected against the FRESH id set (4 items) — not silently applied against the
    // stale 3-item snapshot, which would have dropped D from the job entirely.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current scope ids/i);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    // Proves the fresh in-tx read actually happened (guard load + tx read = 2 calls).
    expect(mockPrisma.job.findUnique).toHaveBeenCalledTimes(2);
  });

  it('reorderScopes still succeeds and re-validates against the FRESH set when nothing raced (no false-positive rejection)', async () => {
    mockAuthAs('admin');
    mockScopeReads([scopeA(), scopeB(), scopeC()], [scopeA(), scopeB(), scopeC()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_C, SCOPE_A, SCOPE_B] });

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findUnique).toHaveBeenCalledTimes(2);
  });

  // ─── addScope/updateScope/deleteScope genuinely use tx.job.findUnique + tx.job.update ───
  it('addScope reads fresh inside the transaction and preserves a concurrently-added scope the guard-load snapshot never saw', async () => {
    mockAuthAs('admin');
    // loadGuardedJob's snapshot only saw [A]. A concurrent addScope already landed [A, B] by the
    // time this request's transaction runs its fresh read.
    mockScopeReads([scopeA()], [scopeA(), scopeB()]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Fresh read (guard + in-tx) — proves it did NOT just reuse loadGuardedJob's stale snapshot.
    expect(mockPrisma.job.findUnique).toHaveBeenCalledTimes(2);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    // The concurrently-added B survives — a stale-snapshot write would have silently dropped it,
    // persisting only [A, new] and losing B.
    expect(updateArg.data.scopes.map((s: { id: string }) => s.id)).toEqual([SCOPE_A, SCOPE_B, expect.any(String)]);
    expect(updateArg.data.scopes).toHaveLength(3);
  });

  it('updateScope validates idx against the FRESH read, not the stale guard snapshot — 404s when a concurrent delete shrank the array', async () => {
    mockAuthAs('admin');
    // Guard snapshot saw 2 scopes (idx 1 valid there); a concurrent delete already shrank the
    // job to 1 scope by the time the fresh in-tx read runs — idx 1 is now out of range.
    mockScopeReads([scopeA(), scopeB()], [scopeA()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/scopes/1`)
      .set(authHeader('admin'))
      .send({ flat_price: 999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Scope not found');
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findUnique).toHaveBeenCalledTimes(2);
  });

  it('deleteScope reads fresh inside the transaction and preserves a concurrently-added scope while deleting the correct fresh index', async () => {
    mockAuthAs('admin');
    // Guard snapshot saw [A] only (idx 0 = A). A concurrent addScope landed B before this
    // request's fresh read, giving [A, B] — deleting idx 0 must still remove A (not B) and must
    // keep B, not the stale-snapshot result of an empty array.
    mockScopeReads([scopeA()], [scopeA(), scopeB()]);

    const res = await request(app).delete(`/api/jobs/${JOB_ID}/scopes/0`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findUnique).toHaveBeenCalledTimes(2);
    const updateArg = mockPrisma.job.update.mock.calls[0][0];
    expect(updateArg.data.scopes.map((s: { id: string }) => s.id)).toEqual([SCOPE_B]);
  });
});

// #2053 AC10 — Job's own line schema (separate from Estimate's) stays estimate-blind too.
describe('#2053 AC10 — job line schema stays estimate-blind', () => {
  it("job-lines.controller's own addLineSchema strips is_optional/is_selected", () => {
    const parsed = jobAddLineSchema.parse({
      description: 'x', quantity: 1, unit_price: 50, is_taxable: true, is_optional: true, is_selected: false,
    });
    expect(parsed).not.toHaveProperty('is_optional');
    expect(parsed).not.toHaveProperty('is_selected');
  });
});
