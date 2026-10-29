/**
 * Estimate line-item + scope-of-work CRUD (v12 unified line-items, plan §2a).
 *
 * Covers estimate-lines.controller.ts's core behavior: recompute-and-persist totals math
 * (subtotal/tax_amount/total_amount/discount_amount kept in sync on the parent Estimate after
 * every mutation — the reason this controller mirrors invoice-lines.controller.ts's persistence
 * model rather than job-lines.controller.ts's computed-on-read-only one), the DRAFT/SENT/PENDING
 * editable-status guard, and the reorder all-or-nothing validation. Pricing-leak coverage lives
 * separately in estimate-pricing-leak.test.ts.
 *
 * Harness mirrors job-lines.test.ts / estimate-pricing-leak.test.ts: supertest against `app`,
 * prisma fully mocked (setup.ts), a $transaction shim that hands the callback the same top-level
 * mocks as `tx`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Request, Response } from 'express';
import app from '../app';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { loadGuardedEstimate } from '../controllers/estimate-lines.controller';

// setup.ts's storage.from is a mockReturnValue of ONE shared object — grab the handle (R5f
// deleteLine/deleteScope Storage-cleanup coverage below).
const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  remove: ReturnType<typeof vi.fn>;
};

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  // R5f — deleteScope's in-tx best-effort photo-row cleanup (compound estimate_id+scope_id match).
  estimateScopePhoto: {
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  // R5f — deleteLine's pre-transaction photo-path fetch (top-level, NOT the tx proxy: the FK
  // cascade removes the rows, this is only reading storage_paths for the post-delete sweep).
  $transaction: ReturnType<typeof vi.fn>;
};

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: {
          findUnique: mockPrisma.estimate.findUnique,
          update: mockPrisma.estimate.update,
        },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          create: mockPrisma.estimateLineItem.create,
          update: mockPrisma.estimateLineItem.update,
          deleteMany: mockPrisma.estimateLineItem.deleteMany,
        },
        estimateScopePhoto: {
          findMany: mockPrisma.estimateScopePhoto.findMany,
          deleteMany: mockPrisma.estimateScopePhoto.deleteMany,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';
const LINE_ID_2 = 'aa000000-0000-0000-0000-000000000004';

function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
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
    ...over,
  };
}

function scope(over: Record<string, unknown> = {}) {
  return {
    id: 'cc000000-0000-0000-0000-000000000003',
    title: 'Permit fee',
    body: '',
    flat_price: 100,
    is_taxable: true,
    internal_cost: null,
    ...over,
  };
}

// estimate-lines.controller's loadGuardedEstimate select shape. `version`/`subtotal`/
// `tax_amount`/`total_amount`/`discount_amount` are the PRE-mutation snapshot recomputeAndPersist
// diffs against (finding B1's material-change ceremony); `invoices`/`lockOnSend` feed
// isEstimateLocked (finding B1's send-lock check). Defaults are inert for the (default-DRAFT)
// pre-existing tests below — the lock/ceremony guard only engages when status !== 'DRAFT'.
function guardRow({
  status = 'DRAFT' as string,
  lineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  scopes = null as unknown[] | null,
  tax_rate = 0.1 as number,
  version = 1 as number,
  subtotal = 1000 as number,
  tax_amount = 100 as number,
  total_amount = 1100 as number,
  discount_amount = 0 as number,
  invoices = [] as { status: string }[],
  lockOnSend = false as boolean,
} = {}) {
  return {
    id: ESTIMATE_ID,
    status,
    version,
    tax_rate,
    discount_type: null,
    discount_value: null,
    subtotal,
    tax_amount,
    total_amount,
    discount_amount,
    scopes,
    organization: { lock_on_send: lockOnSend },
    invoices,
    line_items: lineItems,
  };
}

function respondingEstimate() {
  return { ...ESTIMATE_FIXTURE, id: ESTIMATE_ID, line_items: [], scopes: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockAuthAs('admin'); // ADMIN bypasses CASL entirely — canDo/canAccessRow/canSeePricing all pass.
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estimates/:id/line-items
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/line-items', () => {
  it('creates a line and recomputes the parent estimate totals (folding in an existing taxable scope)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ scopes: [scope({ flat_price: 100, is_taxable: true })], tax_rate: 0.1 }),
    );
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    // Post-create line set the recompute reads back.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 2, unit_price: 100, line_total: 200 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Compressor', quantity: 2, unit_price: 100, is_taxable: true });

    expect(res.status).toBe(201);
    expect(mockPrisma.estimateLineItem.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrisma.estimateLineItem.create.mock.calls[0][0];
    expect(createArg.data.sequence).toBe(1);
    expect(createArg.data.line_total).toBe(200);

    // Recompute-and-persist: line (200, taxable) + scope (100, taxable) = subtotal 300, tax 10% = 30.
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.subtotal).toBe(300);
    expect(totalsArg.data.tax_amount).toBe(30);
    expect(totalsArg.data.total_amount).toBe(330);
  });

  it('next sequence = max(existing) + 1, robust to a prior delete leaving a gap', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line({ sequence: 3 }), line({ id: LINE_ID_2, sequence: 5 })] }),
    );
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    const createArg = mockPrisma.estimateLineItem.create.mock.calls[0][0];
    expect(createArg.data.sequence).toBe(6);
  });

  it('rejects adding a line to a frozen (WON) estimate', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'WON' }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimateLineItem.create).not.toHaveBeenCalled();
  });

  it('404s when the estimate does not exist', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/nonexistent/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(404);
  });

  it('rejects a description over the shared line-description cap', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'x'.repeat(LINE_DESCRIPTION_MAX + 1), quantity: 1, unit_price: 50 });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimateLineItem.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/estimates/:id/line-items/:lineId
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/estimates/:id/line-items/:lineId', () => {
  it('updates a line and recomputes totals', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()] }));
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 3, line_total: 3000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    const updateArg = mockPrisma.estimateLineItem.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: LINE_ID, estimate_id: ESTIMATE_ID });
    expect(updateArg.data.quantity).toBe(3);
    expect(updateArg.data.line_total).toBe(3000);

    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.subtotal).toBe(3000);
  });

  it('404s for an unknown lineId', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()] }));

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/nonexistent-line`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(404);
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/estimates/:id/line-items/:lineId
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/estimates/:id/line-items/:lineId', () => {
  it('deletes a line and recomputes totals from the remaining set', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line(), line({ id: LINE_ID_2, sequence: 2 })] }),
    );
    mockPrisma.estimateLineItem.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ id: LINE_ID_2, sequence: 2 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.deleteMany).toHaveBeenCalledWith({
      where: { id: LINE_ID, estimate_id: ESTIMATE_ID },
    });
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.subtotal).toBe(1000);
  });

  it('404s when the line does not belong to this estimate', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()] }));
    mockPrisma.estimateLineItem.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/line-items/nonexistent-line`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  // #2029 — a line item carries no uploaded photos, so deleting one touches Storage not at all.
  // Its only image is the price-book item's own `image_url` attribute, which the line item does
  // not own and must not delete.
  it('touches Storage not at all — a line item has no photos of its own', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()] }));
    mockPrisma.estimateLineItem.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/estimates/:id/line-items/reorder
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/estimates/:id/line-items/reorder', () => {
  it('persists a full reorder atomically', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line({ sequence: 1 }), line({ id: LINE_ID_2, sequence: 2 })] }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line(), line({ id: LINE_ID_2 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_ID_2, LINE_ID] });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.estimateLineItem.update).toHaveBeenNthCalledWith(1, {
      where: { id: LINE_ID_2, estimate_id: ESTIMATE_ID },
      data: { sequence: 1 },
    });
  });

  it('400s (no writes) when the order is missing an id', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line({ sequence: 1 }), line({ id: LINE_ID_2, sequence: 2 })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_ID] });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scopes of work
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id/scopes', () => {
  it('lists the estimate scopes', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}/scopes`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].title).toBe('Permit fee');
  });
});

describe('POST /api/estimates/:id/scopes', () => {
  it('adds a scope and folds its flat_price into the recomputed totals', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()], tax_rate: 0.1, scopes: [] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line()]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 100, is_taxable: true });

    expect(res.status).toBe(201);
    // First estimate.update() call is the scope-array push.
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes).toHaveLength(1);
    expect(scopeWrite.data.scopes[0].flat_price).toBe(100);
    // Second call is recomputeAndPersist: line (1000) + scope (100), both taxable, 10% tax.
    const totalsWrite = mockPrisma.estimate.update.mock.calls[1][0];
    expect(totalsWrite.data.subtotal).toBe(1100);
    expect(totalsWrite.data.tax_amount).toBe(110);
  });

  it('rejects adding a scope to a frozen (ARCHIVED) estimate', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'ARCHIVED' }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 100 });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/estimates/:id/scopes/:idx', () => {
  it('404s for an out-of-range idx', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/5`)
      .set(authHeader('admin'))
      .send({ flat_price: 200 });

    expect(res.status).toBe(404);
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/estimates/:id/scopes/reorder', () => {
  it('400s (no writes) when the order does not match the current scope id set', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ scopes: [scope({ id: 's1' }), scope({ id: 's2' })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: ['s1'] });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/estimates/:id/scopes/:idx', () => {
  it('deletes a scope and triggers a totals recompute', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line()], tax_rate: 0.1, scopes: [scope({ flat_price: 100, is_taxable: true })] }),
    );
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line()]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // First estimate.update() call is the scope-array write — the removed scope must be gone
    // from the persisted array itself, independent of the (separately-tested) totals recompute.
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes).toEqual([]);
    // A second call (recomputeAndPersist) always follows a successful delete.
    expect(mockPrisma.estimate.update).toHaveBeenCalledTimes(2);
  });

  // R5f — no DB FK ties EstimateScopePhoto to a single scope block, so deleteScope must explicitly
  // remove its photo rows (compound estimate_id+scope_id — never scope_id alone) AND best-effort
  // clean up their Storage objects.
  it("deletes the removed scope's photo rows (compound estimate_id+scope_id) and best-effort removes their Storage objects", async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([{ storage_path: 'org/estimate_scope/est/cc/1-a.jpg' }]);
    mockPrisma.estimateScopePhoto.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateScopePhoto.findMany).toHaveBeenCalledWith({
      where: { estimate_id: ESTIMATE_ID, scope_id: scope().id },
      select: { storage_path: true },
    });
    expect(mockPrisma.estimateScopePhoto.deleteMany).toHaveBeenCalledWith({
      where: { estimate_id: ESTIMATE_ID, scope_id: scope().id },
    });
    expect(storage.remove).toHaveBeenCalledWith(['org/estimate_scope/est/cc/1-a.jpg']);
  });

  it('still deletes the scope when the photo Storage remove fails (log-warn, not 500)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([{ storage_path: 'org/x/1-a.jpg' }]);
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'gone already' } });
    mockPrisma.estimateScopePhoto.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('skips the Storage call entirely when the removed scope had no photos', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([]);
    mockPrisma.estimateScopePhoto.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding B1 — send-lock check + material-change ceremony on every mutating handler
// ════════════════════════════════════════════════════════════════════════════
describe('B1: send-lock check on every mutating handler', () => {
  it('addLine rejects (400 locked) when the deposit is already PAID', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', invoices: [{ status: 'PAID' }] }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimateLineItem.create).not.toHaveBeenCalled();
  });

  it('updateLine rejects (400 locked) when the org lock_on_send toggle is ON', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', lineItems: [line()], lockOnSend: true }));

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });

  it('deleteLine rejects (400 locked) when the deposit is already PAID', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', lineItems: [line()], invoices: [{ status: 'PAID' }] }));

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimateLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it('reorderLines rejects (400 locked) when the org lock_on_send toggle is ON', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'SENT', lineItems: [line(), line({ id: LINE_ID_2, sequence: 2 })], lockOnSend: true }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_ID_2, LINE_ID] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });

  it('addScope rejects (400 locked) when the deposit is already PAID', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', invoices: [{ status: 'PAID' }] }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('updateScope rejects (400 locked) when the org lock_on_send toggle is ON', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', scopes: [scope()], lockOnSend: true }));

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 200 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('reorderScopes rejects (400 locked) when the deposit is already PAID', async () => {
    const scopeIdA = 'cc000000-0000-0000-0000-000000000010';
    const scopeIdB = 'cc000000-0000-0000-0000-000000000011';
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'SENT', scopes: [scope({ id: scopeIdA }), scope({ id: scopeIdB })], invoices: [{ status: 'PAID' }] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [scopeIdB, scopeIdA] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('deleteScope rejects (400 locked) when the org lock_on_send toggle is ON', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'SENT', scopes: [scope()], lockOnSend: true }));

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('a DRAFT estimate is never locked, even with the org lock_on_send toggle ON', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'DRAFT', lockOnSend: true }));
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(201);
  });
});

describe('D12: PENDING material edit voids the signature (supersedes hard lock)', () => {
  it('updateLine on an unlocked PENDING estimate bumps version, voids the signature, and reverts to SENT when totals actually change', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({
        status: 'PENDING', tax_rate: 0, version: 1,
        lineItems: [line({ quantity: 1, unit_price: 1000, line_total: 1000 })],
        subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 2, unit_price: 1000, line_total: 2000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.total_amount).toBe(2000);
    expect(totalsArg.data.status).toBe('SENT');
    expect(totalsArg.data.signature_data).toBeNull();
    expect(totalsArg.data.signature_at).toBeNull();
    expect(totalsArg.data.version).toBe(2);
    expect(totalsArg.data.modified_after_send).toBe(true);
    expect(totalsArg.data.public_token).toBeNull();
  });

  it('updateLine on an unlocked PENDING estimate leaves the signature and status intact when the edit does not change totals', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({
        status: 'PENDING', tax_rate: 0, version: 1,
        lineItems: [line({ quantity: 1, unit_price: 1000, line_total: 1000 })],
        subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    // Description-only edit -- the recomputed line set is numerically IDENTICAL to the
    // pre-mutation snapshot, so nothing material changed and the signature must survive.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 1, unit_price: 1000, line_total: 1000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'Updated description only' });

    expect(res.status).toBe(200);
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.total_amount).toBe(1000);
    expect(totalsArg.data.status).toBeUndefined();
    expect(totalsArg.data.signature_data).toBeUndefined();
    expect(totalsArg.data.signature_at).toBeUndefined();
    expect(totalsArg.data.version).toBeUndefined();
    expect(totalsArg.data.modified_after_send).toBeUndefined();
    expect(totalsArg.data.public_token).toBeUndefined();
  });

  it('updateLine rejects (400 locked) on a PENDING estimate once the deposit is already PAID', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'PENDING', lineItems: [line()], invoices: [{ status: 'PAID' }] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });
});

describe('B1: material-change ceremony (version bump / modified_after_send / public_token null)', () => {
  it('updateLine on an unlocked SENT estimate bumps version + flags modified_after_send when totals actually change', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({
        status: 'SENT', tax_rate: 0, version: 1,
        lineItems: [line({ quantity: 1, unit_price: 1000, line_total: 1000 })],
        subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    // Recompute reads back the CHANGED line (qty 2 → line_total 2000) — totals now differ from
    // the pre-mutation snapshot (total_amount: 1000) above.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 2, unit_price: 1000, line_total: 2000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.total_amount).toBe(2000);
    expect(totalsArg.data.version).toBe(2);
    expect(totalsArg.data.modified_after_send).toBe(true);
    expect(totalsArg.data.public_token).toBeNull();
  });

  it('updateLine on an unlocked SENT estimate does NOT bump version when the edit does not change totals', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({
        status: 'SENT', tax_rate: 0, version: 1,
        lineItems: [line({ quantity: 1, unit_price: 1000, line_total: 1000 })],
        subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    // Description-only edit — the recomputed line set is numerically IDENTICAL to the
    // pre-mutation snapshot, so nothing material changed.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 1, unit_price: 1000, line_total: 1000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ description: 'Updated description only' });

    expect(res.status).toBe(200);
    const totalsArg = mockPrisma.estimate.update.mock.calls[0][0];
    expect(totalsArg.data.total_amount).toBe(1000);
    expect(totalsArg.data.version).toBeUndefined();
    expect(totalsArg.data.modified_after_send).toBeUndefined();
    expect(totalsArg.data.public_token).toBeUndefined();
  });

  it('addScope on an unlocked SENT estimate also bumps version when the new flat_price changes totals (shared ceremony)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({
        status: 'SENT', tax_rate: 0, version: 1,
        lineItems: [line({ quantity: 1, unit_price: 1000, line_total: 1000 })], scopes: [],
        subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      }),
    );
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 1, unit_price: 1000, line_total: 1000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 200, is_taxable: true });

    expect(res.status).toBe(201);
    // Second estimate.update() call is recomputeAndPersist (first is the scope-array push).
    const totalsArg = mockPrisma.estimate.update.mock.calls[1][0];
    expect(totalsArg.data.total_amount).toBe(1200);
    expect(totalsArg.data.version).toBe(2);
    expect(totalsArg.data.modified_after_send).toBe(true);
    expect(totalsArg.data.public_token).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding B6 — race-safe re-read of the FRESH line set INSIDE the transaction
// ════════════════════════════════════════════════════════════════════════════
describe('B6: race-safe fresh re-read inside the transaction', () => {
  it('addLine computes nextSequence off the tx-FRESH line set, not the pre-transaction snapshot', async () => {
    // Outer loadGuardedEstimate read: STALE — only 1 line existed when the request started.
    mockPrisma.estimate.findUnique.mockResolvedValueOnce(guardRow({ lineItems: [line({ sequence: 1 })] }));
    // Every subsequent read inside the tx (loadFreshLines, then recomputeAndPersist's scopes
    // read): FRESH — a concurrent addLine committed a second line (sequence 2) in between.
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line({ sequence: 1 }), line({ id: LINE_ID_2, sequence: 2 })] }),
    );
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ sequence: 1 }), line({ id: LINE_ID_2, sequence: 2 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New item', quantity: 1, unit_price: 50 });

    const createArg = mockPrisma.estimateLineItem.create.mock.calls[0][0];
    // Fresh max(1, 2) + 1 = 3 — NOT the stale snapshot's max(1) + 1 = 2, which would collide
    // with the concurrently-inserted sequence-2 line.
    expect(createArg.data.sequence).toBe(3);
  });

  it('updateLine merges fallback fields off the tx-FRESH line, not the pre-transaction snapshot', async () => {
    // Outer read: STALE quantity (1).
    mockPrisma.estimate.findUnique.mockResolvedValueOnce(guardRow({ lineItems: [line({ quantity: 1, unit_price: 100 })] }));
    // tx-FRESH: a concurrent edit already raised quantity to 5.
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line({ quantity: 5, unit_price: 100 })] }));
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 5, unit_price: 200, line_total: 1000 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    // Body omits quantity — the merge fallback must read the FRESH quantity (5), not the stale
    // outer snapshot's quantity (1).
    await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 200 });

    const updateArg = mockPrisma.estimateLineItem.update.mock.calls[0][0];
    expect(updateArg.data.quantity).toBe(5);
    expect(updateArg.data.line_total).toBe(1000); // 5 * 200, not the stale 1 * 200 = 200
  });

  it('reorderLines validates the submitted order against the tx-FRESH id set, not the pre-transaction snapshot', async () => {
    // Outer read: STALE — only 1 line existed when the request started.
    mockPrisma.estimate.findUnique.mockResolvedValueOnce(guardRow({ lineItems: [line({ sequence: 1 })] }));
    // tx-FRESH: a concurrent addLine committed a second line in between.
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line({ sequence: 1 }), line({ id: LINE_ID_2, sequence: 2 })] }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line(), line({ id: LINE_ID_2 })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    // Submits BOTH ids — validating against the STALE 1-line outer snapshot would 400 this as
    // "extra id"; validating against the tx-FRESH 2-line set (the fix) accepts it.
    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_ID_2, LINE_ID] });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding M2 — promoted legacy scope: null scope_name/scope_notes so stale text can't resurrect
// ════════════════════════════════════════════════════════════════════════════
describe('M2: legacy scope_name/scope_notes cleared on promotion / delete-to-zero', () => {
  it('addScope nulls scope_name/scope_notes when this is the FIRST scope (promoting the lazy-backfill placeholder)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Scope of work', body: 'Promoted from legacy text' });

    expect(res.status).toBe(201);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scope_name).toBeNull();
    expect(scopeWrite.data.scope_notes).toBeNull();
  });

  it('addScope does NOT touch scope_name/scope_notes when scopes[] was already non-empty (not a promotion)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope()] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Additional scope', flat_price: 50 });

    expect(res.status).toBe(201);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect('scope_name' in scopeWrite.data).toBe(false);
    expect('scope_notes' in scopeWrite.data).toBe(false);
  });

  it('deleteScope nulls scope_name/scope_notes when this delete empties scopes[] back to zero', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line()], scopes: [scope()] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line()]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes).toEqual([]);
    expect(scopeWrite.data.scope_name).toBeNull();
    expect(scopeWrite.data.scope_notes).toBeNull();
  });

  it('deleteScope does NOT touch scope_name/scope_notes when scopes[] remains non-empty', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ lineItems: [line()], scopes: [scope({ id: 's1' }), scope({ id: 's2' })] }),
    );
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line()]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const scopeWrite = mockPrisma.estimate.update.mock.calls[0][0];
    expect(scopeWrite.data.scopes).toHaveLength(1);
    expect('scope_name' in scopeWrite.data).toBe(false);
    expect('scope_notes' in scopeWrite.data).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #2045 (R6) — loadGuardedEstimate's optional `estimateId` argument
// ════════════════════════════════════════════════════════════════════════════
describe('loadGuardedEstimate — optional estimateId argument (widened for #2045)', () => {
  function fakeRes() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  }

  it('defaults to the route :id param when no override is supplied — every pre-#2045 caller (addLine, updateLine, the photo routes, ...) is unaffected', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    const req = { params: { id: ESTIMATE_ID }, user: TEST_USERS.admin } as unknown as Request;
    const res = fakeRes();

    const result = await loadGuardedEstimate(req, res);

    expect(result?.id).toBe(ESTIMATE_ID);
    expect(mockPrisma.estimate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: ESTIMATE_ID }) }),
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('uses the explicit override id instead of the route :id param when one is supplied (#2045 — the narrow price-book-image endpoint\'s :id is an ITEM id, not an estimate id)', async () => {
    const OVERRIDE_ESTIMATE_ID = 'f0000000-0000-0000-0000-00000000dead';
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...guardRow(), id: OVERRIDE_ESTIMATE_ID });
    const req = {
      params: { id: 'b1000000-0000-0000-0000-000000002045' }, // a PRICE BOOK ITEM id, not this estimate's id
      user: TEST_USERS.admin,
    } as unknown as Request;
    const res = fakeRes();

    const result = await loadGuardedEstimate(req, res, OVERRIDE_ESTIMATE_ID);

    expect(result?.id).toBe(OVERRIDE_ESTIMATE_ID);
    expect(mockPrisma.estimate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: OVERRIDE_ESTIMATE_ID }) }),
    );
  });
});
