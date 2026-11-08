import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// #2010 security round 2 — `depositPctGuard` (estimate.controller.ts, chained onto
// updateEstimateSchema) only ever sees the REQUEST BODY, but PATCH /api/estimates/:id is partial
// and update() writes deposit_type/deposit_value independently. So either half of a >100%
// percentage deposit can be moved on its own:
//   - {deposit_value: 500} onto a stored PERCENTAGE row, or
//   - {deposit_type: 'PERCENTAGE'} onto a stored FIXED/500 row
// Both land an EFFECTIVE PERCENTAGE/500, and resolveDepositAmount clamps only the FIXED branch, so
// mark-sent/send then mint a deposit invoice for 5x the estimate total on the customer-facing page.
// These tests pin the two lines of defence: the effective-pair check in update(), and the
// PERCENTAGE clamp in resolveDepositAmount (which also covers rows that are ALREADY bad).

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: { create: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ORG = {
  id: 'org-1', estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
  deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
};

const TOTAL = 1000;

// Exactly the columns update() selects (estimate.controller.ts:1588-1607).
function storedRow(depositType: 'PERCENTAGE' | 'FIXED' | null, depositValue: number | null) {
  return {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    tax_rate: 0, discount_type: null, discount_value: null, version: 1, scopes: [],
    subtotal: TOTAL, tax_amount: 0, total_amount: TOTAL, discount_amount: 0,
    deposit_type: depositType, deposit_value: depositValue, discount_name: null,
    created_by: TEST_USERS.sales.id,
    job_id: null,
    organization: { lock_on_send: false },
    invoices: [],
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    customer: { tax_exempt: false },
  };
}

function patchDeposit(body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
    .set(authHeader('admin'))
    .send(body);
}

describe('#2010 — the EFFECTIVE percentage deposit is bounded, not just the request body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [], scopes: [] });
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
  });

  it('(a) refuses a deposit_value-only PATCH of 500 onto a stored PERCENTAGE row', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('PERCENTAGE', 50));

    const res = await patchDeposit({ deposit_value: 500 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Validation failed',
      details: [{ field: 'deposit_value', message: 'Deposit percentage cannot exceed 100' }],
    });
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('(b) refuses a deposit_type-only PATCH of PERCENTAGE onto a stored FIXED/500 row', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('FIXED', 500));

    const res = await patchDeposit({ deposit_type: 'PERCENTAGE' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Validation failed',
      details: [{ field: 'deposit_value', message: 'Deposit percentage cannot exceed 100' }],
    });
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('(b2) refuses the same bypass on the line_items branch of update()', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('PERCENTAGE', 50));

    const res = await patchDeposit({
      deposit_value: 500,
      line_items: [{ description: 'Repair', quantity: 1, unit_price: 1000, is_taxable: false }],
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'deposit_value', message: 'Deposit percentage cannot exceed 100' }]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('(c) accepts PERCENTAGE 100 (the ceiling itself is legal)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow(null, null));

    const res = await patchDeposit({ deposit_type: 'PERCENTAGE', deposit_value: 100 });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data).toMatchObject({
      deposit_type: 'PERCENTAGE', deposit_value: 100,
    });
  });

  it('(c2) accepts a deposit_value-only PATCH of 25 onto a stored PERCENTAGE row (the normal edit)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('PERCENTAGE', 50));

    const res = await patchDeposit({ deposit_value: 25 });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data.deposit_value).toBe(25);
  });

  it('(d) still accepts a FIXED deposit of 500 (dollars, clamped to the total downstream)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow(null, null));

    const res = await patchDeposit({ deposit_type: 'FIXED', deposit_value: 500 });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data).toMatchObject({
      deposit_type: 'FIXED', deposit_value: 500,
    });
  });

  it('(d2) still accepts a deposit_value-only PATCH of 500 onto a stored FIXED row', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('FIXED', 200));

    const res = await patchDeposit({ deposit_value: 500 });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data.deposit_value).toBe(500);
  });

  // The guard above is a read-then-write, so on its own it is racy: two concurrent PATCHes that
  // are each individually legal against the pre-write row can COMPOSE into a pair neither could
  // have written alone (`{deposit_type:'PERCENTAGE'}` + `{deposit_value:500}` onto FIXED/50).
  // Writing the RESOLVED pair, not the touched half, makes each request self-consistent, so
  // last-writer-wins can only land one of the two whole pairs.
  it('(h) a deposit PATCH persists the whole resolved pair, so two concurrent halves cannot compose', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('FIXED', 50));

    // Request B of the race: moves only the value. It must still pin the type it resolved against.
    const res = await patchDeposit({ deposit_value: 500 });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data).toMatchObject({
      deposit_type: 'FIXED',
      deposit_value: 500,
    });

    // Request A of the same race: moves only the type. Same rule, mirrored.
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [], scopes: [] });
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('FIXED', 50));

    const res2 = await patchDeposit({ deposit_type: 'PERCENTAGE' });

    expect(res2.status).toBe(200);
    expect(mockPrisma.estimate.update.mock.calls[0][0].data).toMatchObject({
      deposit_type: 'PERCENTAGE',
      deposit_value: 50,
    });
  });

  // The guard is deliberately scoped to requests that TOUCH a deposit field. A row that is already
  // PERCENTAGE/500 must not wedge every unrelated edit behind a deposit error the operator did not
  // ask about — and it does not need to, because (e)/(f) show resolveDepositAmount will never bill
  // such a row above the total anyway. This is the narrowing, pinned so it is not widened by
  // accident.
  it('(g) an unrelated PATCH on an already-bad PERCENTAGE/500 row is not wedged by the guard', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(storedRow('PERCENTAGE', 500));

    const res = await patchDeposit({ name: 'Renamed by the operator' });

    expect(res.status).toBe(200);
    const data = mockPrisma.estimate.update.mock.calls[0][0].data;
    expect(data.name).toBe('Renamed by the operator');
    // and the bad pair is left exactly as it was — not silently rewritten by an edit about a name.
    expect(data.deposit_type).toBeUndefined();
    expect(data.deposit_value).toBeUndefined();
  });

  // Second line of defence: a row that is ALREADY PERCENTAGE/500 (written before this fix, or by
  // any future writer) must still never bill more than the estimate total.
  it('(e) mark-sent on a stored PERCENTAGE/500 row bills the total, not 5x the total', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: TOTAL,
      customer_id: 'c0000000-0000-0000-0000-0000000000aa',
      lead_id: 'lead-deposit-bound-1',
      deposit_type: 'PERCENTAGE',
      deposit_value: 500,
      public_token: null,
      _count: { line_items: 2 },
      job_id: null, job: null, job_link: null,
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: 'CONTACTED',
        customer: { id: 'c0000000-0000-0000-0000-0000000000aa' },
        walkthrough_completed_at: null,
      },
    });
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-deposit-bound-1' });
    const sendConfigUpsert = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Freeze-at-send: commitFirstSend re-reads `scopes` inside the tx before stamping the
        // send-time snapshot onto the same write that flips the status to SENT.
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
          findUnique: vi.fn().mockResolvedValue({ scopes: null }),
        },
        estimateSendConfig: { upsert: sendConfigUpsert },
        lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);

    const invoiceData = invoiceCreate.mock.calls[0][0].data;
    expect(invoiceData.total_amount).toBe(TOTAL);
    expect(invoiceData.amount_due).toBe(TOTAL);
    expect(invoiceData.subtotal).toBe(TOTAL);
    expect(invoiceData.line_items.create[0].description).toContain('100%');

    const sendConfig = sendConfigUpsert.mock.calls[0][0].create;
    expect(sendConfig.deposit_amount).toBe(TOTAL);
    expect(sendConfig.deposit_percentage).toBe(100);
  });

  // send() calls the SAME resolveDepositAmount (estimate.controller.ts:2327) and feeds it to the
  // SAME commitFirstSend as mark-sent (:3060), so the clamp must show up on the emailed path too —
  // asserted, not merely grepped, because that is the path the customer's public estimate page and
  // the Stripe checkout are minted from. (recordEstimatePayment, the third reader at :2653, takes
  // only `.depositPercent` from the same helper and charges the admin-entered amount, so it is
  // covered by the same clamp: depositPercent is derived as depositAmount/total*100.)
  it('(f) send() on the same stored PERCENTAGE/500 row also bills the total, not 5x', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: TOTAL,
      customer_id: 'c0000000-0000-0000-0000-0000000000aa',
      lead_id: ESTIMATE_FIXTURE.lead_id,
      deposit_type: 'PERCENTAGE',
      deposit_value: 500,
      public_token: null,
      valid_until: null,
      modified_after_send: false,
      version: 1,
      created_by: TEST_USERS.sales.id,
      send_config: null,
      _count: { line_items: 2 },
      job_id: null, job: null, job_link: null,
      customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: 'CONTACTED',
        walkthrough_completed_at: null,
        customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
      },
    });
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-deposit-bound-2' });
    const sendConfigUpsert = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', scopes: [] }),
          findUnique: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', scopes: [] }),
        },
        estimateSendConfig: { upsert: sendConfigUpsert, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);

    const invoiceData = invoiceCreate.mock.calls[0][0].data;
    expect(invoiceData.total_amount).toBe(TOTAL);
    expect(invoiceData.amount_due).toBe(TOTAL);
    expect(invoiceData.line_items.create[0].description).toContain('100%');
  });
});
