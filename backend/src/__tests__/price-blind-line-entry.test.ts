/**
 * SERV10X-38 Task 4 (D13c) — price book toggle + server-resolved line price.
 *
 * A price-blind requester (no `read Invoice`, e.g. a bare TECHNICIAN with the `update Job`
 * capability) can add a job line item, but must never dictate its own price: the server
 * resolves unit_price/unit_cost from the referenced PriceBookItem, or defaults to 0 for a
 * free-text line with no catalog reference. A price-visible requester keeps the pre-existing
 * contract — unit_price is required and taken verbatim from the client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { addLineSchema, updateLineSchema } from '../controllers/job-lines.controller';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, PRICE_BOOK_ITEM_FIXTURE, mockRoleGrantsWithout, mockScopedFindFirst, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

describe('addLineSchema / updateLineSchema — D13c shape', () => {
  it('addLineSchema parses without unit_price (price-blind path)', () => {
    const result = addLineSchema.safeParse({ description: 'Filter', quantity: 1 });
    expect(result.success).toBe(true);
  });

  it('addLineSchema still accepts an explicit unit_price (price-visible path)', () => {
    const result = addLineSchema.safeParse({ description: 'Filter', quantity: 1, unit_price: 40 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.unit_price).toBe(40);
  });

  it('addLineSchema rejects a quantity over the overflow guard (100000)', () => {
    const result = addLineSchema.safeParse({ description: 'x', quantity: 100001, unit_price: 1 });
    expect(result.success).toBe(false);
  });

  it('updateLineSchema rejects a quantity over the overflow guard (100000)', () => {
    const result = updateLineSchema.safeParse({ quantity: 100001 });
    expect(result.success).toBe(false);
  });
});

describe('POST /api/jobs/:id/line-items — D13c price resolution', () => {
  const mockPrisma = prisma as unknown as {
    job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    jobLineItem: { create: ReturnType<typeof vi.fn> };
    priceBookItem: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const JOB_ID = JOB_FIXTURE.id;

  function jobRow() {
    return {
      id: JOB_ID,
      status: 'SUBMITTED',
      source_plan_id: null,
      job_number: 'J00001',
      customer: { tax_exempt: false },
      assignees: [{ user_id: TEST_USERS.technician.id }],
      // CREATED BY the technician, not merely assigned to them. Since the technician-ownership spec
      // (Part C) `manage_lines Job` follows creation, so an assigned non-creator is 403'd at the
      // door and the D13c price-resolution rules below would never execute - the suite would be
      // green while covering nothing. The principal has to be one who can actually reach the route.
      created_by_id: TEST_USERS.technician.id,
      estimate: null,
      linked_estimates: [],
      job_line_items: [],
      invoices: [],
      scopes: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.$transaction.mockImplementation(async (fn: unknown) => {
      if (typeof fn === 'function') return (fn as (tx: unknown) => unknown)(mockPrisma);
      return Promise.all(fn as Promise<unknown>[]);
    });
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    // canActOnRow's scope probe (separate from findUnique above). Really evaluates the fragment
    // rather than answering truthy to everything, so the 201s below are earned by the fixture's
    // `created_by_id` and not by the mock - see matchesScopeWhere in helpers.ts.
    mockScopedFindFirst(mockPrisma.job.findFirst, { ...jobRow(), organization_id: ALPHA_ORG_ID });
    mockPrisma.jobLineItem.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'new-line', ...data }),
    );
  });

  it('a price-blind technician referencing a catalog item gets server-resolved price + cost, not their own submission', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockPrisma.priceBookItem.findFirst.mockResolvedValue({
      unit_price: PRICE_BOOK_ITEM_FIXTURE.unit_price,
      unit_cost: PRICE_BOOK_ITEM_FIXTURE.unit_cost,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({
        description: 'Deadbolt Lock',
        quantity: 2,
        unit_price: 999999, // must be ignored — a price-blind submission is never trusted
        price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id,
      });

    expect(res.status).toBe(201);
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(Number(createArg.data.unit_price)).toBe(PRICE_BOOK_ITEM_FIXTURE.unit_price);
    expect(Number(createArg.data.unit_cost)).toBe(PRICE_BOOK_ITEM_FIXTURE.unit_cost);
    expect(Number(createArg.data.line_total)).toBe(PRICE_BOOK_ITEM_FIXTURE.unit_price * 2);
    // Response strip (stripLinePricing) still hides both from this requester.
    expect(res.body.line).not.toHaveProperty('unit_price');
    expect(res.body.line).not.toHaveProperty('unit_cost');
  });

  it('a price-blind technician with no price_book_item_id gets a free line priced at 0', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Extra labor', quantity: 1 });

    expect(res.status).toBe(201);
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(Number(createArg.data.unit_price)).toBe(0);
    expect(Number(createArg.data.line_total)).toBe(0);
    expect(mockPrisma.priceBookItem.findFirst).not.toHaveBeenCalled();
  });

  it('a price-blind technician referencing a bad/foreign price_book_item_id gets 404, no create', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('technician'))
      .send({ description: 'Deadbolt Lock', quantity: 1, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id });

    expect(res.status).toBe(404);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('a price-visible ADMIN omitting unit_price gets 400, no create', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Deadbolt Lock', quantity: 1 });

    expect(res.status).toBe(400);
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
  });

  it('a price-visible ADMIN supplying both price_book_item_id AND unit_price keeps the client price verbatim (no catalog override)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`)
      .set(authHeader('admin'))
      .send({
        description: 'Deadbolt Lock',
        quantity: 1,
        unit_price: 25,
        price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id,
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.priceBookItem.findFirst).not.toHaveBeenCalled();
    const createArg = mockPrisma.jobLineItem.create.mock.calls[0][0];
    expect(Number(createArg.data.unit_price)).toBe(25);
  });
});
