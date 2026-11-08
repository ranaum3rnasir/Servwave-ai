import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// SRVW-96 - a job-anchored estimate (Estimate.job_id / job_link set, but no Job names it as its
// provenance estimate via Job.estimate_id) is invisible on the job while createInvoiceFromJob
// silently spends its deposit against the job's own unrelated lines. Two shapes satisfy the same
// predicate: (a) the job anchor itself (create({job_id}), no lines copied) and (b) a multi-estimate
// conversion, which leaves Job.estimate_id NULL (job.controller.ts writes
// `estimate_id: estimateIds.length === 1 ? estimateIds[0] : null`) yet DOES copy every constituent
// estimate's lines onto JobLineItem. Both must be refused for the same reason - the job's invoices
// are billed from the job's own line items, never from this estimate - so the message and this test
// suite must not claim the lines are absent from the job, which is false for shape (b).

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn> };
  estimateVersionSnapshot: { create: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  lead: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const LEAD_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

// A working DRAFT first-send fixture - the same shape estimate-send-leadless.test.ts uses.
const SEND_FIXTURE = {
  id: ESTIMATE_FIXTURE.id,
  status: 'DRAFT',
  estimate_number: ESTIMATE_FIXTURE.estimate_number,
  total_amount: 1062.5,
  lead_id: ESTIMATE_FIXTURE.lead_id,
  public_token: null,
  valid_until: null,
  modified_after_send: false,
  version: 1,
  deposit_type: null,
  deposit_value: null,
  created_by: TEST_USERS.sales.id,
  customer_id: LEAD_CUSTOMER_ID,
  customer: { id: LEAD_CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
  _count: { line_items: 2 },
  lead: {
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    status: 'CONTACTED',
    walkthrough_completed_at: null,
    customer: { id: LEAD_CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
  },
  send_config: null,
  job_id: null,
  job: null,
  job_link: null,
};

// Shape (a) - the job anchor: job_id set, no Job names this estimate as its provenance.
const ATTACHED_NO_PROVENANCE = { ...SEND_FIXTURE, job_id: JOB_ID, job: null, job_link: { job_number: 'J00001' } };
// Shape (b) - a multi-estimate conversion: job_id set, job.estimate_id left NULL, but this
// estimate's lines WERE copied onto JobLineItem (job.controller.ts:1519). Same predicate, same refusal.
const CONVERSION_ATTACHED_NO_PROVENANCE = { ...SEND_FIXTURE, job_id: JOB_ID, job: null, job_link: { job_number: 'J00001' } };
// Genuine single-estimate conversion: job.estimate_id points back at this estimate. Unaffected.
const SINGLE_CONVERSION_ATTACHED = { ...SEND_FIXTURE, job_id: JOB_ID, job: { id: JOB_ID }, job_link: { job_number: 'J00001' } };
// Ordinary lead anchor - job_id null. Unaffected.
const PLAIN = { ...SEND_FIXTURE, job_id: null, job: null, job_link: null };

const ORG_FIXTURE = {
  id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
  estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
  deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
};

function mockSuccessfulTransaction() {
  const sentResult = { ...SEND_FIXTURE, status: 'SENT', scopes: [] };
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      estimate: { update: vi.fn().mockResolvedValue(sentResult), findUnique: vi.fn().mockResolvedValue(sentResult) },
      estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
      invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
      invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // Spec #1751: commitFirstSend now stamps the lead's first_estimate_sent_at clock (D2) and
      // moves CONTACTED -> ESTIMATED through transitionLeadStatus (D6). Both write via
      // `updateMany`, and both read `count` off the result — `{ count: 1 }` means the row moved.
      lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    return fn(tx);
  });
}

describe('POST /api/estimates/:id/send - deposit refused on a job-anchored estimate (SRVW-96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
  });

  it('refuses deposit_required on an estimate attached to a job that is not its provenance', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ATTACHED_NO_PROVENANCE);

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(SEND_FIXTURE.estimate_number));
    expect(res.body.error).toMatch(/J00001/);
    // The PREP write inside commitFirstSend never runs, and neither does the transaction.
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('the refusal message makes no claim about where this estimate\'s line items live', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ATTACHED_NO_PROVENANCE);

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.body.error).toMatch(/billed from that job's own line items/);
    expect(res.body.error).not.toMatch(/line items are not on|cannot be billed|never be invoiced/i);
  });

  it('deposit_required:false on the same estimate still succeeds', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ATTACHED_NO_PROVENANCE);
    mockSuccessfulTransaction();

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deposit_required on a CONVERSION-attached estimate (same predicate, lines ARE on the job) still succeeds', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(SINGLE_CONVERSION_ATTACHED);
    mockSuccessfulTransaction();

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('deposit_required on a lead-anchored estimate (job_id null) still succeeds', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(PLAIN);
    mockSuccessfulTransaction();

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('resending an already-SENT attached estimate with deposit_required is NOT blocked', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...ATTACHED_NO_PROVENANCE, status: 'SENT' });
    mockSuccessfulTransaction();

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    // A resend never reaches commitFirstSend (isFirstSend is DRAFT-only), so no deposit is minted
    // and the guard - scoped to isFirstSend - must not fire either.
    expect(res.status).toBe(200);
  });
});

describe('POST /api/estimates/:id/mark-sent - deposit refused on a job-anchored estimate (SRVW-96)', () => {
  const markSentFixture = (overrides: Record<string, unknown>) => ({
    id: SEND_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: SEND_FIXTURE.estimate_number,
    total_amount: SEND_FIXTURE.total_amount,
    lead_id: SEND_FIXTURE.lead_id,
    deposit_type: null,
    deposit_value: null,
    created_by: TEST_USERS.sales.id,
    customer_id: LEAD_CUSTOMER_ID,
    _count: { line_items: 2 },
    lead: {
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      status: 'CONTACTED',
      customer: { id: LEAD_CUSTOMER_ID },
    },
    job_id: null,
    job: null,
    job_link: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
  });

  it('refuses deposit_required on an attached estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(
      markSentFixture({ job_id: JOB_ID, job: null, job_link: { job_number: 'J00001' } }),
    );

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J00001/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('deposit_required:false on an attached estimate succeeds', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(
      markSentFixture({ job_id: JOB_ID, job: null, job_link: { job_number: 'J00001' } }),
    );
    mockSuccessfulTransaction();

    const res = await request(app)
      .post(`/api/estimates/${SEND_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
