import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// ─── Typed mock (same idiom as estimates.test.ts) ─────
const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    deleteMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// SERV10X-61 §5.4 / E3 (job-owns-tax-discount) - update() anchor rules: EVERY anchor (job, lead,
// customer) now keeps an editable tax rate - the job-anchored LOCK this suite used to pin was
// retired, since a job-anchored estimate is a quote and the job is the work, and they may
// legitimately differ. Empty line_items is a legal eager-draft state (recalcs to 0).

const ESTIMATE_ID = ESTIMATE_FIXTURE.id;
const JOB_UUID = 'a1111111-1111-1111-1111-111111111111';

// A DRAFT estimate with exactly the fields update()'s `existing` select reads.
function draftFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'DRAFT',
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    version: 1,
    scopes: [],
    subtotal: 1000,
    tax_amount: 62.5,
    total_amount: 1062.5,
    discount_amount: 0,
    deposit_type: null,
    deposit_value: null,
    discount_name: null,
    created_by: TEST_USERS.sales.id,
    job_id: null,
    organization: { lock_on_send: false },
    invoices: [],
    lead: { lead_assignees: [] },
    ...overrides,
  };
}

describe('PATCH /api/estimates/:id - SERV10X-61 anchor rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows an empty line_items:[] on a lead/customer-anchored (job_id:null) estimate → recalcs to 0', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftFixture({ job_id: null }));

    const txUpdate = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: txUpdate },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}`)
      .set(authHeader('admin'))
      .send({ line_items: [] });

    expect(res.status).toBe(200);
    const updateData = txUpdate.mock.calls[0][0].data;
    expect(updateData.subtotal).toBe(0);
    expect(updateData.total_amount).toBe(0);
  });

  it('accepts an inbound tax_rate on a job-anchored estimate → 200 (E3 retired the lock)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftFixture({ job_id: JOB_UUID }));
    // A tax_rate-only edit takes the metadata branch, which recalcs off the persisted line items.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([
      { quantity: 1, unit_price: 1000, is_taxable: true, discount_type: null, discount_value: null },
    ]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, tax_rate: 0.05 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.05 });

    expect(res.status).toBe(200);
    const updateData = mockPrisma.estimate.update.mock.calls[0][0].data;
    expect(updateData.tax_rate).toBe(0.05);
  });

  it('allows an inbound tax_rate on a lead/customer-anchored (job_id:null) estimate → 200', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftFixture({ job_id: null }));
    // A tax_rate-only edit takes the metadata branch, which recalcs off the persisted line items.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([
      { quantity: 1, unit_price: 1000, is_taxable: true, discount_type: null, discount_value: null },
    ]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, tax_rate: 0.05 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.05 });

    expect(res.status).toBe(200);
    // No line_items in the body → metadata branch persists the new tax_rate.
    const updateData = mockPrisma.estimate.update.mock.calls[0][0].data;
    expect(updateData.tax_rate).toBe(0.05);
  });
});
