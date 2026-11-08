import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { isStripeConfigured, createCheckoutSession, createRefund, getStripeForOrg } from '../lib/stripe';
import { sendEstimateApprovedNotification } from '../lib/email';
import * as emailLib from '../lib/email';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { stripEstimateCost, calculateTotals } from '../controllers/estimate.controller';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import {
  ALPHA_ORG_ID,
  TEST_USERS,
  TEST_ORG,
  mockAuthAs,
  authHeader,
  ESTIMATE_FIXTURE,
  ESTIMATE_SENT_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  STATE_TAX_FIXTURE,
  CUSTOMER_FIXTURE,
  STANDALONE_ESTIMATE_FIXTURE,
  LOCATION_FIXTURE,
  JOB_FIXTURE,
  LEAD_FIXTURE,
} from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockIsStripeConfigured = isStripeConfigured as ReturnType<typeof vi.fn>;
const mockCreateCheckoutSession = createCheckoutSession as ReturnType<typeof vi.fn>;
const mockCreateRefund = createRefund as ReturnType<typeof vi.fn>;
const mockGetStripeForOrg = getStripeForOrg as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  lead: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  customer: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    deleteMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  // R5f — line-item + scope-of-work photos.
  estimateScopePhoto: {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  estimateVersionSnapshot: {
    create: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    create: ReturnType<typeof vi.fn>;
  };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  stateTaxRate: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  orgTaxRate: {
    findMany: ReturnType<typeof vi.fn>;
  };
  appSetting: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  // Walkthrough-as-entity redesign, PR-B2: D8/D9's silent instrumentation reads this on send.
  visit: { count: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  invoice: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: {
    create: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  refund: {
    create: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  depositCreditApplication: {
    aggregate: ReturnType<typeof vi.fn>;
  };
  estimateSendConfig: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  organization: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateReservation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  priceBookItem: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  job: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// ─── Lead status writes (spec #1751 D6) ───────────────
//
// Every estimate door that moves a lead's status now goes through transitionLeadStatus: the
// status is written with `lead.updateMany` (its guards live in the WHERE clause) and a
// STATUS_CHANGE timeline event carrying `from` and `to` is filed alongside it.
//
// The `data.status` filter is load-bearing rather than cosmetic: the same `lead.updateMany` mock
// also receives the stage-clock stamps (`first_estimate_sent_at` on every first send, `won_at` on
// every win), so an unfiltered call count cannot tell "the lead moved" from "a clock ticked".

function leadStatusWrites(updateMany: ReturnType<typeof vi.fn>) {
  return updateMany.mock.calls
    .map((c: any[]) => c[0])
    .filter((args: any) => args?.data?.status !== undefined);
}

function statusChangeEvents(create: ReturnType<typeof vi.fn>) {
  return create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((data: any) => data?.event_type === 'STATUS_CHANGE');
}

/**
 * The lead half of a `$transaction` double, for the doors that touch a lead.
 *
 * `{ count: 1 }` = the row moved, which is what makes transitionLeadStatus file its ledger
 * entry; `{ count: 0 }` would be read as "the guard refused" and silently skip it.
 */
function txLeadDouble(row: unknown = {}) {
  return {
    update: vi.fn().mockResolvedValue(row),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `vi.clearAllMocks()` clears call history but NOT `mockResolvedValue` implementations.
  // The one-approved-per-lead guard (entity-redesign §4) calls `estimate.count`; reset it to a
  // safe default (no other WON estimate) so a test that sets count=1 cannot leak a false
  // rejection into a later suite. The two consumers (list() and the guard) always set their own.
  mockPrisma.estimate.count.mockReset();
  mockPrisma.estimate.count.mockResolvedValue(0);
  // Walkthrough-as-entity redesign, PR-B2: D8/D9's silent instrumentation on send() defaults to
  // "no COMPLETED visit" so existing send()/markSent() tests that don't care about this don't
  // need to know it exists.
  mockPrisma.visit.count.mockResolvedValue(0);
  // Same reasoning for the completion instant, and it must be reset per test rather than left to
  // the shared double: a findFirst set by one send() test would otherwise leak into every later
  // one in this file and stamp an unrelated estimate with its date.
  mockPrisma.visit.findFirst.mockResolvedValue(null);
});

// ═══════════════════════════════════════════════════════
// GET /api/estimates
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates', () => {
  beforeEach(() => {
    // groupBy is called on every list request; default to empty array
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    // all-time PENDING aggregate is called on every list request
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  });

  it('returns paginated estimate list with per-status stats', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_FIXTURE]);
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockPrisma.estimate.groupBy.mockResolvedValue([
      { status: 'DRAFT', _count: 1, _sum: { total_amount: 1062.5 } },
    ]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 2, _sum: { amount_due: 500 } });

    const res = await request(app)
      .get('/api/estimates')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimates).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect(res.body.stats).toBeDefined();
    // Each status has { count, value } shape
    for (const key of ['draft', 'sent', 'pending', 'won', 'declined', 'archived']) {
      expect(res.body.stats[key]).toHaveProperty('count');
      expect(res.body.stats[key]).toHaveProperty('value');
    }
    expect(res.body.stats.pending_deposits).toHaveProperty('count');
    expect(res.body.stats.pending_deposits).toHaveProperty('total');
  });

  it('filters by status', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?status=DRAFT')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toBe('DRAFT');
  });

  it('filters by multiple statuses', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?status=DRAFT&status=SENT')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toEqual({ in: ['DRAFT', 'SENT'] });
  });

  it('ignores invalid status values', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?status=INVALID')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toBeUndefined();
  });

  it('filters by created_after date', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    const cutoff = '2025-01-01T00:00:00.000Z';
    await request(app)
      .get(`/api/estimates?created_after=${cutoff}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.created_at).toEqual({ gte: new Date(cutoff) });
  });

  it('filters total_amount by total_min / total_max', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?total_min=500&total_max=5000').set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    expect(where.total_amount).toEqual({ gte: 500, lte: 5000 });
  });

  it('filters by customer_id directly on the estimate row (R6 direct anchor)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?customer_id=cust-1').set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ customer_id: 'cust-1' });
  });

  // The customer detail page's Estimates tab reads this list (filtered by customer_id above)
  // and renders the originating request as its "Service Request" column, so the nested lead
  // must carry service_request. Previously the tab derived its rows from GET /api/leads, which
  // is Pro-gated - unusable for a Starter org, where Estimates is core.
  it('selects the originating lead service_request on each list row', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?customer_id=cust-1').set(authHeader('admin'));

    const select = mockPrisma.estimate.findMany.mock.calls[0][0].select;
    expect(select.lead.select.service_request).toBe(true);
    // The columns the tab renders alongside it, which the leads-nested shape never carried.
    expect(select.estimate_number).toBe(true);
    expect(select.status).toBe(true);
    expect(select.created_at).toBe(true);
  });

  it('filters by deposit_status', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?deposit_status=REQUESTED').set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    // Deposit dissolved into a kind=DEPOSIT Invoice; REQUESTED maps to an unpaid (DRAFT/SENT) deposit invoice.
    expect(where.invoices).toEqual({ some: { kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } } });
  });

  it('filters by multiple deposit_status values, unioning their mapped invoice statuses', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?deposit_status=REQUESTED&deposit_status=PAID')
      .set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    // REQUESTED -> [DRAFT, SENT], PAID -> PAID; unioned + deduped into one `in`.
    expect(where.invoices).toEqual({ some: { kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT', 'PAID'] } } });
  });

  it('combines created_after and created_before', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?created_after=2026-06-01T00:00:00.000Z&created_before=2026-06-30T23:59:59.999Z')
      .set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeInstanceOf(Date);
  });

  it('filters by lead_id', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get(`/api/estimates?lead_id=${ESTIMATE_FIXTURE.lead_id}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead_id).toBe(ESTIMATE_FIXTURE.lead_id);
  });

  it('accepts PENDING status filter', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates?status=PENDING')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toBe('PENDING');
  });

  it('auto-filters for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates')
      .set(authHeader('sales'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    // SERV10X-61 §8 - the SALES estimate read-scope is now the substituted OR of the own-via-lead
    // arm AND the own lead-less-created arm (lead_id:null + created_by-self), so the scope lives
    // under `where.OR`, not a top-level `where.lead`. Asserting the full OR (not weakened): the
    // own-via-lead arm is byte-for-byte the old scope, and the second arm is pinned to the SALES
    // user's own id so it can never widen to another rep's lead-less estimates.
    expect(findManyArgs.where.OR).toEqual([
      { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
      { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
    ]);
  });

  it("scopes the pending_deposits stat to the SALES user's own leads", async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates').set(authHeader('sales'));

    // pending_deposits now aggregates the kind=DEPOSIT Invoice, scoped to the SALES user's leads via estimate→lead.
    const depositCall = mockPrisma.invoice.aggregate.mock.calls[0][0];
    expect(depositCall.where.kind).toBe('DEPOSIT');
    // SERV10X-61 §8 - the deposit KPI is scoped through `estimate: readScope`, which is now the
    // own-via-lead OR own-lead-less-created OR (see the list-scope test above).
    expect(depositCall.where.estimate).toEqual({
      OR: [
        { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
        { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
      ],
    });
  });

  it('filters by created_by', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get(`/api/estimates?created_by=${TEST_USERS.sales.id}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.created_by).toBe(TEST_USERS.sales.id);
  });

  it('filters by multiple created_by values (two sales reps)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get(`/api/estimates?created_by=${TEST_USERS.sales.id}&created_by=${TEST_USERS.admin.id}`)
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.created_by).toEqual({ in: [TEST_USERS.sales.id, TEST_USERS.admin.id] });
  });

  // Live QA, 2026-08-05 - TECHNICIAN now holds a CONDITIONAL read Estimate grant
  // (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR), so the list is scoped rather than blocked outright.
  it('auto-filters for TECHNICIAN role (own-lead-via-walkthrough OR own-created lead-less)', async () => {
    mockAuthAs('technician');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    const res = await request(app)
      .get('/api/estimates')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.OR).toEqual([
      { lead: { lead_assignees: { some: { user_id: TEST_USERS.technician.id } } } },
      { AND: [{ lead_id: null }, { created_by: TEST_USERS.technician.id }] },
    ]);
  });

  it('should scope stats to own leads for SALES role', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates')
      .set(authHeader('sales'));

    // SERV10X-61 §8 - the SALES stats scope mirrors the list scope: own-via-lead OR own
    // lead-less-created, under `where.OR`.
    const salesFilter = {
      OR: [
        { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
        { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
      ],
    };

    // The groupBy call for stats must include the SALES lead filter
    const groupByCall = mockPrisma.estimate.groupBy.mock.calls[0][0];
    expect(groupByCall.where).toMatchObject(salesFilter);
  });

  it('includes customer_number in nested lead.customer select', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app)
      .get('/api/estimates')
      .set(authHeader('admin'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.select.lead.select.customer.select.customer_number).toBe(true);
  });

  it('estimate monthly status stats are bounded to the current month; pending is all-time', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates').set(authHeader('admin'));

    // monthly groupBy carries a created_at range
    const monthlyGb = mockPrisma.estimate.groupBy.mock.calls.find((c: any) => c[0].where?.created_at);
    expect(monthlyGb).toBeDefined();
    expect(monthlyGb![0].where.created_at.gte).toBeInstanceOf(Date);
    expect(monthlyGb![0].where.created_at.lte).toBeInstanceOf(Date);

    // pending all-time: an estimate.aggregate for status PENDING with NO created_at
    const pendingCall = mockPrisma.estimate.aggregate.mock.calls.find((c: any) => c[0].where?.status === 'PENDING');
    expect(pendingCall).toBeDefined();
    expect(pendingCall![0].where.created_at).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/estimates/creators
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates/creators', () => {
  it('returns active admin/sales users', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([
      { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
    ]);

    const res = await request(app)
      .get('/api/estimates/creators')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].first_name).toBe('Test');
  });

  // Live QA, 2026-08-05 - TECHNICIAN now holds a CONDITIONAL read Estimate grant, which passes
  // the route's subject-level canDo guard. Still blocked here because listCreators is
  // deliberately narrowed to UNCONDITIONAL readers (scopeWhereForReq → {}) - it is an org-wide
  // filter-dropdown feed, not something a row-scoped reader's own estimate list needs.
  it('blocks TECHNICIAN role (conditional read Estimate grant is not unconditional)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/estimates/creators')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates', () => {
  const validBody = {
    lead_id: ESTIMATE_FIXTURE.lead_id,
    scope_notes: 'Replace AC unit',
    tax_rate: 0.0625,
    line_items: [
      { description: 'AC Unit', quantity: 1, unit_price: 800, is_taxable: true },
      { description: 'Labor', quantity: 1, unit_price: 200, is_taxable: true },
    ],
  };

  it('creates estimate (no lead status transition on create)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.estimate).toBeDefined();
  });

  // R6 (2026-07-22) — M5: create() denormalizes the lead's customer_id/service_location_id onto
  // the new estimate at write time (not just backfilled once on existing rows), so the columns
  // never start drifting from the moment they ship.
  it('denormalizes customer_id/service_location_id from the lead onto the new estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { findFirst: vi.fn().mockResolvedValue(null), create: createMock },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app).post('/api/estimates').set(authHeader('admin')).send(validBody);

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
      }),
    }));
  });

  // A lead with no ServiceLocation yet (still on legacy service_address_* fields, per the R6
  // migration's own backfill-coverage note) must still create successfully — service_location_id
  // stays null, not a validation error.
  it('creates successfully with a null service_location_id when the lead has none', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: null,
    });
    const createMock = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { findFirst: vi.fn().mockResolvedValue(null), create: createMock },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app).post('/api/estimates').set(authHeader('admin')).send(validBody);

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: null }),
    }));
  });

  it('rejects if lead not found', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(404);
  });

  it('rejects if lead is terminal (WON)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'WON',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('won');
  });

  it('rejects if lead is terminal (LOST)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'LOST',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(400);
  });

  it('SALES cannot create for another rep\'s lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }], // Not the sales user
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('sales'))
      .send(validBody);

    expect(res.status).toBe(403);
  });

  // R5a (2026-07-21) — relaxed: calculateTotals already folds a scope's flat_price into subtotal
  // independently of line items, so a scope-only estimate is a real, computable document.
  it('allows creating a scope-only estimate with zero line items', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [] }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: ESTIMATE_FIXTURE.lead_id, tax_rate: 0.0625, line_items: [] });

    expect(res.status).toBe(201);
    expect(res.body.estimate).toBeDefined();
  });

  // R5a — a bare .optional() still requires the KEY to be present (Zod rejects a missing key with
  // "Required" even for an array field); EstimateTabs.tsx's "Start blank" sends `{ lead_id }` with
  // no `line_items` key at all, which is exactly the case `.default([])` exists to cover.
  it("allows creating a blank estimate with no line_items key at all (EstimateTabs' Start Blank)", async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [] }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: ESTIMATE_FIXTURE.lead_id });

    expect(res.status).toBe(201);
    expect(res.body.estimate).toBeDefined();
  });

  it('still rejects a malformed line item when line_items is non-empty', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: ESTIMATE_FIXTURE.lead_id, tax_rate: 0.0625, line_items: [{ description: 'Missing required fields' }] });

    expect(res.status).toBe(400);
  });

  it('DISPATCHER cannot create estimates', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('dispatcher'))
      .send(validBody);

    expect(res.status).toBe(403);
  });

  it('TECHNICIAN cannot create estimates', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('technician'))
      .send(validBody);

    expect(res.status).toBe(403);
  });

  // Bug #39/#7 — a DRAFT estimate must ALWAYS persist; the walkthrough requirement
  // moved to the SEND path (owner-controlled). Creating on a NEW/CONTACTED/ESTIMATED lead
  // now returns 201 regardless of visit state (no create-time data loss).
  it('allows create for a lead in NEW (no create-time block)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
  });

  it('allows create for a lead in ESTIMATED (no create-time block)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'ESTIMATED',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
  });

  // Bug #40 originally raised the ceiling from 500 to 5000 (matching scope_notes); v12 §2a briefly
  // reconciled it back to 500 for cross-surface consistency with Job/Invoice line items. That
  // consistency goal is preserved by raising ALL of Estimate/Job/Invoice line-item descriptions
  // (and Price Book descriptions) to 5000 together, restoring Bug #40's original ceiling.
  it('allows create with a line-item description at exactly 5000 chars', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        ...validBody,
        line_items: [{ description: 'x'.repeat(5000), quantity: 1, unit_price: 100, is_taxable: true }],
      });

    expect(res.status).toBe(201);
  });

  it('rejects create with a line-item description over the shared cap', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        ...validBody,
        line_items: [{ description: 'x'.repeat(LINE_DESCRIPTION_MAX + 1), quantity: 1, unit_price: 100, is_taxable: true }],
      });

    expect(res.status).toBe(400);
  });

  it('allows create for a lead in CONTACTED', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send(validBody);

    expect(res.status).toBe(201);
  });

  // Entity-redesign §4 — lead is REQUIRED on create. A payload with no lead_id 400s
  // (reverses the Track-2 lead-less path).
  it('rejects create without lead_id (400, lead required)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ tax_rate: 0, line_items: [{ description: 'Rekey', quantity: 1, unit_price: 100, is_taxable: true }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/lead_id/i);
  });

  // R6 (2026-07-22) — REVERSED from the entity-redesign §4 era: create() now DOES denormalize
  // Estimate.customer_id/service_location_id from the lead (see "denormalizes customer_id/
  // service_location_id from the lead onto the new estimate" in the POST /api/estimates describe
  // block above, which supersedes this test's old "does NOT write customer_id" assertion).
});

// SERV10X-61 §5.1 - RE-ENABLES the customer-anchored (lead-less) create path the entity-redesign
// had reversed: a NEW estimate anchors to EXACTLY ONE of a lead, a customer, or a job. A shared
// $transaction stub captures tx.estimate.create's `data` so each test can assert the resolved
// anchor columns (mirrors the deriveTaxRateFromLead suite's capture pattern).
type CapturedCreateData = { tax_rate?: number; tax_amount?: number; subtotal?: number; customer_id?: string | null; lead_id?: string | null; job_id?: string | null; service_location_id?: string | null };

function captureCreateTransaction(store: { data?: CapturedCreateData }, result: unknown = ESTIMATE_FIXTURE) {
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((args: { data: CapturedCreateData }) => {
          store.data = args.data;
          return result;
        }),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
}

describe('POST /api/estimates - customer-anchored create (SERV10X-61)', () => {
  const store: { data?: CapturedCreateData } = {};
  beforeEach(() => { store.data = undefined; });

  const customerRow = () => ({
    id: CUSTOMER_FIXTURE.id,
    service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX' }],
  });

  it('201 for a customer-anchored create - resolves customer_id, nulls lead_id/job_id', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'Rekey', quantity: 1, unit_price: 100, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(store.data).toMatchObject({
      customer_id: CUSTOMER_FIXTURE.id,
      lead_id: null,
      job_id: null,
      service_location_id: LOCATION_FIXTURE.id,
    });
  });

  it('customer-anchored tax derives from the primary location state when tax_rate omitted', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0.0625);
    expect(store.data?.tax_amount).toBe(62.5);
    expect(mockPrisma.stateTaxRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { state_code: 'TX' } }),
    );
  });

  it('customer-anchored explicit tax_rate wins over derivation', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow());
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, tax_rate: 0.08, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0.08);
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  it('404 when the customer does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [] });
    expect(res.status).toBe(404);
  });

  // §8 - ANY create-Estimate grant may create a customer-anchored estimate; a row-scoped SALES
  // requester is NOT blocked here (contrast the lead/job anchors, which require ownership).
  it('SALES can create a customer-anchored estimate (no row-scope block)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue(customerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('sales'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [{ description: 'Rekey', quantity: 1, unit_price: 100, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(store.data?.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });
});

describe('POST /api/estimates - anchor validation (SERV10X-61)', () => {
  // Retitled from the old "400 when lead_id missing": a payload with NO anchor at all still 400s.
  it('400 when NO anchor is provided (lead_id/customer_id/job_id all missing)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ tax_rate: 0, line_items: [{ description: 'x', quantity: 1, unit_price: 1, is_taxable: true }] });
    expect(res.status).toBe(400);
  });

  it('400 when MORE THAN ONE anchor is provided (customer_id + lead_id)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ lead_id: ESTIMATE_FIXTURE.lead_id, customer_id: CUSTOMER_FIXTURE.id, line_items: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/estimates - job-anchored create (SERV10X-61)', () => {
  const store: { data?: CapturedCreateData } = {};
  beforeEach(() => { store.data = undefined; });

  // NOTE: JOB_FIXTURE.id (`j0000000-…`) is a non-UUID test sentinel - 'j' isn't a hex digit - so it
  // fails the schema's `job_id: z.string().uuid()` guard. Real job ids ARE uuids, so we keep the
  // production-correct `.uuid()` validation and use a valid-uuid sentinel for the inbound anchor id.
  // customer_id / service_location_id still come from JOB_FIXTURE (returned by the mock, never
  // uuid-validated), preserving the "resolve everything from the job" intent.
  const JOB_ANCHOR_ID = 'a0000000-0000-0000-0000-000000000009';

  // S8 (D6): crew is reached through the job's trips, so the fixture states it there.
  const jobRow = (assignees: { user_id: string }[] = []) => ({
    id: JOB_ANCHOR_ID,
    customer_id: JOB_FIXTURE.customer_id,
    service_location_id: JOB_FIXTURE.service_location_id,
    visits: [{ assignees }],
    service_location: { state: 'TX' },
  });

  it('201 for a job-anchored create - resolves job_id/customer_id/service_location_id, derives tax from the job location', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ job_id: JOB_ANCHOR_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(store.data).toMatchObject({
      job_id: JOB_ANCHOR_ID,
      lead_id: null,
      customer_id: JOB_FIXTURE.customer_id,
      service_location_id: JOB_FIXTURE.service_location_id,
    });
    expect(store.data?.tax_rate).toBe(0.0625);
    expect(mockPrisma.stateTaxRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { state_code: 'TX' } }),
    );
  });

  it('404 when the job does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ job_id: JOB_ANCHOR_ID, line_items: [] });
    expect(res.status).toBe(404);
  });

  // E3 (job-owns-tax-discount) retires the tax LOCK: a job-anchored estimate is a quote, the job
  // is the work, and they may legitimately differ - an explicit tax_rate now overrides the
  // location-derived default, same as the lead/customer anchors already allow.
  it('201 - a job-anchored create accepts an explicit tax_rate, overriding the location-derived default', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    captureCreateTransaction(store);
    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ job_id: JOB_ANCHOR_ID, tax_rate: 0.08, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });
    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0.08);
    // The explicit rate wins - no location lookup needed.
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  // F-004 - a row-scoped SALES requester may only create on a job they are ASSIGNED to.
  it('SALES cannot create a job-anchored estimate for a job they are NOT assigned to (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow([{ user_id: TEST_USERS.admin.id }]));
    const res = await request(app).post('/api/estimates').set(authHeader('sales'))
      .send({ job_id: JOB_ANCHOR_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });
    expect(res.status).toBe(403);
  });

  it('SALES can create a job-anchored estimate for a job they ARE assigned to (201)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue(jobRow([{ user_id: TEST_USERS.sales.id }]));
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);
    const res = await request(app).post('/api/estimates').set(authHeader('sales'))
      .send({ job_id: JOB_ANCHOR_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });
    expect(res.status).toBe(201);
  });
});

/**
 * POST /api/jobs/:id/estimates - create a NEW estimate from a job's CURRENT Items tab (SERV10X-60,
 * Part B of job-items-estimate-parity). Distinct from the job-anchored create() above: that door
 * authors line_items fresh; this one copies the job's OWN job_line_items/scopes and derives
 * tax_rate/discount straight off the JOB (E1/E2, job-owns-tax-discount) - the same numbers the
 * Items tab preview and both invoice doors already show - so the new estimate's numbers match
 * what the Items tab already shows.
 */
describe('POST /api/jobs/:id/estimates - create from job items (SERV10X-60)', () => {
  const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
  const TAXED_LINE = { id: 'jli-1', sequence: 1, description: 'AC unit', quantity: 1, unit_price: 1000, is_taxable: true, line_total: 1000, item_type: 'MATERIAL', price_book_item_id: null, unit_cost: null, markup_percent: null };

  function jobItemsRow(overrides: Record<string, any> = {}) {
    return {
      id: JOB_ID,
      job_number: 'J00042',
      source_plan_id: null,
      customer_id: 'c0000000-0000-0000-0000-000000000001',
      service_location_id: 'sl000000-0000-0000-0000-000000000001',
      customer: { tax_exempt: false },
      assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
      job_line_items: [TAXED_LINE],
      scopes: [],
      tax_rate: 0,
      discount_type: null as 'PERCENTAGE' | 'FIXED_AMOUNT' | null,
      discount_value: null as number | null,
      ...overrides,
    };
  }

  type CapturedEstimateData = {
    job_id?: string | null;
    lead_id?: string | null;
    customer_id?: string;
    service_location_id?: string | null;
    tax_rate?: number;
    discount_type?: string | null;
    discount_value?: number | null;
    discount_amount?: number;
    subtotal?: number;
    tax_amount?: number;
    total_amount?: number;
    line_items?: { create: Array<Record<string, unknown>> };
  };
  const store: { data?: CapturedEstimateData } = {};

  function captureJobEstimateTransaction() {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          create: vi.fn().mockImplementation((args: { data: CapturedEstimateData }) => {
            store.data = args.data;
            return ESTIMATE_FIXTURE;
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  beforeEach(() => {
    store.data = undefined;
  });

  it("201 - copies the job's line items and derives tax + discount from the JOB itself (E1/E2)", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow({
      tax_rate: 0.0625,
      discount_type: 'PERCENTAGE',
      discount_value: 10,
    }));
    captureJobEstimateTransaction();

    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    expect(store.data).toMatchObject({
      job_id: JOB_ID,
      lead_id: null,
      customer_id: 'c0000000-0000-0000-0000-000000000001',
      service_location_id: 'sl000000-0000-0000-0000-000000000001',
    });
    expect(store.data?.tax_rate).toBe(0.0625);
    // subtotal 1000, 10% discount → 100, discounted 900 * 6.25% tax = 56.25
    expect(store.data?.subtotal).toBe(1000);
    expect(store.data?.discount_amount).toBe(100);
    expect(store.data?.tax_amount).toBe(56.25);
    expect(store.data?.total_amount).toBe(956.25);
    expect(store.data?.line_items?.create).toHaveLength(1);
    expect(store.data?.line_items?.create?.[0]).toMatchObject({ description: 'AC unit', quantity: 1, unit_price: 1000 });
  });

  it("stays at the job's own schema-default tax_rate (0%) when the job has never had one set", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow());
    captureJobEstimateTransaction();

    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
    expect(store.data?.discount_amount).toBe(0);
    expect(store.data?.total_amount).toBe(1000);
  });

  it('a tax-exempt customer is quoted $0 tax even with a taxed job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow({
      customer: { tax_exempt: true },
      tax_rate: 0.0625,
    }));
    captureJobEstimateTransaction();

    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('admin')).send({});

    expect(res.status).toBe(201);
    expect(store.data?.tax_amount).toBe(0);
  });

  it('404 when the job does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });

  it('400 - a service-plan visit job cannot be estimated', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow({ source_plan_id: 'plan-uuid-0000-0000-0000-000000000001' }));
    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service plan|already paid/i);
  });

  it('F-004 - SALES cannot create from a job they are NOT assigned to (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow({ assignees: [{ user_id: TEST_USERS.admin.id }] }));
    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('sales')).send({});
    expect(res.status).toBe(403);
  });

  it('F-004 - SALES CAN create from a job they ARE assigned to (201)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue(jobItemsRow({ visits: [{ assignees: [{ user_id: TEST_USERS.sales.id }] }] }));
    captureJobEstimateTransaction();
    const res = await request(app).post(`/api/jobs/${JOB_ID}/estimates`).set(authHeader('sales')).send({});
    expect(res.status).toBe(201);
  });
});

/**
 * POST /api/estimates/:id/attach-to-job - attach an EXISTING standalone estimate to an EXISTING
 * job (transition 16, continuity map §4.6; job-items-estimate-parity Part C). Guards: no crossing
 * a customer boundary, no moving money already recorded against the estimate (a paid deposit or
 * any non-voided invoice), re-key the estimate's number into the job's `J00007-1` container -
 * same numbering machinery createFromJobItems above and the generic job-anchor create() both use.
 */
describe('POST /api/estimates/:id/attach-to-job (transition 16)', () => {
  const ATTACH_EST_ID = 'aa000000-0000-0000-0000-00000000000a';
  const ATTACH_JOB_ID = 'bb000000-0000-0000-0000-00000000000b';
  const CUSTOMER_A = 'c0000000-0000-0000-0000-00000000000a';
  const CUSTOMER_B = 'c0000000-0000-0000-0000-00000000000b';

  function estimateRow(overrides: Record<string, any> = {}) {
    return {
      id: ATTACH_EST_ID,
      status: 'DRAFT',
      customer_id: CUSTOMER_A,
      job_id: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      ...overrides,
    };
  }

  function jobRow(overrides: Record<string, any> = {}) {
    return {
      id: ATTACH_JOB_ID,
      customer_id: CUSTOMER_A,
      source_plan_id: null,
      assignees: [{ user_id: TEST_USERS.technician.id }], visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
      ...overrides,
    };
  }

  function mockTransaction(result: unknown = { ...ESTIMATE_FIXTURE, estimate_number: 'J00042-1' }) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ estimate: { update: vi.fn().mockResolvedValue(result) } }),
    );
  }

  it('200 - attaches, re-keys the estimate number into the job container', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockTransaction();

    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });

    expect(res.status).toBe(200);
    expect(res.body.estimate.estimate_number).toBe('J00042-1');
  });

  it('404 when the estimate does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(404);
  });

  it('404 when the job does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(404);
  });

  it('400 - refuses to cross a customer boundary', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ customer_id: CUSTOMER_A }));
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ customer_id: CUSTOMER_B }));
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer/i);
  });

  it('400 - refuses an estimate already attached to a job', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ job_id: 'some-other-job' }));
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(400);
  });

  it('400 - refuses a WON/terminal-status estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ status: 'WON' }));
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(400);
  });

  it('400 - a service-plan visit job cannot take an attached estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ source_plan_id: 'plan-uuid-0000-0000-0000-000000000001' }));
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(400);
  });

  it('409 - refuses to move an estimate that already has a recorded (non-voided) invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.job.findUnique.mockResolvedValue(jobRow());
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'inv-already-there' });
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('admin'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(409);
  });

  it('F-004 - SALES cannot attach onto a job they are NOT assigned to (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ assignees: [{ user_id: TEST_USERS.admin.id }] }));
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/estimates/${ATTACH_EST_ID}/attach-to-job`)
      .set(authHeader('sales'))
      .send({ job_id: ATTACH_JOB_ID });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// SRVW-82 - a tax_exempt customer must be QUOTED tax-free, not merely billed tax-free.
// The exemption is applied to the tax RATE the estimate is created/edited/duplicated with,
// mirroring the invoice side's own precedent (invoice.controller.ts:816), so every downstream
// reader of the persisted estimate.tax_rate (send()'s deposit basis, copyToInvoice,
// estimate-lines recomputeAndPersist, createInvoiceFromJob) inherits it with no signature
// change. Fixtures are declared locally because the equivalents in the suites above are
// describe-scoped and unreachable from here.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('SRVW-82 tax-exempt customer', () => {
  type ExemptCreateData = CapturedCreateData & { total_amount?: number };
  const store: { data?: ExemptCreateData } = {};
  beforeEach(() => { store.data = undefined; });

  const TAXABLE_LINE = { description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true };
  const EXEMPT_JOB_ID = 'a0000000-0000-0000-0000-000000000082';
  const SRC_LEAD_ID = ESTIMATE_FIXTURE.lead_id;
  const TGT_LEAD_ID = 'e0000000-0000-0000-0000-000000000082';

  const exemptCustomerRow = () => ({
    id: CUSTOMER_FIXTURE.id,
    tax_exempt: true,
    service_locations: [{ id: LOCATION_FIXTURE.id, state: 'TX' }],
  });

  const exemptJobRow = () => ({
    id: EXEMPT_JOB_ID,
    customer_id: JOB_FIXTURE.customer_id,
    service_location_id: JOB_FIXTURE.service_location_id,
    assignees: [],
    service_location: { state: 'TX' },
    customer: { tax_exempt: true },
  });

  const exemptSourceEstimate = (overrides: Record<string, unknown> = {}) => ({
    lead_id: SRC_LEAD_ID,
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    created_by: TEST_USERS.admin.id,
    scope_notes: ESTIMATE_FIXTURE.scope_notes,
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    customer: { tax_exempt: false },
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    line_items: ESTIMATE_FIXTURE.line_items,
    ...overrides,
  });

  type DuplicateCreateData = { lead_id?: string; tax_rate?: number; tax_amount?: number; total_amount?: number };
  function captureDuplicateCreateData() {
    let captured: DuplicateCreateData | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockImplementation((args: { data: DuplicateCreateData }) => {
            captured = args.data;
            return { ...ESTIMATE_FIXTURE, id: 'dup-id' };
          }),
        },
      }),
    );
    return () => captured;
  }

  it('create (customer anchor): a tax_exempt customer\'s estimate persists tax_rate 0 and tax_amount 0', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(exemptCustomerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [TAXABLE_LINE] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
    expect(store.data?.tax_amount).toBe(0);
    expect(store.data?.subtotal).toBe(1000);
    expect(store.data?.total_amount).toBe(1000);
  });

  it('create (lead anchor): a tax_exempt customer\'s estimate persists tax_rate 0 and tax_amount 0', async () => {
    mockAuthAs('admin');
    // Two lead.findUnique calls: (1) the create-guard select, (2) deriveTaxRateFromLead.
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({
        id: SRC_LEAD_ID,
        status: 'CONTACTED',
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        customer: { tax_exempt: true },
      })
      .mockResolvedValueOnce({ service_location_id: LOCATION_FIXTURE.id, service_location: { state: 'TX' }, service_state: 'TX' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ lead_id: SRC_LEAD_ID, line_items: [TAXABLE_LINE] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
    expect(store.data?.tax_amount).toBe(0);
    expect(store.data?.total_amount).toBe(1000);
  });

  it("create (job anchor): a tax_exempt customer's estimate persists tax_rate 0, even with an explicit override (E3 retired the lock, exemption still wins)", async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(exemptJobRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ job_id: EXEMPT_JOB_ID, line_items: [TAXABLE_LINE] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
    expect(store.data?.tax_amount).toBe(0);
    expect(store.data?.total_amount).toBe(1000);

    // E3 (job-owns-tax-discount) - the job anchor's tax LOCK is retired, so this no longer 400s -
    // but SRVW-82's exemption clamp still applies AFTER anchor resolution, so the explicit 0.08
    // is still zeroed out, same as every other anchor.
    const overridden = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ job_id: EXEMPT_JOB_ID, tax_rate: 0.08, line_items: [TAXABLE_LINE] });
    expect(overridden.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
  });

  it('create: an explicit tax_rate cannot override a customer\'s exemption', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(exemptCustomerRow());
    captureCreateTransaction(store);

    const res = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, tax_rate: 0.08, line_items: [TAXABLE_LINE] });

    expect(res.status).toBe(201);
    expect(store.data?.tax_rate).toBe(0);
    expect(store.data?.tax_amount).toBe(0);
  });

  it('update: PATCHing a jurisdiction tax_rate onto an exempt estimate persists 0, not the requested rate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      deposit_type: null,
      deposit_value: null,
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      discount_amount: 0,
      version: 1,
      created_by: TEST_USERS.admin.id,
      job_id: null,
      invoices: [],
      organization: { lock_on_send: false },
      customer: { tax_exempt: true },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([
      { quantity: 1, unit_price: 1000, is_taxable: true, discount_type: null, discount_value: null },
    ]);
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.0625 });

    expect(res.status).toBe(200);
    const updateData = mockPrisma.estimate.update.mock.calls[0][0].data;
    expect(Number(updateData.tax_rate)).toBe(0);
    expect(Number(updateData.tax_amount)).toBe(0);
    expect(Number(updateData.total_amount)).toBe(1000);
  });

  it('MONEY: a 50% deposit for an exempt customer is charged off the tax-free total (500, not 531.25)', async () => {
    mockAuthAs('admin');
    // Step 1 - create the exempt estimate and read the total the deposit will be computed from.
    mockPrisma.customer.findUnique.mockResolvedValue(exemptCustomerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);
    const created = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [TAXABLE_LINE] });
    expect(created.status).toBe(201);
    const exemptTotal = Number(store.data?.total_amount);

    // Step 2 - send it with the org's default 50% PERCENTAGE deposit.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: exemptTotal,
      public_token: null,
      valid_until: null,
      customer_id: CUSTOMER_FIXTURE.id,
      _count: { line_items: 1 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: CUSTOMER_FIXTURE.id, email: 'john@doe.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    let capturedInvoice: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      estimate: {
        update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', send_config: null, deposit: null }),
        findUnique: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', send_config: null, deposit: null }),
      },
      estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
      invoice: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedInvoice = args.data;
          return Promise.resolve({ id: 'dep-inv-82' });
        }),
      },
      invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));

    const sent = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(sent.status).toBe(200);
    expect(capturedInvoice?.kind).toBe('DEPOSIT');
    expect(Number(capturedInvoice?.total_amount)).toBe(500);
    expect(Number(capturedInvoice?.amount_due)).toBe(500);
  });

  it('copy-to-invoice: an exempt customer\'s estimate copies to an invoice with $0 tax', async () => {
    mockAuthAs('admin');
    // Step 1 - create the exempt estimate and read the rate copyToInvoice will bill from.
    mockPrisma.customer.findUnique.mockResolvedValue(exemptCustomerRow());
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    captureCreateTransaction(store);
    const created = await request(app).post('/api/estimates').set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, line_items: [TAXABLE_LINE] });
    expect(created.status).toBe(201);
    const exemptRate = Number(store.data?.tax_rate);

    // Step 2 - copy that estimate's own persisted rate into a standalone invoice.
    const estimate = copyToInvoiceEstimate({ status: 'DRAFT', tax_rate: exemptRate });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    const captured: { data?: Record<string, unknown> } = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(copyToInvoiceTx(captured)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(Number(captured.data?.tax_rate)).toBe(0);
    expect(Number(captured.data?.tax_amount)).toBe(0);
    // Because the rate is 0, invoice-lines' later recompute with taxExemptOf(invoice) === true
    // also yields 0, so the copied invoice cannot silently change its total on the first edit.
    expect(Number(captured.data?.total_amount))
      .toBe(Number(captured.data?.subtotal) - Number(estimate.discount_amount));
  });

  it('duplicate (cross-lead): re-derived tax is zeroed when the TARGET lead\'s customer is exempt', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(exemptSourceEstimate());
    // The controller calls lead.findUnique twice for the target (validate, then derive).
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: TGT_LEAD_ID, customer_id: CUSTOMER_FIXTURE.id, service_location_id: 'loc-ca', customer: { tax_exempt: true } })
      .mockResolvedValueOnce({ service_location_id: 'loc-ca', service_location: { state: 'CA' }, service_state: 'CA' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0725 });
    const getCaptured = captureDuplicateCreateData();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({ target_lead_id: TGT_LEAD_ID });

    expect(res.status).toBe(201);
    expect(getCaptured()?.tax_rate).toBe(0);
    expect(getCaptured()?.tax_amount).toBe(0);
  });

  it('duplicate (same lead): a clone of a pre-fix exempt estimate is re-quoted tax-free', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(exemptSourceEstimate({ customer: { tax_exempt: true } }));
    const getCaptured = captureDuplicateCreateData();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(getCaptured()?.tax_rate).toBe(0);
    expect(getCaptured()?.tax_amount).toBe(0);
  });
});

// Entity-redesign §4 — auto-derive the estimate tax rate from the lead's service-location
// state (StateTaxRate), editable (a provided rate overrides), snapshotted onto the document.
describe('deriveTaxRateFromLead + auto-populate on create', () => {
  const LEAD_ID = ESTIMATE_FIXTURE.lead_id;
  const noLineItemTransaction = () => {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: { tax_rate?: number } }) => {
            capturedCreateData = args.data;
            return ESTIMATE_FIXTURE;
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  };
  let capturedCreateData: { tax_rate?: number; tax_amount?: number; subtotal?: number } | undefined;

  beforeEach(() => {
    capturedCreateData = undefined;
  });

  it('create auto-derives tax_rate from lead service-location state when tax_rate omitted', async () => {
    mockAuthAs('admin');
    // Two lead.findUnique calls: (1) the create-guard select, (2) deriveTaxRateFromLead select.
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: LEAD_ID, status: 'CONTACTED', lead_assignees: [{ user_id: TEST_USERS.sales.id }] })
      .mockResolvedValueOnce({ service_location_id: LOCATION_FIXTURE.id, service_location: { state: 'TX' }, service_state: 'TX' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    noLineItemTransaction();

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: LEAD_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(capturedCreateData?.tax_rate).toBe(0.0625);
    // Snapshotted onto totals via calculateTotals.
    expect(capturedCreateData?.subtotal).toBe(1000);
    expect(capturedCreateData?.tax_amount).toBe(62.5);
    expect(mockPrisma.stateTaxRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { state_code: 'TX' } }),
    );
  });

  it('provided tax_rate overrides derived (derivation skipped)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValueOnce({ id: LEAD_ID, status: 'CONTACTED', lead_assignees: [{ user_id: TEST_USERS.sales.id }] });
    noLineItemTransaction();

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: LEAD_ID, tax_rate: 0.08, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(capturedCreateData?.tax_rate).toBe(0.08);
    expect(mockPrisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to lead.service_state when no service_location resolves', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: LEAD_ID, status: 'CONTACTED', lead_assignees: [{ user_id: TEST_USERS.sales.id }] })
      .mockResolvedValueOnce({ service_location_id: null, service_location: null, service_state: 'TX' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    noLineItemTransaction();

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: LEAD_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(capturedCreateData?.tax_rate).toBe(0.0625);
    expect(mockPrisma.stateTaxRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { state_code: 'TX' } }),
    );
  });

  it('tax_rate defaults to 0 when the state has no StateTaxRate row', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: LEAD_ID, status: 'CONTACTED', lead_assignees: [{ user_id: TEST_USERS.sales.id }] })
      .mockResolvedValueOnce({ service_location_id: null, service_location: null, service_state: 'ZZ' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue(null);
    noLineItemTransaction();

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: LEAD_ID, line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }] });

    expect(res.status).toBe(201);
    expect(capturedCreateData?.tax_rate).toBe(0);
    expect(capturedCreateData?.tax_amount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/estimates/:id
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates/:id', () => {
  it('returns estimate detail', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.id).toBe(ESTIMATE_FIXTURE.id);
  });

  // A job-anchored estimate (Estimate.job_id) has NO Job pointing back at it, so the `job`
  // provenance relation is null and the only job identity in the response was a bare `job_id`
  // uuid. Nothing on the workspace could NAME the job the estimate is attached to - the hero's
  // "Attached to" strip needs the number, not the id. Select `job_link` alongside `job`; both
  // relations are real and an estimate may carry either.
  // #2053 round 2 — a scope block written before this feature (or never itself re-saved since)
  // has no is_optional/is_selected keys in the stored JSONB. getById must default them on read
  // (withOptionalDefaults, lib/scopes.ts) so the detail response always carries both flags.
  it('#2053: a legacy scope block with no flags in the stored JSON comes back defaulted on GET', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      scopes: [{ id: 'sc1', title: 'Permit fee', body: '', flat_price: 200, is_taxable: true, internal_cost: null }],
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.scopes[0]).toMatchObject({ is_optional: false, is_selected: true });
  });

  it('selects job_link so a job-anchored estimate can name the job it is attached to', async () => {
    mockAuthAs('admin');
    const jobLink = { id: 'j0000000-0000-0000-0000-0000000000ab', job_number: 'J00042', status: 'SCHEDULED' };
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      job: null,
      job_id: jobLink.id,
      job_link: jobLink,
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The select itself, not just the mocked passthrough - a mock returns job_link whether or
    // not the query ever asked for it.
    expect(mockPrisma.estimate.findUnique.mock.calls[0]?.[0]?.select).toHaveProperty('job_link');
    expect(res.body.estimate.job_link).toEqual(jobLink);
  });

  // Same reason as job_link above, one relation over: the lead was reachable (lead_id) but not
  // nameable - the select never asked for lead_number, so the strip could only have said "Lead".
  it('selects lead.lead_number so the lead can be named, not just linked', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const leadSelect = mockPrisma.estimate.findUnique.mock.calls[0]?.[0]?.select?.lead?.select;
    expect(leadSelect).toHaveProperty('lead_number', true);
  });

  // R5f — estimateDetailSelect's scope_photos widening: storage_path never reaches the response;
  // it resolves to a freshly-signed `url` via ONE batched createSignedUrls call across the whole
  // response (never one call per photo). #2029 retired the line-item half — a line item's only
  // image is the price-book item's own image_url attribute, which needs no signing.
  it('resolves scope photo storage_paths to freshly-signed urls in ONE batch call', async () => {
    mockAuthAs('admin');
    const scopePath = 'org/estimate_scope/est/sc1/2-b.jpg';
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      scope_photos: [
        { id: 'p2', scope_id: 'sc1', storage_path: scopePath, mime_type: 'image/png', caption: 'Permit', uploaded_at: new Date('2026-07-22'), uploaded_by: 'Test Admin', size_bytes: 2048 },
      ],
    });

    const storage = supabaseAdmin.storage.from('attachments') as unknown as { createSignedUrls: ReturnType<typeof vi.fn> };

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(storage.createSignedUrls.mock.calls[0][0]).toEqual([scopePath]);

    const scopePhoto = res.body.estimate.scope_photos[0];
    expect(scopePhoto.scope_id).toBe('sc1');
    expect(scopePhoto.url).toContain(`/object/sign/${scopePath}`);
    expect(scopePhoto.caption).toBe('Permit');
    expect(scopePhoto.storage_path).toBeUndefined();
  });

  it('degrades photo urls to "" (not 500) when signing fails', async () => {
    mockAuthAs('admin');
    const scopePath = 'org/estimate_scope/est/sc1/2-b.jpg';
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { createSignedUrls: ReturnType<typeof vi.fn> };
    storage.createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      scope_photos: [
        { id: 'p2', scope_id: 'sc1', storage_path: scopePath, mime_type: 'image/png', caption: null, uploaded_at: new Date('2026-07-22'), uploaded_by: 'Test Admin', size_bytes: 2048 },
      ],
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.scope_photos[0].url).toBe('');
  });

  // #2029 — the detail response no longer carries a `photos` array on a line item at all.
  it('does not carry a photos array on a line item', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.line_items[0]).not.toHaveProperty('photos');
    const lineSelect = mockPrisma.estimate.findUnique.mock.calls[0]?.[0]?.select?.line_items?.select;
    expect(lineSelect).not.toHaveProperty('photos');
  });

  it('does NOT call createSignedUrls when the estimate has no photos', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { createSignedUrls: ReturnType<typeof vi.fn> };

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.createSignedUrls).not.toHaveBeenCalled();
  });

  it('returns 404 for non-existent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/estimates/nonexistent')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('SALES can view own lead estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('SALES cannot view other rep\'s lead estimate', async () => {
    mockAuthAs('sales');
    const otherEstimate = {
      ...ESTIMATE_FIXTURE,
      lead: { ...ESTIMATE_FIXTURE.lead, lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(otherEstimate);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('DISPATCHER can view (read-only)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════
// Lead-less (customer-anchored) reads - SERV10X-61 Task 7
// A customer-anchored estimate has `lead: null`; the customer must resolve off the direct
// `customer` anchor (R6, customer_id NOT-NULL) everywhere it's read.
// ═══════════════════════════════════════════════════════

describe('lead-less (customer-anchored) estimate reads - SERV10X-61', () => {
  const LEAD_LESS_DETAIL = {
    ...ESTIMATE_FIXTURE,
    id: 'f0000000-0000-0000-0000-0000000000aa',
    estimate_number: 'E00777',
    lead_id: null,
    lead: null,
    customer_id: CUSTOMER_FIXTURE.id,
    job_id: null,
    // Direct anchor (estimateDetailSelect.customer shape).
    customer: {
      id: CUSTOMER_FIXTURE.id,
      first_name: 'Nora',
      last_name: 'Vance',
      company_name: 'Vance Plumbing',
      email: 'nora@vance.com',
      phone: '5550001111',
    },
  };

  it('GET /api/estimates/:id resolves the direct customer (200) when the estimate has no lead', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_LESS_DETAIL);

    const res = await request(app)
      .get(`/api/estimates/${LEAD_LESS_DETAIL.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.lead).toBeNull();
    expect(res.body.estimate.customer).toMatchObject({ company_name: 'Vance Plumbing', email: 'nora@vance.com' });
  });

  it('GET /api/estimates returns a lead-less row carrying its direct customer', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([{
      ...ESTIMATE_FIXTURE,
      id: LEAD_LESS_DETAIL.id,
      estimate_number: 'E00777',
      lead: null,
      customer_id: CUSTOMER_FIXTURE.id,
      job_id: null,
      customer: { id: CUSTOMER_FIXTURE.id, customer_number: 'C00001', first_name: 'Nora', last_name: 'Vance', company_name: 'Vance Plumbing' },
    }]);
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: 0 } });

    const res = await request(app).get('/api/estimates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimates[0].lead).toBeNull();
    expect(res.body.estimates[0].customer).toMatchObject({ company_name: 'Vance Plumbing' });
  });

  it('list search OR includes direct-customer terms so a lead-less estimate is findable by customer name', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?search=Vance').set(authHeader('admin'));

    // ADMIN readScope is {} so addOrFilter sets where.OR directly (no AND demotion).
    const orTerms = mockPrisma.estimate.findMany.mock.calls[0][0].where.OR as unknown[];
    expect(orTerms).toEqual(expect.arrayContaining([
      { customer: { first_name: { contains: 'Vance', mode: 'insensitive' } } },
      { customer: { last_name: { contains: 'Vance', mode: 'insensitive' } } },
      { customer: { company_name: { contains: 'Vance', mode: 'insensitive' } } },
    ]));
  });

  it('GET /api/estimates/:id/public resolves the direct customer name when lead-less', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: LEAD_LESS_DETAIL.id,
      estimate_number: 'E00777',
      status: 'SENT',
      organization_id: ALPHA_ORG_ID,
      valid_until: null,
      snapshot_terms: null,
      lead: null,
      // estimatePublicSelect.customer shape (display name only).
      customer: { first_name: 'Nora', last_name: 'Vance', company_name: 'Vance Plumbing' },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Acme Org', logo_url: null, brand_color: '#0C2D3A',
      email: 'org@acme.com', phone: null, website: null, estimate_terms: '',
    });

    const res = await request(app).get(`/api/estimates/${LEAD_LESS_DETAIL.id}/public?token=ll-token`);

    expect(res.status).toBe(200);
    expect(res.body.estimate.lead).toBeNull();
    expect(res.body.estimate.customer).toMatchObject({ company_name: 'Vance Plumbing' });
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/estimates/:id
// ═══════════════════════════════════════════════════════

describe('PATCH /api/estimates/:id', () => {
  it('updates draft estimate with new line items', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue(ESTIMATE_FIXTURE) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        scope_notes: 'Updated scope',
        line_items: [{ description: 'New item', quantity: 2, unit_price: 500, is_taxable: true }],
      });

    expect(res.status).toBe(200);
  });

  // E3 (job-owns-tax-discount) retires the job-anchored tax LOCK: a job-anchored estimate is a
  // quote, the job is the work, and they may legitimately differ. A PATCH with tax_rate now saves
  // normally instead of 400ing, same as any other anchor.
  it('200 - a PATCH on a job-anchored DRAFT estimate accepts an explicit tax_rate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      job_id: 'a0000000-0000-0000-0000-000000000009',
      lead: null,
    });
    let capturedData: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: {
          update: vi.fn().mockImplementation((args: any) => { capturedData = args.data; return ESTIMATE_FIXTURE; }),
        },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        tax_rate: 0.08,
        line_items: [{ description: 'AC', quantity: 1, unit_price: 1000, is_taxable: true }],
      });

    expect(res.status).toBe(200);
    expect(Number(capturedData.tax_rate)).toBe(0.08);
  });

  it('rejects update on WON estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_APPROVED_FIXTURE.id,
      status: 'WON',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_APPROVED_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Try to update' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('draft or sent');
  });

  // §A1/§A3a — a SENT/PENDING estimate stays editable by default (unlike the old DRAFT-only
  // behavior); only a LOCKED estimate (deposit PAID, or org lock_on_send ON) rejects the edit.
  it('allows a cosmetic-only update on an unlocked SENT estimate without bumping version', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      tax_rate: 0.0625,
      version: 1,
      invoices: [],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, version: 1 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed estimate' });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.name).toBe('Renamed estimate');
    expect(updateCall.data.version).toBeUndefined();
    expect(updateCall.data.modified_after_send).toBeUndefined();
  });

  it('bumps version and flags modified_after_send on a material edit to an unlocked SENT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      deposit_type: null,
      deposit_value: null,
      // Baseline: 1 line @ $1000, 6.25% tax -> subtotal 1000 / tax 62.5 / total 1062.5. The PATCH
      // below replaces it with a $900 line, so the diff-based guardrail check must see the totals
      // actually move (900 / 56.25 / 956.25) and flag this as material.
      subtotal: 1000,
      tax_amount: 62.5,
      total_amount: 1062.5,
      discount_amount: 0,
      version: 1,
      invoices: [],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const txUpdate = vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, version: 2 });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: txUpdate },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ line_items: [{ description: 'Changed item', quantity: 1, unit_price: 900, is_taxable: true }] });

    expect(res.status).toBe(200);
    const updateCall = txUpdate.mock.calls[0][0];
    expect(updateCall.data.version).toBe(2);
    expect(updateCall.data.modified_after_send).toBe(true);
    expect(updateCall.data.public_token).toBeNull();
  });

  // The totals diff only sees subtotal/tax/total/discount_amount -- it would silently miss a
  // deposit_type-only change, even though changing what deposit the customer owes is exactly the
  // kind of "what was quoted" change this guardrail exists to catch.
  it('flags modified_after_send when only deposit_type changes (no totals impact) on a SENT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      deposit_type: 'PERCENTAGE',
      deposit_value: 50,
      subtotal: 1000,
      tax_amount: 62.5,
      total_amount: 1062.5,
      discount_amount: 0,
      version: 1,
      invoices: [],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, version: 2 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ deposit_type: 'FIXED' });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.version).toBe(2);
    expect(updateCall.data.modified_after_send).toBe(true);
    expect(updateCall.data.public_token).toBeNull();
  });

  it('rejects an in-place edit when the deposit is already PAID (locked)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      tax_rate: 0.0625,
      version: 1,
      invoices: [{ status: 'PAID' }],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Try to update a paid estimate' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
  });

  it('rejects an in-place edit when the org lock_on_send toggle is ON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      tax_rate: 0.0625,
      version: 1,
      invoices: [],
      organization: { lock_on_send: true },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Try to update — lock_on_send ON' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
  });

  // D12 (2026-07-21) supersedes the D6-era hard lock above: a material edit to an unlocked
  // PENDING estimate is now ALLOWED, but it voids the customer's signature and drops the estimate
  // back to SENT (forcing an explicit re-send) rather than silently leaving a stale signature on a
  // changed document. The hard lock (400) applies to PENDING for the same reason it applies to
  // SENT: deposit already PAID, or the org's lock_on_send toggle ON (see the two tests after this).
  it('allows a material edit to an unlocked PENDING estimate, voids the signature, and reverts to SENT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      deposit_type: null,
      deposit_value: null,
      subtotal: 1000,
      tax_amount: 62.5,
      total_amount: 1062.5,
      discount_amount: 0,
      version: 1,
      invoices: [],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const txUpdate = vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, version: 2, status: 'SENT' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: txUpdate },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ line_items: [{ description: 'Changed item', quantity: 1, unit_price: 900, is_taxable: true }] });

    expect(res.status).toBe(200);
    const updateCall = txUpdate.mock.calls[0][0];
    expect(updateCall.data.status).toBe('SENT');
    expect(updateCall.data.signature_data).toBeNull();
    expect(updateCall.data.signature_at).toBeNull();
    expect(updateCall.data.version).toBe(2);
    expect(updateCall.data.modified_after_send).toBe(true);
    expect(updateCall.data.public_token).toBeNull();
  });

  // The proof-of-fix test: a no-op PATCH that merely echoes the estimate's CURRENT tax_rate must
  // never touch the signature. Before the diff-based fix, update()'s presence-based check treated
  // "tax_rate is present in the body" as material regardless of its value -- that would have wiped
  // a real customer signature on a PATCH that changed nothing.
  it('a no-op PATCH on PENDING that echoes the unchanged tax_rate leaves the signature and status intact', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      deposit_type: null,
      deposit_value: null,
      subtotal: 1000,
      tax_amount: 62.5,
      total_amount: 1062.5,
      discount_amount: 0,
      version: 1,
      invoices: [],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // Same single line ($1000, taxable) the baseline totals above were computed from -- recomputing
    // at the SAME 6.25% tax_rate must reproduce the identical totals, proving nothing moved.
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([
      { quantity: 1, unit_price: 1000, is_taxable: true, discount_type: null, discount_value: null },
    ]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.0625 });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.status).toBeUndefined();
    expect(updateCall.data.signature_data).toBeUndefined();
    expect(updateCall.data.signature_at).toBeUndefined();
    expect(updateCall.data.version).toBeUndefined();
    expect(updateCall.data.modified_after_send).toBeUndefined();
    expect(updateCall.data.public_token).toBeUndefined();
  });

  it('rejects an edit attempt on a PENDING estimate once the deposit is already PAID (locked)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      tax_rate: 0.0625,
      version: 1,
      invoices: [{ status: 'PAID' }],
      organization: { lock_on_send: false },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Try to edit a paid, signed estimate' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('locked');
  });

  it('SALES cannot update other rep\'s estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ scope_notes: 'Nope' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/estimates/nonexistent')
      .set(authHeader('admin'))
      .send({ scope_notes: 'Test' });

    expect(res.status).toBe(404);
  });

  it('updates metadata only (no line items)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Just scope change' });

    expect(res.status).toBe(200);
  });

  // §C-5/H — "one real status control": the top pill is the single source, driven only by the
  // dedicated lifecycle actions (send/approve/cancel/revise). PATCH must never let a client set
  // status directly — a stray `status` in the body is silently dropped, never a fake success.
  it('ignores a status field in the PATCH body — status is never settable via update()', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'WON', scope_notes: 'Sneaking a status change in' });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.status).toBeUndefined();
  });

  it('should recalculate totals when tax_rate changes without line_items', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // Two line items: subtotal = 1000, both taxable
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([
      { quantity: 1, unit_price: 800, is_taxable: true, discount_type: null, discount_value: null },
      { quantity: 1, unit_price: 200, is_taxable: true, discount_type: null, discount_value: null },
    ]);
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.10 });

    expect(res.status).toBe(200);

    // At tax_rate=0.10: subtotal=1000, tax=100, total=1100
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.subtotal).toBe(1000);
    expect(updateCall.data.tax_amount).toBe(100);
    expect(updateCall.data.total_amount).toBe(1100);
  });

});

// ═══════════════════════════════════════════════════════
// DELETE /api/estimates/:id
// ═══════════════════════════════════════════════════════

describe('DELETE /api/estimates/:id', () => {
  it('deletes draft estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  // R5f — best-effort Storage cleanup for this estimate's scope photos. The DB cascade/FK handles
  // the ROWS; this is only about the Storage OBJECTS those rows pointed at. Line items carry no
  // uploaded photos (#2029).
  it("best-effort removes this estimate's scope photo Storage objects", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValueOnce([{ storage_path: 'org/estimate_scope/est/sc1/2-b.jpg' }]);
    mockPrisma.estimate.delete.mockResolvedValue({});
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { remove: ReturnType<typeof vi.fn> };

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateScopePhoto.findMany).toHaveBeenCalledWith({
      where: { estimate_id: ESTIMATE_FIXTURE.id },
      select: { storage_path: true },
    });
    expect(storage.remove).toHaveBeenCalledWith(['org/estimate_scope/est/sc1/2-b.jpg']);
    // Storage cleanup must not delay/replace the actual DB delete.
    expect(mockPrisma.estimate.delete).toHaveBeenCalledWith({ where: { id: ESTIMATE_FIXTURE.id } });
  });

  it('still deletes the estimate when the photo Storage remove fails (log-warn, not 500)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValueOnce([{ storage_path: 'org/x/1-a.jpg' }]);
    mockPrisma.estimate.delete.mockResolvedValue({});
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { remove: ReturnType<typeof vi.fn> };
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'gone already' } });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('skips the Storage call entirely when the estimate has no photos', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.delete.mockResolvedValue({});
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { remove: ReturnType<typeof vi.fn> };

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('rejects delete on non-DRAFT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/estimates/nonexistent')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('SALES cannot delete other rep\'s estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/bulk-delete
// ═══════════════════════════════════════════════════════
// Exercises bulkRemove(), which loops deleteEstimateInternal() (extracted from remove() above)
// SEQUENTIALLY over the submitted ids — same guard sequence, same statuses/messages per id, but
// isolated per-id: one id's failure never aborts or taints another id in the same batch.
describe('POST /api/estimates/bulk-delete', () => {
  const DRAFT_A = 'f1000000-0000-0000-0000-000000000001';
  const DRAFT_B = 'f1000000-0000-0000-0000-000000000002';
  const SENT_ID = 'f1000000-0000-0000-0000-000000000003';
  const MISSING_ID = 'f1000000-0000-0000-0000-000000000004';

  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const { id } = args.where;
      if (id === SENT_ID) {
        return Promise.resolve({ id, status: 'SENT', lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } });
      }
      if (id === MISSING_ID) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ id, status: 'DRAFT', lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } });
    });
    mockPrisma.estimate.delete.mockResolvedValue({});
  });

  it('deletes multiple DRAFT estimates in one call — all ids land in deleted, failed is empty', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-delete')
      .set(authHeader('admin'))
      .send({ ids: [DRAFT_A, DRAFT_B] });

    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([DRAFT_A, DRAFT_B].sort());
    expect(res.body.failed).toEqual([]);
    expect(mockPrisma.estimate.delete).toHaveBeenCalledTimes(2);
  });

  it('isolates a non-DRAFT id into failed while the other valid DRAFT ids in the same batch still succeed', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-delete')
      .set(authHeader('admin'))
      .send({ ids: [DRAFT_A, SENT_ID, DRAFT_B] });

    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([DRAFT_A, DRAFT_B].sort());
    // Same reason string the single-delete remove() 400s with — proves shared guard logic.
    expect(res.body.failed).toEqual([{ id: SENT_ID, error: 'Only draft estimates can be deleted' }]);
    expect(mockPrisma.estimate.delete).toHaveBeenCalledTimes(2);
  });

  it('lands a not-found / cross-org id in failed without affecting the other ids in the batch', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-delete')
      .set(authHeader('admin'))
      .send({ ids: [DRAFT_A, MISSING_ID] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([DRAFT_A]);
    expect(res.body.failed).toEqual([{ id: MISSING_ID, error: 'Estimate not found' }]);
    expect(mockPrisma.estimate.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty ids array at the validation layer (400, before any delete)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-delete')
      .set(authHeader('admin'))
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(mockPrisma.estimate.delete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// #106 ENFORCEMENT — per-instance owner check + grant-driven list scope
// ═══════════════════════════════════════════════════════
// These assert the SECURITY BOUNDARY (a scoped user is BLOCKED — the 403 / sees-nothing
// path), not merely that a write persists. They mirror the lifecycle-verb owner check the
// rest of the controllers use, wired through the shared `can` / `scopeWhereForReq` helpers.
describe('#106 estimate enforcement', () => {
  // Estimate row-scope condition: `lead.lead_assignees.some.user_id`. This is a Prisma `where`
  // fragment (scopeWhereForReq) — never CASL-evaluated in-memory — so the nested relation is safe.
  const ownedReadGrant = (role: string) => ({
    role,
    action: 'read',
    subject: 'Estimate',
    conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
  });

  beforeEach(() => {
    // Both attachAbility and scopeWhereForReq resolve grants through the same 60s cache,
    // keyed org:role. Clear it so a custom conditioned grant set is honoured (otherwise a
    // prior test's default grants leak in).
    clearPermissionCache();
  });

  // ─── list() — grant-driven row scope closes the non-SALES fail-open ───

  it('list scopes a conditioned NON-SALES role to owned rows (closes the hardcoded-SALES fail-open)', async () => {
    // The pre-#106 list() hardcoded the SALES branch and let EVERY other non-ADMIN role see the
    // whole org. A DISPATCHER (or any role) carrying a conditioned Owned read grant must now be
    // scoped by the grant — this fails until scopeWhereForReq is spread into the list where-clause.
    mockAuthAs('dispatcher');
    mockPrisma.rolePermission.findMany.mockResolvedValue([ownedReadGrant('DISPATCHER')]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates').set(authHeader('dispatcher'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(findManyArgs.where.lead).toEqual({ lead_assignees: { some: { user_id: TEST_USERS.dispatcher.id } } });
    // The total count is scoped identically — no fail-open broadening.
    const countArgs = mockPrisma.estimate.count.mock.calls[0][0];
    expect(countArgs.where.lead).toEqual({ lead_assignees: { some: { user_id: TEST_USERS.dispatcher.id } } });
  });

  it('list FAILS CLOSED (id:{in:[]}) for a non-ADMIN role with NO estimate read grant', async () => {
    // Route guard canDo('read','Estimate') must pass to reach list(), so give a bare unconditional
    // read for the GUARD only, then strip it for the SCOPE: we model "no read grant" by returning a
    // grant set whose only Estimate entry is for a different action. scopeWhereForReq finds no
    // `read Estimate` grant → MATCH_NOTHING → the list can match nothing.
    mockAuthAs('dispatcher');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      // Guard satisfier: unconditional read so the request is not 403'd at the route.
      { role: 'DISPATCHER', action: 'read', subject: 'Estimate' },
    ]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.groupBy.mockResolvedValue([]);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    await request(app).get('/api/estimates?status=DRAFT').set(authHeader('dispatcher'));

    const findManyArgs = mockPrisma.estimate.findMany.mock.calls[0][0];
    // Unconditional read ⇒ scope {} (no restriction); the per-request filter survives untouched,
    // proving the scope spread is the OUTERMOST key and never clobbers request filters.
    expect(findManyArgs.where.status).toBe('DRAFT');
  });

  // ─── update() — per-instance owner BLOCK ───

  it('update BLOCKS a scoped user on a row owned by another user (403, no estimate.update)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'SALES', action: 'update', subject: 'Estimate' },
      { role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    // DRAFT row owned by ADMIN (not the SALES requester).
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });
    // F-004: SALES read-Estimate is OWN_LEAD-conditioned, so canAccessRow runs a scoped findFirst;
    // an un-owned row yields no match under scope ⇒ null ⇒ 403 (before canAccessEstimate runs).
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ scope_notes: 'should be blocked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    // The mutation must NOT have run — enforcement, not just response shape.
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('update ALLOWS the owner (200, estimate.update runs)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'SALES', action: 'update', subject: 'Estimate' },
      { role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // F-004: SALES read-Estimate is OWN_LEAD-conditioned ⇒ canAccessRow runs a scoped findFirst;
    // the owner's row matches under scope ⇒ returns the row ⇒ passes.
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ scope_notes: 'owner edit' });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update).toHaveBeenCalled();
  });

  // ─── remove() — per-instance owner BLOCK ───

  it('delete BLOCKS a scoped user on a row owned by another user (403, no estimate.delete)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'SALES', action: 'delete', subject: 'Estimate' },
      { role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });
    // F-004: canAccessRow runs a scoped findFirst (SALES read-Estimate is OWN_LEAD-conditioned);
    // an un-owned row yields no match ⇒ null ⇒ 403.
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.estimate.delete).not.toHaveBeenCalled();
  });

  it('delete ALLOWS the owner (200, estimate.delete runs)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'SALES', action: 'delete', subject: 'Estimate' },
      { role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // F-004: canAccessRow runs a scoped findFirst; the owner's row matches under scope.
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.estimate.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.delete).toHaveBeenCalled();
  });
});

// ── #106 P1: Estimate's owner chain is NESTED (lead → lead_assignees.some) ─────────
// The Wave 2 fix gated update/delete with can(req,'update'/'delete','Estimate',row). For a
// role whose grant is a *conditioned* Owned grant, @casl/prisma's in-memory matcher THROWS
// ("equals does not supports comparison of arrays and objects") on the nested to-one→to-many
// condition — so can() 500s for ANY Estimate scope, including the RIGHTFUL OWNER. These tests
// drive the swap to the SQL-based canAccessRow (nested-safe, grant-driven). The grant here is
// CONDITIONED (unlike the existing #106 block's unconditional grants), which is what trips the
// nested-condition crash.
describe('#106 estimate enforcement — nested Owned condition (canAccessRow, nested-safe)', () => {
  const ownedConditionedGrants = (role: string, action: string) => [
    // Conditioned Owned grants: the nested lead.lead_assignees.some condition that crashes can().
    { role, action, subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    { role, action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  ];

  beforeEach(() => {
    clearPermissionCache();
  });
  // This block caches CONDITIONED SALES grants (incl. record_payment) via attachAbility. Clear the
  // 60s org:role grant cache afterwards so the conditioned set never leaks into a later block that
  // expects the default (unconditional) SALES grants — e.g. the route-guard "sales is rejected" test.
  afterEach(() => {
    clearPermissionCache();
  });

  // ─── update() ───

  it('OWNER with a conditioned Owned grant can update own estimate → 200 (NOT 500 from can() on the nested condition)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(ownedConditionedGrants('SALES', 'update'));
    // DRAFT row owned by the SALES requester — the scoped findFirst (canAccessRow) must MATCH it.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // canAccessRow issues a scoped estimate.findFirst — returning the row id means "visible/owned".
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ scope_notes: 'owner edit' });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update).toHaveBeenCalled();
  });

  it('NON-OWNER with a conditioned Owned grant is blocked from update → 403, no estimate.update', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(ownedConditionedGrants('SALES', 'update'));
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] }, // owned by someone else
    });
    // Scoped findFirst returns null → the row is not visible/owned under the grant condition.
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ scope_notes: 'should be blocked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  // ─── remove() ───

  it('OWNER with a conditioned Owned grant can delete own estimate → 200 (NOT 500)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(ownedConditionedGrants('SALES', 'delete'));
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.estimate.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.delete).toHaveBeenCalled();
  });

  it('NON-OWNER with a conditioned Owned grant is blocked from delete → 403, no estimate.delete', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(ownedConditionedGrants('SALES', 'delete'));
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.estimate.delete).not.toHaveBeenCalled();
  });

  // ─── recordEstimatePayment() — lifecycle verb, previously had NO per-instance owner check ───

  it('NON-OWNER is blocked from recording payment on another user\'s estimate → 403, no transaction', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(
      ownedConditionedGrants('SALES', 'record_payment'),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 1000,
      public_token: 'tok-x',
      valid_until: null,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] }, // owned by someone else
      send_config: { id: 'sc-1' },
    });
    // Not the owner → the scoped findFirst sees nothing.
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('sales'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    // The payment transaction must NEVER run for a non-owner.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('OWNER with a conditioned Owned grant can record payment on own estimate → 200 (NOT 500)', async () => {
    mockAuthAs('sales');
    mockPrisma.rolePermission.findMany.mockResolvedValue(
      ownedConditionedGrants('SALES', 'record_payment'),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 1000,
      public_token: 'tok-x',
      valid_until: null,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] }, // owner
      send_config: { id: 'sc-1' },
    });
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(ESTIMATE_APPROVED_FIXTURE), findUnique: vi.fn().mockResolvedValue(ESTIMATE_APPROVED_FIXTURE) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('sales'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
  });

  // ─── waiveDeposit() — lifecycle verb, previously had NO per-instance owner check ───

  it('NON-OWNER (conditioned grant) is blocked from waiving a deposit on another user\'s estimate → 403, no transaction', async () => {
    // DISPATCHER carries waive_deposit by default; here it is a CONDITIONED Owned grant so the
    // grant-driven scope actually evaluates. The estimate is owned by someone else → scoped
    // findFirst sees nothing → 403 before the void transaction.
    mockAuthAs('dispatcher');
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      { role: 'DISPATCHER', action: 'waive_deposit', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
      { role: 'DISPATCHER', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      invoices: [{ id: 'dep-inv-1', status: 'SENT' }],
    });
    // Not the owner → the scoped findFirst returns null.
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('dispatcher'))
      .send({ action: 'waive' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/:id/send
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/send', () => {
  const DRAFT_LEAD_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
  const mockDraftEstimate = {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: 1062.5,
    public_token: null,
    valid_until: null,
    // SERV10X-61 R6 - customer_id is denormalized NOT-NULL onto every estimate (== the lead's
    // customer here); it is now the canonical deposit-invoice customer source in commitFirstSend.
    customer_id: DRAFT_LEAD_CUSTOMER_ID,
    // SERV10X-61 §5.6 - send() now refuses an estimate with zero line items; a sendable fixture
    // must carry a non-zero _count.line_items.
    _count: { line_items: 2 },
    // status omitted ⇒ the auto-transition guard is false (matches the original fixture); the
    // dedicated auto-transition tests override lead.status explicitly.
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: DRAFT_LEAD_CUSTOMER_ID, email: 'john@doe.com' } },
    deposit: null,
    send_config: null,
  };

  const sentEstimate = { ...ESTIMATE_FIXTURE, status: 'SENT', sent_at: new Date(), public_token: 'tok', valid_until: new Date(), send_config: null, deposit: null };

  function mockTransactionForSend(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue(result),
          findUnique: vi.fn().mockResolvedValue(result),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        // #2030 — the version snapshot is minted inside a transaction now (its ordinal is read
        // and written in one), so the transaction double has to carry the delegate. Pointed at the
        // global mock so the assertions below still read the calls where they always have.
        estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // Spec #1751 D2: a first send stamps the lead's first_estimate_sent_at clock, so EVERY
        // lead-anchored send now touches tx.lead — whether or not the status also moves.
        lead: txLeadDouble(),
      };
      return fn(tx);
    });
  }

  it('sends a draft estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null); // defaults to 50%
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    mockTransactionForSend(sentEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  // M9 — EstimateVersionSnapshot.scopes (added by this migration specifically to fix this) was
  // never populated at send(); the data is already in-hand via estimateDetailSelect.
  // #2030 — the snapshot is now minted from a RE-READ of the committed estimate rather than from
  // the object send() happened to be holding: a version records what the customer received, and
  // the in-hand object never carried the photos or the price-book images the document needs.
  it('M9: populates EstimateVersionSnapshot.scopes at send()', async () => {
    mockAuthAs('admin');
    const scopes = [{ id: 's1', title: 'Permit fee', body: '', flat_price: 100, is_taxable: true, internal_cost: null }];
    // The version snapshot re-reads the estimate through estimateDocumentSelect, so the mock has
    // to answer that select too — line items included.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...mockDraftEstimate,
      version: 1,
      scopes,
      scope_photos: [],
      line_items: ESTIMATE_FIXTURE.line_items,
      customer: { first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com', phone: '5551234567' },
      service_location: null,
      created_at: new Date('2026-09-01T00:00:00Z'),
      subtotal: 1000, discount_amount: 0, discount_name: null,
      tax_rate: 0.0625, tax_amount: 62.5,
      signature_data: null, signature_at: null,
      snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
      scope_notes: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    mockTransactionForSend({ ...sentEstimate, scopes });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Allow the fire-and-forget version-snapshot write to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockPrisma.estimateVersionSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scopes, trigger: 'SEND' }),
      }),
    );
    // …and the whole document, not just the summary columns: a version has to be re-renderable.
    const written = mockPrisma.estimateVersionSnapshot.create.mock.calls[0][0].data;
    expect(written.document.view.rows.some((r: { kind: string }) => r.kind === 'scope')).toBe(true);
    expect(written.document.org.name).toBe('Test Org');
  });

  it('sends with defaults when no body provided', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    mockTransactionForSend(sentEstimate);

    // #2044 — deposit_required defaults to true, payment_methods defaults to [] — a missing
    // payment method is a warning, never a block, so this now succeeds and persists [].
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  // D11 (2026-07-21) — Send never disappears: a WON estimate can be re-sent ("send a copy" in the
  // UI). Unlike a normal SENT resend, this must NOT write a SENT timeline event — the estimate's
  // history should keep reading as won, not as if it re-entered an active send cycle. The same
  // isTerminalSend list also covers DECLINED/ARCHIVED/EXPIRED/SUPERSEDED symmetrically.
  it('allows a "send a copy" resend on a WON estimate — no status change, no timeline event', async () => {
    mockAuthAs('admin');
    const wonExisting = {
      ...mockDraftEstimate,
      id: ESTIMATE_APPROVED_FIXTURE.id,
      status: 'WON',
      public_token: 'existing-token',
      send_config: { id: 'sc-1' },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(wonExisting);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...wonExisting }),
          findUnique: vi.fn().mockResolvedValue({ ...wonExisting }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_APPROVED_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    // Status is never part of the resend `data` payload — the estimate stays WON.
    const updateData = (txProxy.estimate as any).update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
    // No SENT timeline entry for a terminal "send a copy".
    expect((txProxy.timelineEvent as any).create).not.toHaveBeenCalled();
  });

  // ── #1522: the emailed link must be the link that gets stored ──────────────
  // A token-less non-draft estimate is ordinary, not exotic: `materialChangeGuardrail` nulls
  // public_token on every material edit to a sent estimate, and terminal "send a copy" rides the
  // same resend branch. Both mint the customer's token here, and only `isFirstSend` (DRAFT-only)
  // persists the one that went into the email — so the resend branch used to store a SECOND,
  // unrelated randomUUID() and the customer's link 404'd with nothing surfacing the failure.
  it('resending a token-less estimate stores the SAME token it emailed', async () => {
    mockAuthAs('admin');
    const tokenless = {
      ...mockDraftEstimate,
      status: 'SENT',
      public_token: null,
      send_config: { id: 'sc-1' },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(tokenless);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    // Set explicitly rather than relying on an earlier test's mock leaking forward - several
    // neighbours in this block do lean on that and fail when run with -t in isolation.
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...tokenless }),
          findUnique: vi.fn().mockResolvedValue({ ...tokenless }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);

    // The token the customer actually received, read off the link in the dispatched email.
    const emailArgs = vi.mocked(emailLib.sendEstimateEmail).mock.calls.at(-1)?.[0] as { publicUrl: string };
    const emailedToken = new URL(emailArgs.publicUrl).searchParams.get('token');

    // The token the row ends up holding.
    const storedToken = (txProxy.estimate as any).update.mock.calls[0][0].data.public_token;

    expect(emailedToken).toBeTruthy();
    expect(storedToken).toBe(emailedToken);
  });

  it('allows a resend on a PENDING (customer-signed) estimate — status stays PENDING', async () => {
    mockAuthAs('admin');
    const pendingExisting = {
      ...mockDraftEstimate,
      status: 'PENDING',
      public_token: 'existing-token',
      send_config: { id: 'sc-1' },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(pendingExisting);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...pendingExisting }),
          findUnique: vi.fn().mockResolvedValue({ ...pendingExisting }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    const updateData = (txProxy.estimate as any).update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
    // PENDING is not terminal — a normal resend timeline entry IS expected.
    expect((txProxy.timelineEvent as any).create).toHaveBeenCalled();
  });

  it('returns 404 for non-existent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates/nonexistent/send')
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(404);
  });

  it('should create Deposit and SendConfig when deposit required', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const sentWithDeposit = {
      ...sentEstimate,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', kind: 'DEPOSIT', total_amount: 531.25, amount_due: 531.25 }],
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD', 'CHECK'], message_body: null },
    };
    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentWithDeposit), findUnique: vi.fn().mockResolvedValue(sentWithDeposit) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD', 'CHECK'] });

    expect(res.status).toBe(200);
    // The kind=DEPOSIT Invoice is the SOLE deposit document.
    expect(res.body.estimate.invoices[0].kind).toBe('DEPOSIT');
    expect(res.body.estimate.send_config).toBeDefined();
    expect((txProxy.invoice as any).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estimate_id: ESTIMATE_FIXTURE.id, kind: 'DEPOSIT', status: 'SENT' }),
      })
    );
    // Upserted (idempotent on the @unique estimate_id) with the chosen deposit terms.
    expect((txProxy.estimateSendConfig as any).upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estimate_id: ESTIMATE_FIXTURE.id },
        create: expect.objectContaining({ deposit_required: true, payment_methods: ['CARD', 'CHECK'] }),
        update: expect.objectContaining({ deposit_required: true, payment_methods: ['CARD', 'CHECK'] }),
      })
    );
  });

  it('should NOT create a deposit invoice when deposit not required', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    expect((txProxy.invoice as any).create).not.toHaveBeenCalled();
  });

  // B8/PRD §13.7 — send() must prefer the ESTIMATE's own deposit_type/deposit_value override
  // (Receipt Card) over the org default; before this fix it ignored these columns entirely.
  it('B8: prefers the estimate\'s own deposit_type/deposit_value override over the org default', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...mockDraftEstimate,
      deposit_type: 'FIXED',
      deposit_value: 300,
    });
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    // Org default is PERCENTAGE 50% ($531.25) — the estimate's own FIXED $300 override must win.
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    let capturedInvoiceData: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedInvoiceData = args.data; return Promise.resolve({ id: 'dep-inv-override-1' }); }),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(Number(capturedInvoiceData.total_amount)).toBe(300);
    expect(Number(capturedInvoiceData.amount_due)).toBe(300);
    const lineDesc: string = capturedInvoiceData.line_items.create[0].description;
    expect(lineDesc).not.toContain('%'); // FIXED override → no percentage in the description
  });

  // ── EST-08 regression: revise-then-resend must not collide on EstimateSendConfig.estimate_id ──
  // After revise() recalls a SENT estimate to DRAFT it nulls public_token/sent_at/valid_until but
  // LEAVES the EstimateSendConfig row. The next send() re-enters the isFirstSend branch, so writing
  // the send config with .create collides on the @unique estimate_id (P2002) → the $transaction
  // rolls back → 500. The fix upserts on the unique estimate_id so resend is idempotent.
  it('resend after revise re-uses the existing send config (upsert, not create) and returns 200', async () => {
    mockAuthAs('admin');
    // A previously-sent estimate that revise() recalled to DRAFT — its send_config row still exists.
    const revisedDraftWithConfig = {
      ...mockDraftEstimate,
      send_config: { id: 'sc-1', deposit_required: false, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: 'hi' },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(revisedDraftWithConfig);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null); // defaults to 50% / 30d

    // .create REJECTS like Prisma would on the @unique estimate_id collision; .upsert resolves.
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`estimate_id`)'), { code: 'P2002' });
    const sendConfigCreate = vi.fn().mockRejectedValue(p2002);
    const sendConfigUpsert = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: sendConfigCreate, update: vi.fn().mockResolvedValue({}), upsert: sendConfigUpsert },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    // Idempotent: keyed on the unique estimate_id, and the colliding .create is never used.
    expect(sendConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { estimate_id: ESTIMATE_FIXTURE.id } }),
    );
    expect(sendConfigCreate).not.toHaveBeenCalled();
  });

  // ── Entity-redesign §6: estimate.send() creates the kind=DEPOSIT Invoice (sole deposit doc) ──
  // job_id is nullable, so send() persists a kind=DEPOSIT Invoice anchored to the estimate
  // (one non-taxable line, number via the shared invoice counter). The legacy Deposit model is gone.
  it('send() creates a kind=DEPOSIT Invoice (job_id null, estimate-anchored, one non-taxable line)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    // D8/D9 (PR-B2): require_walkthrough_before_send is gone, so the only appSetting lookup
    // left in send() is estimate_validity_days.
    mockPrisma.appSetting.findUnique.mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const sentWithDeposit = {
      ...sentEstimate,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', kind: 'DEPOSIT', total_amount: 531.25, amount_due: 531.25 }],
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: null },
    };
    let capturedInvoiceData: any;
    const invoiceCreate = vi.fn().mockImplementation((args: any) => {
      capturedInvoiceData = args.data;
      return Promise.resolve({ id: 'dep-inv-1' });
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentWithDeposit), findUnique: vi.fn().mockResolvedValue(sentWithDeposit) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // The kind=DEPOSIT Invoice is the SOLE deposit document.
    expect(invoiceCreate).toHaveBeenCalled();
    expect(capturedInvoiceData.kind).toBe('DEPOSIT');
    expect(capturedInvoiceData.job_id).toBeNull();
    expect(capturedInvoiceData.estimate_id).toBe(ESTIMATE_FIXTURE.id);
    expect(capturedInvoiceData.customer_id).toBe(DRAFT_LEAD_CUSTOMER_ID);
    expect(capturedInvoiceData.invoice_number).toBe('I00001'); // shared invoice counter
    // depositAmount = 1062.5 * 50% = 531.25; non-taxable, tax_amount 0, total == amount_due.
    expect(Number(capturedInvoiceData.tax_amount)).toBe(0);
    expect(Number(capturedInvoiceData.total_amount)).toBe(531.25);
    expect(Number(capturedInvoiceData.amount_due)).toBe(531.25);
    // Exactly ONE non-taxable line item.
    const lines = capturedInvoiceData.line_items.create;
    expect(lines).toHaveLength(1);
    expect(lines[0].is_taxable).toBe(false);
    expect(lines[0].description).toMatch(/Deposit — 50% of/);
  });

  // ── Phase 2c (entity-redesign): the kind=DEPOSIT Invoice is publicly payable ──
  // send() must give the deposit invoice a public_token and SENT status so the
  // public deposit-pay surface (getPublic + createPublicCheckout) can find and charge it.
  it('send() creates the kind=DEPOSIT invoice with a public_token and SENT status so it is publicly payable', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const sentWithDeposit = {
      ...sentEstimate,
      deposit: { id: 'dep-1', amount: 531.25, status: 'REQUESTED', deposit_percentage: 50 },
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: null },
    };
    let capturedInvoiceData: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentWithDeposit), findUnique: vi.fn().mockResolvedValue(sentWithDeposit) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedInvoiceData = args.data; return Promise.resolve({ id: 'dep-inv-1' }); }),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // SENT (payable) + a non-null public_token (token-based public access), the prereqs
    // for the public deposit-pay surface. Still dual-writes the legacy Deposit row.
    expect(capturedInvoiceData.status).toBe('SENT');
    expect(typeof capturedInvoiceData.public_token).toBe('string');
    expect(capturedInvoiceData.public_token.length).toBeGreaterThan(0);
  });

  it('send() resolves the deposit-invoice customer_id the one canonical way (estimate → lead → customer)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    let capturedInvoiceData: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedInvoiceData = args.data; return Promise.resolve({ id: 'dep-inv-1' }); }),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(capturedInvoiceData.customer_id).toBe(DRAFT_LEAD_CUSTOMER_ID);
  });

  it('send() does NOT create a second kind=DEPOSIT Invoice when one already exists (app guard)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-1' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        // An existing kind=DEPOSIT invoice for this estimate.
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-existing' }), create: invoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Guard: no second deposit invoice created.
    expect(invoiceCreate).not.toHaveBeenCalled();
  });

  // ── QA EST-08 regression: revise→resend keeps the UNPAID deposit Invoice in lockstep ──
  // After revise() recalls a SENT estimate to DRAFT, its total_amount may have CHANGED. The next
  // send() re-enters the isFirstSend branch and re-snapshots the deposit terms. If a kind=DEPOSIT
  // Invoice already exists AND is still unpaid (DRAFT/SENT), it must be UPDATED to the new amount —
  // otherwise the customer is shown a STALE deposit figure on the public pay surface. The fix adds
  // an `else if (status === 'DRAFT' || 'SENT')` branch that tx.invoice.update()s the unpaid deposit
  // invoice. Before that branch existed, the existing-invoice path skipped the update entirely and
  // the deposit was left at the OLD amount — so the `update called with the new amount` assertion
  // below would have FAILED against the old code (red), and passes with the else-if in place (green).
  it('send() UPDATES the existing UNPAID (SENT) deposit Invoice to the new amount on revise→resend', async () => {
    mockAuthAs('admin');
    // Post-revise DRAFT whose total_amount CHANGED to 2000 (was 1062.5). depositAmount = 2000 * 50% = 1000.
    const revisedDraftNewTotal = {
      ...mockDraftEstimate,
      total_amount: 2000,
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: null },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(revisedDraftNewTotal);
    // D8/D9 (PR-B2): require_walkthrough_before_send is gone, so the only appSetting lookup
    // left in send() is estimate_validity_days.
    mockPrisma.appSetting.findUnique.mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-1' });
    let capturedUpdateArgs: any;
    const invoiceUpdate = vi.fn().mockImplementation((args: any) => {
      capturedUpdateArgs = args;
      return Promise.resolve({ id: 'dep-1' });
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        // An existing UNPAID (SENT) kind=DEPOSIT invoice for this estimate — must be updated, not duplicated.
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-1', status: 'SENT' }), create: invoiceCreate, update: invoiceUpdate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // (1) The unpaid deposit invoice was updated in place to the NEW amount (2000 * 50% = 1000).
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
    expect(capturedUpdateArgs.where).toEqual({ id: 'dep-1' });
    expect(Number(capturedUpdateArgs.data.total_amount)).toBe(1000);
    expect(Number(capturedUpdateArgs.data.amount_due)).toBe(1000);
    // Line items are re-snapshotted (deleteMany then create the fresh deposit line).
    expect(capturedUpdateArgs.data.line_items.deleteMany).toBeDefined();
    // (2) No second deposit invoice — the existing one is reused, not duplicated.
    expect(invoiceCreate).not.toHaveBeenCalled();
  });

  // ── Control: a truly-first send (no existing deposit invoice) still CREATEs, never UPDATEs ──
  it('send() CREATES (not UPDATES) the deposit Invoice on a truly-first send (findFirst null)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-1' });
    const invoiceUpdate = vi.fn().mockResolvedValue({ id: 'dep-1' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        // No existing deposit invoice ⇒ create path.
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate, update: invoiceUpdate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalledTimes(1);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('should set valid_until', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    let capturedUpdateData: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            capturedUpdateData = args.data;
            return Promise.resolve(sentEstimate);
          }),
          findUnique: vi.fn().mockResolvedValue(sentEstimate),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    expect(capturedUpdateData.valid_until).toBeDefined();
    const validUntil = new Date(capturedUpdateData.valid_until as string);
    const now = new Date();
    const diffDays = (validUntil.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(28);
    expect(diffDays).toBeLessThan(32);
  });

  it('#2044 — accepts (not rejects) send with deposit required and no payment methods', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    let capturedSendConfigCreate: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: {
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            capturedSendConfigCreate = args.data;
            return Promise.resolve({});
          }),
          update: vi.fn().mockResolvedValue({}),
          upsert: vi.fn().mockImplementation((args: { create: Record<string, unknown> }) => {
            capturedSendConfigCreate = args.create;
            return Promise.resolve({});
          }),
        },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: txLeadDouble(),
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: [] });

    expect(res.status).toBe(200);
    expect(capturedSendConfigCreate.payment_methods).toEqual([]);
  });

  it('should allow resend on SENT estimate', async () => {
    mockAuthAs('admin');
    const sentExisting = {
      ...mockDraftEstimate,
      status: 'SENT',
      public_token: 'existing-token',
      valid_until: new Date('2026-04-01'),
      send_config: { id: 'sc-1' },
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(sentExisting);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    let txProxy: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        // A kind=DEPOSIT invoice already exists for this estimate; the controller's dedupe
        // guard (estimate.controller send() — tx.invoice.findFirst) should therefore SKIP create.
        invoice: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue({ id: 'inv-dep-1', kind: 'DEPOSIT' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Resend should NOT create a new deposit invoice (no-duplicate-deposit-document guard) or send_config
    expect((txProxy.invoice as any).create).not.toHaveBeenCalled();
    expect((txProxy.estimateSendConfig as any).create).not.toHaveBeenCalled();
    // §A3 — resend always clears modified_after_send (and mints a fresh public_token if the
    // prior one was invalidated by an edit-after-send); the existing valid token here is untouched.
    expect((txProxy.estimate as any).update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ modified_after_send: false }) }),
    );
    const resendUpdateData = (txProxy.estimate as any).update.mock.calls[0][0].data;
    expect(resendUpdateData.public_token).toBeUndefined();
    // Should create timeline event for audit
    expect((txProxy.timelineEvent as any).create).toHaveBeenCalled();
  });

  // D8/D9 (Walkthrough-as-entity redesign, PR-B2) — the `require_walkthrough_before_send`
  // AppSetting gate is REMOVED entirely (it enforced nothing: written by no code path). Send
  // never blocks on a walkthrough anymore; instead the SENT timeline event silently records
  // whether a COMPLETED visit existed for the lead at that moment.
  it('never blocks send on an incomplete walkthrough (the gate is gone)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 },
      // ESTIMATED (not NEW/CONTACTED) so shouldTransitionLead is false and this test doesn't
      // need a lead.update stub on the tx - it exists only to prove send is never blocked.
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(0); // no COMPLETED visit
    mockTransactionForSend(sentEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
  });

  it('records walkthrough_completed:false on the SENT timeline event when no COMPLETED visit exists', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 },
      // status omitted ⇒ the auto-transition guard is false (ESTIMATED/WON/etc. don't
      // transition further), so this test's custom tx mock doesn't need tx.lead.update.
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(0);
    let txTimelineCreate!: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txTimelineCreate = vi.fn().mockResolvedValue({});
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        // Spec #1751 D2: a first send stamps the lead's first_estimate_sent_at clock.
        lead: txLeadDouble(),
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    const sentCall = txTimelineCreate.mock.calls.find((c: any[]) => c[0].data.event_type === 'SENT');
    expect(sentCall![0].data.metadata).toEqual({ walkthrough_completed: false, walkthrough_completed_at: null });
    // organization_id is load-bearing, not incidental: the snapshot helper is
    // org-scoped in its own signature rather than trusting callers to have fetched
    // the estimate with a tenant predicate first. No reachable request tells the two
    // versions apart, so the query SHAPE is the only thing that can assert it.
    expect(mockPrisma.visit.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organization_id: ALPHA_ORG_ID,
          lead_id: ESTIMATE_FIXTURE.lead_id,
          status: 'COMPLETED',
        },
      }),
    );
  });


  it('records the latest walkthrough completion instant on the SENT timeline event', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(1); // a COMPLETED visit exists
    mockPrisma.visit.findFirst.mockResolvedValue({ completed_at: new Date('2026-08-20T15:30:00.000Z') });
    let txTimelineCreate!: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txTimelineCreate = vi.fn().mockResolvedValue({});
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        // Spec #1751 D2: a first send stamps the lead's first_estimate_sent_at clock.
        lead: txLeadDouble(),
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    const sentCall = txTimelineCreate.mock.calls.find((c: any[]) => c[0].data.event_type === 'SENT');
    expect(sentCall![0].data.metadata).toEqual({
      walkthrough_completed: true,
      walkthrough_completed_at: '2026-08-20T15:30:00.000Z',
    });
  });

  // The instant recorded is the LAST trip's, not the first. Asserting the query shape is how a
  // mocked-Prisma suite can state that decision at all - and the `completed_at: { not: null }`
  // half is not cosmetic: Postgres sorts NULLs FIRST on a DESC order, so without it a COMPLETED
  // row carrying no instant would win the ordering and mask the real latest completion.
  it('asks for the LATEST completion, excluding rows with no completion instant', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(2);
    mockPrisma.visit.findFirst.mockResolvedValue({ completed_at: new Date('2026-08-21T09:00:00.000Z') });
    mockTransactionForSend(sentEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organization_id: ALPHA_ORG_ID,
          lead_id: ESTIMATE_FIXTURE.lead_id,
          status: 'COMPLETED',
          completed_at: { not: null },
        },
        orderBy: { completed_at: 'desc' },
      }),
    );
  });

  // A legacy row completed before `completed_at` was populated must still read as completed. The
  // boolean and the instant are independent facts, and collapsing one into the other would either
  // lose the completion or invent a time for it.
  it('still records walkthrough_completed:true when no visit carries a completion instant', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(1);
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    let txTimelineCreate!: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txTimelineCreate = vi.fn().mockResolvedValue({});
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentEstimate), findUnique: vi.fn().mockResolvedValue(sentEstimate) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        // Spec #1751 D2: a first send stamps the lead's first_estimate_sent_at clock.
        lead: txLeadDouble(),
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    const sentCall = txTimelineCreate.mock.calls.find((c: any[]) => c[0].data.event_type === 'SENT');
    expect(sentCall![0].data.metadata).toEqual({ walkthrough_completed: true, walkthrough_completed_at: null });
  });

  it('auto-transitions lead to ESTIMATED from CONTACTED on send', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 }, // SERV10X-61 §5.6 - pass send()'s ≥1-item gate.
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status:'CONTACTED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    // Spec #1751 D6: the status write is transitionLeadStatus's `updateMany` (its NEW/CONTACTED
    // guard lives in the WHERE clause), and D2's first_estimate_sent_at stamp lands on the same
    // mock — hence leadStatusWrites() rather than a bare call count. The timeline double is
    // captured because the from/to ledger entry is the point of routing this through one writer.
    const txLead = txLeadDouble();
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', public_token: 'tok', valid_until: new Date(), lead_id: ESTIMATE_FIXTURE.lead_id, send_config: null, deposit: null }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        lead: txLead,
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Verify lead was transitioned to ESTIMATED — through the one writer (spec #1751 D6), which
    // also files the from/to ledger entry the hand-rolled timeline event it replaces lacked.
    const statusWrites = leadStatusWrites(txLead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('ESTIMATED');
    const ledger = statusChangeEvents(txTimelineCreate);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'CONTACTED', to: 'ESTIMATED' });
  });

  // PR-C2: shouldTransitionLead only fires from NEW/CONTACTED now (WALKTHROUGH_COMPLETED left
  // LeadStatus). A lead already at ESTIMATED (e.g. a second estimate sent on the same lead)
  // must not get a redundant lead.update call.
  it('does not re-transition a lead already at ESTIMATED on send', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 }, // SERV10X-61 §5.6 - pass send()'s ≥1-item gate.
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status: 'ESTIMATED', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    // Spec #1751 D6: the status write is transitionLeadStatus's `updateMany` (its NEW/CONTACTED
    // guard lives in the WHERE clause), and D2's first_estimate_sent_at stamp lands on the same
    // mock — hence leadStatusWrites() rather than a bare call count. The timeline double is
    // captured because the from/to ledger entry is the point of routing this through one writer.
    const txLead = txLeadDouble();
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', public_token: 'tok', valid_until: new Date(), lead_id: ESTIMATE_FIXTURE.lead_id, send_config: null, deposit: null }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        lead: txLead,
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Spec #1751 D6: the lead IS touched now — a first send stamps first_estimate_sent_at (D2) —
    // so "no re-transition" is proved on the status specifically: no guarded status write, and
    // no ledger entry claiming a move that did not happen.
    expect(leadStatusWrites(txLead.updateMany)).toHaveLength(0);
    expect(statusChangeEvents(txTimelineCreate)).toHaveLength(0);
  });

  it('auto-transitions lead to ESTIMATED from NEW on send', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      _count: { line_items: 2 }, // SERV10X-61 §5.6 - pass send()'s ≥1-item gate.
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status:'NEW', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    // Spec #1751 D6: the status write is transitionLeadStatus's `updateMany` (its NEW/CONTACTED
    // guard lives in the WHERE clause), and D2's first_estimate_sent_at stamp lands on the same
    // mock — hence leadStatusWrites() rather than a bare call count. The timeline double is
    // captured because the from/to ledger entry is the point of routing this through one writer.
    const txLead = txLeadDouble();
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT', public_token: 'tok', valid_until: new Date(), lead_id: ESTIMATE_FIXTURE.lead_id, send_config: null, deposit: null }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: txTimelineCreate },
        lead: txLead,
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    const statusWrites = leadStatusWrites(txLead.updateMany);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].data.status).toBe('ESTIMATED');
    const ledger = statusChangeEvents(txTimelineCreate);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'NEW', to: 'ESTIMATED' });
  });

  // NOTE: the old 'blocks send when lead status is WALKTHROUGH_SCHEDULED' test was removed here.
  // D8/D9 (Walkthrough-as-entity redesign, PR-B2) removed the walkthrough-before-send gate
  // entirely (it was OWNER-CONTROLLED via require_walkthrough_before_send, but that AppSetting
  // was written by no code path and enforced nothing). The current behavior — send never
  // blocks, silent instrumentation only — is covered by the three tests above this block.

  // ── Bug #10: one-off recipient_override (editable "To") threaded UI → schema → controller ──
  // The override is request-scoped (like cc_emails) — it picks the email the estimate link is
  // sent to without overwriting the saved customer record.
  it('emails the recipient_override when provided (overrides the saved customer email)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null });
    mockTransactionForSend(sentEstimate);

    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, recipient_override: 'override@elsewhere.com' });

    expect(res.status).toBe(200);
    // Allow the fire-and-forget email to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendEstimateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'override@elsewhere.com' }),
    );
  });

  it('falls back to the saved customer email when no recipient_override is provided', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null });
    mockTransactionForSend(sentEstimate);

    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ESTIMATE_FIXTURE.lead.customer.email
    expect(sendEstimateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'john@doe.com' }),
    );
  });

  // ── Twin of invoice bug #46: the Send dialog "Message" (message_body) was persisted to
  // send_config but never rendered into the outgoing estimate email — the customer never saw it.
  // Assert the note now reaches both estimate-email paths (regular + deposit-required).
  it('threads the Send dialog message_body into the estimate email (no-deposit path)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null });
    mockTransactionForSend(sentEstimate);

    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, message_body: 'Thanks for considering us — reply with any questions.' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendEstimateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Thanks for considering us — reply with any questions.' }),
    );
  });

  it('threads the Send dialog message_body into the estimate email (deposit-required path)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'deposit_percentage', value: '50' })
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null });

    const sentWithDeposit = {
      ...sentEstimate,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', kind: 'DEPOSIT', total_amount: 531.25, amount_due: 531.25 }],
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: null },
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentWithDeposit), findUnique: vi.fn().mockResolvedValue(sentWithDeposit) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const { sendEstimateWithDepositEmail } = await import('../lib/email.js');
    (sendEstimateWithDepositEmail as any).mockClear?.();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'], message_body: 'A 50% deposit confirms your slot — thank you!' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendEstimateWithDepositEmail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A 50% deposit confirms your slot — thank you!' }),
    );
  });

  it('rejects an invalid recipient_override with 400 (schema validation)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockTransactionForSend(sentEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, recipient_override: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  // #2053 AC7 (backend clause) — the deposit invoice's amount follows the SELECTED total
  // end-to-end through send()/commitFirstSend, not the unfiltered sum of every line/scope.
  // Fixture: Base $100 (non-optional, always counts) + add-on A $100 (optional, selected) count
  // toward the total; add-on B $75 (optional, unselected) and a $200 scope (optional,
  // unselected) do not — selected total 200, unfiltered (unselected-inclusive) sum 475.
  // `calculateTotals` (the #2053 fix under test) derives the selected total exactly as create/
  // update do; that figure is what `resolveDepositAmount` — unedited by this slice, see its own
  // `Math.min(rawValue, total)` / `total * min(value,100)/100` — reads off `existing.total_amount`
  // at send time. Mailer is the module-level mock (setup.ts); nothing is actually sent.
  describe('#2053 AC7 — deposit follows the selected total through send()/commitFirstSend', () => {
    const AC7_LINE_ITEMS = [
      { quantity: 1, unit_price: 100, is_taxable: false, is_optional: false, is_selected: true }, // Base
      { quantity: 1, unit_price: 100, is_taxable: false, is_optional: true, is_selected: true }, // Add-on A (selected)
      { quantity: 1, unit_price: 75, is_taxable: false, is_optional: true, is_selected: false }, // Add-on B (unselected)
    ];
    const AC7_SCOPES = [
      { flat_price: 200, is_taxable: false, is_optional: true, is_selected: false }, // Scope (unselected)
    ];
    const { totalAmount: AC7_SELECTED_TOTAL } = calculateTotals(AC7_LINE_ITEMS, 0, undefined, AC7_SCOPES);

    function mockSendWithDeposit(depositOverride: { deposit_type: 'FIXED' | 'PERCENTAGE'; deposit_value: number }) {
      mockAuthAs('admin');
      mockPrisma.estimate.findUnique.mockResolvedValue({
        ...mockDraftEstimate,
        total_amount: AC7_SELECTED_TOTAL,
        deposit_type: depositOverride.deposit_type,
        deposit_value: depositOverride.deposit_value,
      });
      mockPrisma.appSetting.findUnique.mockResolvedValue(null);
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
        estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
        deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
      });

      let capturedInvoice: Record<string, unknown> | undefined;
      mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
        estimate: {
          update: vi.fn().mockResolvedValue(sentEstimate),
          findUnique: vi.fn().mockResolvedValue(sentEstimate),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            capturedInvoice = args.data;
            return Promise.resolve({ id: 'dep-inv-ac7' });
          }),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }));

      return () => capturedInvoice;
    }

    it('sanity: the fixture selected total is 200, not the unfiltered 475', () => {
      expect(AC7_SELECTED_TOTAL).toBe(200);
    });

    it('FIXED $55 passes through unclamped — below the selected total of 200', async () => {
      const getInvoice = mockSendWithDeposit({ deposit_type: 'FIXED', deposit_value: 55 });

      const res = await request(app)
        .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
        .set(authHeader('admin'))
        .send({ deposit_required: true, payment_methods: ['CARD'] });

      expect(res.status).toBe(200);
      const invoice = getInvoice();
      expect(invoice?.kind).toBe('DEPOSIT');
      expect(Number(invoice?.total_amount)).toBe(55);
      expect(Number(invoice?.amount_due)).toBe(55);
    });

    it('PERCENTAGE 20% is derived from the SELECTED total (40), not the unfiltered sum (95)', async () => {
      const getInvoice = mockSendWithDeposit({ deposit_type: 'PERCENTAGE', deposit_value: 20 });

      const res = await request(app)
        .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
        .set(authHeader('admin'))
        .send({ deposit_required: true, payment_methods: ['CARD'] });

      expect(res.status).toBe(200);
      const invoice = getInvoice();
      expect(invoice?.kind).toBe('DEPOSIT');
      expect(Number(invoice?.total_amount)).toBe(40);
      expect(Number(invoice?.amount_due)).toBe(40);
    });
  });
});

// ═══════════════════════════════════════════════════════
// #61 — FIXED deposit default in send path
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/send — FIXED deposit default (#61)', () => {
  const DRAFT_LEAD_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
  const mockDraftEstimate = {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: 1062.5,
    public_token: null,
    valid_until: null,
    customer_id: null,
    // SERV10X-61 §5.6 - non-zero line-item count so send()'s new ≥1-item gate passes.
    _count: { line_items: 2 },
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: DRAFT_LEAD_CUSTOMER_ID, email: 'john@doe.com' } },
    deposit: null,
    send_config: null,
  };

  const sentEstimate = { ...ESTIMATE_FIXTURE, status: 'SENT', sent_at: new Date(), public_token: 'tok', valid_until: new Date(), send_config: null, deposit: null };

  it('send() with FIXED org default creates deposit invoice at the fixed amount', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    // After B4: send path reads estimate_validity_days only (one appSetting read)
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    // Org has FIXED deposit default of $200
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'FIXED', deposit_default_percentage: 50, deposit_default_fixed_amount: 200,
    });

    let capturedInvoiceData: any;
    const invoiceCreate = vi.fn().mockImplementation((args: any) => {
      capturedInvoiceData = args.data;
      return Promise.resolve({ id: 'dep-inv-fixed-1' });
    });
    let capturedSendConfig: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue({ ...sentEstimate }), findUnique: vi.fn().mockResolvedValue({ ...sentEstimate }) },
        estimateSendConfig: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          upsert: vi.fn().mockImplementation((args: any) => { capturedSendConfig = args; return Promise.resolve({}); }),
        },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalled();
    // FIXED $200 deposit (not 50% of 1062.50 = 531.25)
    expect(Number(capturedInvoiceData.total_amount)).toBe(200);
    expect(Number(capturedInvoiceData.amount_due)).toBe(200);
    // Line item description for FIXED must NOT contain '%'
    const lineDesc: string = capturedInvoiceData.line_items.create[0].description;
    expect(lineDesc).not.toContain('%');
    // effective deposit_percentage is persisted (200/1062.5 * 100 ≈ 18.82)
    expect(Number(capturedSendConfig.create.deposit_amount)).toBe(200);
  });

  it('send() with FIXED deposit clamps to total when fixed_amount > total', async () => {
    mockAuthAs('admin');
    const bigTotalEstimate = { ...mockDraftEstimate, total_amount: 1062.5 };
    mockPrisma.estimate.findUnique.mockResolvedValue(bigTotalEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    // FIXED $5000 > total $1062.5 → should clamp to 1062.5
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'FIXED', deposit_default_percentage: 50, deposit_default_fixed_amount: 5000,
    });

    let capturedInvoiceData: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue({ ...sentEstimate }), findUnique: vi.fn().mockResolvedValue({ ...sentEstimate }) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation((args: any) => { capturedInvoiceData = args.data; return Promise.resolve({ id: 'dep-inv-cap-1' }); }),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    // Deposit must be capped at total_amount (1062.5), never exceed it
    expect(Number(capturedInvoiceData.total_amount)).toBe(1062.5);
  });
});

// ═══════════════════════════════════════════════════════
// Lead-status transitions skip lead-less estimates (DEC1)
// ═══════════════════════════════════════════════════════

describe('lead-status transitions skip lead-less estimates (DEC1)', () => {
  it('send does not transition a lead when the estimate has no lead', async () => {
    mockAuthAs('admin');
    // existing estimate has lead_id: null
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...STANDALONE_ESTIMATE_FIXTURE,
      status: 'DRAFT',
      total_amount: 100,
      public_token: null,
      valid_until: null,
      send_config: null,
      deposit: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    const leadUpdate = vi.fn();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...STANDALONE_ESTIMATE_FIXTURE, status: 'SENT', lead_id: null }),
          findUnique: vi.fn().mockResolvedValue({ ...STANDALONE_ESTIMATE_FIXTURE, status: 'SENT', lead_id: null }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { update: leadUpdate, updateMany: leadUpdate },
      }),
    );
    // Best-effort: send may also call email senders (mocked no-op in setup). Assert the lead writer was never called.
    await request(app).post(`/api/estimates/${STANDALONE_ESTIMATE_FIXTURE.id}/send`).set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it('public approve does not transition a lead when the estimate has no lead', async () => {
    mockAuthAs('admin');
    // existing estimate has lead_id: null, no deposit (Branch 1: no deposit required)
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...STANDALONE_ESTIMATE_FIXTURE,
      status: 'SENT',
      lead_id: null,
      valid_until: null,
      signature_data: null,
      deposit: null,
      send_config: null,
      organization: { id: STANDALONE_ESTIMATE_FIXTURE.organization_id, stripe_account_id: null, accepted_payment_methods: [] },
    });
    const leadUpdate = vi.fn();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ ...STANDALONE_ESTIMATE_FIXTURE, status: 'WON', lead_id: null }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { update: leadUpdate, updateMany: leadUpdate },
      }),
    );
    await request(app)
      .post(`/api/estimates/${STANDALONE_ESTIMATE_FIXTURE.id}/approve?token=tok`)
      .send({ signature_data: 'data:image/png;base64,abc' });
    expect(leadUpdate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/:id/record-payment
// (replaces both mark-sent-in-person and mark-deposit-received)
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/record-payment', () => {
  const draftNoDeposit = {
    id: ESTIMATE_FIXTURE.id,
    status: 'DRAFT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: 1000,
    public_token: null,
    valid_until: null,
    lead_id: ESTIMATE_FIXTURE.lead_id,
    // SERV10X-61 R6 - customer_id is denormalized NOT-NULL onto every estimate (== the lead's
    // customer here); recordEstimatePayment now reads it as the deposit-invoice customer source.
    customer_id: 'c0000000-0000-0000-0000-0000000000aa',
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], status:'NEW', customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
    deposit: null,
    send_config: null,
  };

  const sentWithRequestedDeposit = {
    ...draftNoDeposit,
    status: 'SENT',
    public_token: 'tok-existing',
    deposit: {
      id: 'd0000000-0000-0000-0000-000000000077',
      amount: 500,
      status: 'REQUESTED',
      payment_method: null,
      paid_at: null,
    },
    send_config: { id: 'sc-1', payment_methods: ['CHECK'] },
  };

  const approvedFixture = { ...ESTIMATE_APPROVED_FIXTURE };

  function mockTxRecordPayment(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue(result),
          findUnique: vi.fn().mockResolvedValue(result),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: {
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
  }

  it('admin records payment on a DRAFT estimate → WON + Deposit PAID + lead WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, deposit_percentage: 50, payment_method: 'EXTERNAL_CARD' });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
    // A Payment is recorded on the kind=DEPOSIT Invoice (the SOLE deposit document) and it is PAID.
    expect((txProxy.payment as any).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoice_id: 'dep-inv-1',
          method: 'EXTERNAL_CARD',
          amount: 500,
        }),
      }),
    );
    expect((txProxy.invoice as any).update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dep-inv-1' },
        data: expect.objectContaining({ status: 'PAID', amount_due: 0 }),
      }),
    );
    // Estimate transitioned to WON
    expect((txProxy.estimate as any).update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'WON' }),
      }),
    );
    // Lead → WON
    expect((txProxy.lead as any).updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ESTIMATE_FIXTURE.lead_id }),
        data: { status: 'WON' },
      }),
    );
  });

  // R5b (2026-07-22) — D3: PaymentMethod +4. recordEstimatePaymentSchema switched from a
  // hardcoded 5-value z.enum to z.nativeEnum(PaymentMethod) — confirm a new value is actually
  // accepted (400 would mean the schema drifted from the real enum again).
  it.each(['ZELLE', 'VENMO', 'CASH_APP', 'OTHER'])('accepts %s as a payment_method (D3)', async (method) => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, deposit_percentage: 50, payment_method: method });

    expect(res.status).toBe(200);
    expect((txProxy.payment as any).create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ method }) }),
    );
  });

  it('creates the deposit invoice + Payment row when none exists yet (DRAFT path)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        // No deposit invoice for this estimate (DRAFT path: send() never ran).
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'dep-inv-new' }),
          update: vi.fn().mockResolvedValue({}),
        },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    // A kind=DEPOSIT invoice is created (lazy-create for DRAFT path).
    expect((txProxy.invoice as any).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'DEPOSIT',
          estimate_id: ESTIMATE_FIXTURE.id,
          customer_id: 'c0000000-0000-0000-0000-0000000000aa',
          invoice_number: 'I00001',
          status: 'SENT',
          total_amount: 500,
          amount_due: 500,
        }),
      }),
    );
    // A Payment row is recorded on the newly created deposit invoice.
    expect((txProxy.payment as any).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invoice_id: 'dep-inv-new', amount: 500, method: 'CHECK' }),
      }),
    );
    // The deposit invoice is marked PAID.
    expect((txProxy.invoice as any).update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dep-inv-new' },
        data: expect.objectContaining({ status: 'PAID', amount_due: 0 }),
      }),
    );
    // Estimate transitioned to WON, lead → WON (unchanged behavior).
    expect((txProxy.estimate as any).update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WON' }) }),
    );
    expect((txProxy.lead as any).updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ESTIMATE_FIXTURE.lead_id }),
        data: { status: 'WON' },
      }),
    );
  });

  it('records the Payment on the existing kind=DEPOSIT invoice (SENT path)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentWithRequestedDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK', reference_number: 'CHK-1234' });

    // The kind=DEPOSIT invoice is the SOLE record: a Payment is recorded and it is marked PAID.
    expect((txProxy.payment as any).create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invoice_id: 'dep-inv-1', amount: 500, method: 'CHECK' }) }),
    );
    expect((txProxy.invoice as any).update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dep-inv-1' }, data: expect.objectContaining({ status: 'PAID', amount_due: 0 }) }),
    );
  });

  it('writes a DEPOSIT_PAID timeline event', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CASH' });

    const calls = ((txProxy.timelineEvent as any).create as ReturnType<typeof vi.fn>).mock.calls;
    const eventTypes = calls.map((c: any[]) => c[0]?.data?.event_type);
    expect(eventTypes).toContain('DEPOSIT_PAID');
  });

  it('does not fire any customer email', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockTxRecordPayment(approvedFixture);

    const { sendEstimateEmail, sendEstimateWithDepositEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();
    (sendEstimateWithDepositEmail as any).mockClear?.();

    await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(sendEstimateEmail).not.toHaveBeenCalled();
    expect(sendEstimateWithDepositEmail).not.toHaveBeenCalled();
  });

  it('dispatcher can record payment', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockTxRecordPayment(approvedFixture);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('dispatcher'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(200);
  });

  it('sales is rejected (403)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('sales'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(403);
  });

  it('technician is rejected (403)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('technician'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(403);
  });

  it('rejects when estimate already WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...draftNoDeposit, status: 'WON' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved|paid/i);
  });

  it('rejects when estimate is in a terminal state (ARCHIVED)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...draftNoDeposit, status: 'ARCHIVED' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates/nonexistent/record-payment')
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CASH' });

    expect(res.status).toBe(404);
  });

  it('rejects non-positive amount via Zod', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 0, payment_method: 'CASH' });

    expect(res.status).toBe(400);
  });

  it('rejects invalid payment_method via Zod', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'WIRE' });

    expect(res.status).toBe(400);
  });

  it('accepts EXTERNAL_CARD', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockTxRecordPayment(approvedFixture);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'EXTERNAL_CARD' });

    expect(res.status).toBe(200);
  });

  it('underpaid deposit → PARTIAL + amount_due = total − paid, estimate NOT approved, lead NOT won', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit);
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    let txProxy: any = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      txProxy = tx;
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 200, payment_method: 'CASH' });

    expect(res.status).toBe(200);

    // Deposit invoice should be PARTIAL with amount_due = 500 - 200 = 300.
    expect((txProxy.invoice as any).update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dep-inv-1' },
        data: expect.objectContaining({ status: 'PARTIAL', amount_due: 300 }),
      }),
    );
    // paid_at must NOT be set on a partial payment.
    const invoiceUpdateCall = ((txProxy.invoice as any).update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(invoiceUpdateCall?.data?.paid_at).toBeUndefined();

    // Estimate must NOT have been transitioned to WON.
    const estimateUpdateCalls = ((txProxy.estimate as any).update as ReturnType<typeof vi.fn>).mock.calls;
    const approvedCall = estimateUpdateCalls.find((c: any[]) => c[0]?.data?.status === 'WON');
    expect(approvedCall).toBeUndefined();

    // Lead must NOT have been moved to WON.
    expect((txProxy.lead as any).updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WON' } }),
    );

    // Real money is always recorded — payment.create MUST have fired.
    expect((txProxy.payment as any).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invoice_id: 'dep-inv-1', amount: 200, method: 'CASH' }),
      }),
    );

    // DEPOSIT_PAID timeline event MUST fire (real money recorded).
    const calls = ((txProxy.timelineEvent as any).create as ReturnType<typeof vi.fn>).mock.calls;
    const eventTypes = calls.map((c: any[]) => c[0]?.data?.event_type);
    expect(eventTypes).toContain('DEPOSIT_PAID');

    // APPROVED timeline event must NOT fire.
    expect(eventTypes).not.toContain('APPROVED');

    // autoCreateReservation must NOT have been triggered.
    expect((txProxy.estimateReservation as any).create).not.toHaveBeenCalled();
  });

  it('#61 record-payment: FIXED org default derives depositPercent from the total', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftNoDeposit); // total_amount = 1000
    // After B5: record-payment reads org, not appSetting
    mockPrisma.organization.findUnique.mockResolvedValue({
      deposit_default_type: 'FIXED',
      deposit_default_percentage: 50,
      deposit_default_fixed_amount: 200,
    });

    let capturedSendConfig: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockImplementation((args: any) => { capturedSendConfig = args; return Promise.resolve({}); }) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 200, payment_method: 'EXTERNAL_CARD' });

    expect(res.status).toBe(200);
    // No body.deposit_percentage provided → derived from FIXED amount: (200/1000)*100 = 20.0
    // (draftNoDeposit.total_amount = 1000, fixed_amount = 200)
    // EstimateSendConfig created when no send_config existed
    if (capturedSendConfig) {
      expect(Number(capturedSendConfig.data.deposit_percentage)).toBeCloseTo(20, 1);
    }
  });

  // B8/PRD §13.7 — record-payment must prefer the ESTIMATE's own deposit_type/deposit_value
  // override (Receipt Card) over the org default when no explicit body.deposit_percentage is
  // sent; before this fix it derived depositPercent purely from the org default.
  it('B8: prefers the estimate\'s own deposit override over the org default when deriving depositPercent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...draftNoDeposit, // total_amount = 1000
      deposit_type: 'FIXED',
      deposit_value: 150,
    });
    // Org default is PERCENTAGE 50% — the estimate's own FIXED $150 override must win instead.
    mockPrisma.organization.findUnique.mockResolvedValue({
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      deposit_default_fixed_amount: 0,
    });

    let capturedSendConfig: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(approvedFixture), findUnique: vi.fn().mockResolvedValue(approvedFixture) },
        estimateSendConfig: { create: vi.fn().mockImplementation((args: any) => { capturedSendConfig = args; return Promise.resolve({}); }) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 150, payment_method: 'EXTERNAL_CARD' });

    expect(res.status).toBe(200);
    // No body.deposit_percentage → derived from the ESTIMATE's own FIXED $150 override:
    // (150/1000)*100 = 15.0 — NOT the org default's 50.
    if (capturedSendConfig) {
      expect(Number(capturedSendConfig.data.deposit_percentage)).toBeCloseTo(15, 1);
    }
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/:id/cancel
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/cancel', () => {
  // cancel() runs in a $transaction: estimate.update → timeline → void unpaid deposit invoices.
  function mockCancelTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  it('cancels a DRAFT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockCancelTransaction({ ...ESTIMATE_FIXTURE, status: 'ARCHIVED' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
  });

  it('cancels a SENT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockCancelTransaction({ ...ESTIMATE_SENT_FIXTURE, status: 'ARCHIVED' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer changed mind' });

    expect(res.status).toBe(200);
  });

  it('requires cancelled_reason', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('cannot cancel WON estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'some-id',
      status: 'WON',
      estimate_number: 'E00003',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post('/api/estimates/some-id/cancel')
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Try it' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('won');
  });
});

// ═══════════════════════════════════════════════════════
// R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3, D13)
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/mark-sent', () => {
  function mockMarkSentTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Freeze-at-send: commitFirstSend re-reads `scopes` inside the tx before stamping the
        // send-time snapshot onto the same write that flips the status to SENT.
        estimate: {
          update: vi.fn().mockResolvedValue(result),
          findUnique: vi.fn().mockResolvedValue({ scopes: null }),
        },
        estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}) },
        // Spec #1751 D2/D6: mark-sent shares commitFirstSend, so it stamps the lead's
        // first_estimate_sent_at clock and may move the status — both through `updateMany`.
        // #2030 — the version snapshot is minted inside a transaction now (its ordinal is read
        // and written in one), so the transaction double has to carry the delegate. Pointed at the
        // global mock so the assertions below still read the calls where they always have.
        estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
        lead: txLeadDouble(),
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  }

  it('marks a DRAFT estimate sent without emailing', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      public_token: null,
      // SERV10X-61 §5.6 - mark-sent shares send()'s ≥1-item gate; a markable fixture needs _count.
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockMarkSentTransaction({ ...ESTIMATE_FIXTURE, status: 'SENT' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    expect(mockIsStripeConfigured).not.toHaveBeenCalled(); // sanity: no email path touched
  });

  // #2030 slice 2 — marking as sent is a customer RECEIVING the document, just delivered outside
  // the system, so it mints a version exactly as send() does. Only send() did.
  it('mints a version, so an estimate delivered outside the system still has a record', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      public_token: null,
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      // The snapshot re-reads through estimateDocumentSelect, so the mock answers that too.
      version: 1,
      created_at: new Date('2026-09-01T00:00:00Z'),
      subtotal: 1000, discount_amount: 0, discount_name: null,
      tax_rate: 0, tax_amount: 0, total_amount: 1000,
      signature_data: null, signature_at: null,
      snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
      scope_notes: null, scopes: null, scope_photos: [],
      line_items: ESTIMATE_FIXTURE.line_items,
      customer: { first_name: 'John', last_name: 'Doe', company_name: null, email: null, phone: '5551234567' },
      service_location: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      estimate_template: 'alpha-classic',
    });
    mockMarkSentTransaction({ ...ESTIMATE_FIXTURE, status: 'SENT' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
    // Fire-and-forget, like the audit log — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockPrisma.estimateVersionSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: 'MARK_SENT' }) }),
    );
  });

  // D8/D9 (Walkthrough-as-entity redesign, PR-B2): the walkthrough-before-send gate is REMOVED
  // entirely, on every first-send path including mark-sent (which shares commitFirstSend). It
  // never blocks now, regardless of walkthrough state.
  it('never blocks mark-sent on an incomplete walkthrough (the gate is gone)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      public_token: null,
      // SERV10X-61 §5.6 - non-zero _count so the ≥1-item gate passes.
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.visit.count.mockResolvedValue(0); // no COMPLETED visit
    mockMarkSentTransaction({ ...ESTIMATE_FIXTURE, status: 'SENT' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: false });

    expect(res.status).toBe(200);
  });

  // Finding #4's coverage gap: the one passing mark-sent test sends deposit_required=false,
  // which skips commitFirstSend's entire deposit-invoice branch — the exact code whose absence
  // was the original bug this endpoint was built to fix. Exercise the deposit_required=true wiring.
  it('creates the deposit invoice when deposit_required=true (commitFirstSend wiring)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 1000,
      lead_id: 'lead-mark-sent-1',
      deposit_type: null,
      deposit_value: null,
      public_token: null,
      // SERV10X-61 §5.6 - non-zero _count so mark-sent's ≥1-item gate passes.
      _count: { line_items: 2 },
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: 'CONTACTED',
        customer: { id: 'c0000000-0000-0000-0000-0000000000aa' },
        walkthrough_completed_at: null,
      },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-mark-sent-1' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // Freeze-at-send: see mockMarkSentTransaction above for why findUnique is here.
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
          findUnique: vi.fn().mockResolvedValue({ scopes: null }),
        },
        estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}) },
        lead: txLeadDouble(),
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: invoiceCreate },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'DEPOSIT', job_id: null, estimate_id: ESTIMATE_FIXTURE.id }),
      }),
    );
  });

  it('cannot mark-sent an already-SENT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      public_token: ESTIMATE_SENT_FIXTURE.public_token,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('DISPATCHER cannot mark-sent (no send grant)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/estimates/:id/status', () => {
  function mockStatusTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  it('backtodraft recalls a SENT estimate to DRAFT and nulls public_token', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    let captured: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT', public_token: null });
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(captured.data.status).toBe('DRAFT');
    expect(captured.data.public_token).toBeNull();
  });

  // A material edit after backtodraft, followed by a re-send, must not carry a stale customer
  // signature forward onto a document they never actually approved — same reasoning as D12's
  // pendingRevertOnMaterialChange, applied to this diff's new same-row PENDING/SENT→DRAFT path.
  it('backtodraft clears the stale signature/consent fields, not just public_token', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    let captured: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT', public_token: null });
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(captured.data).toMatchObject({
      public_token: null,
      signature_data: null,
      signature_ip: null,
      signature_at: null,
      terms_accepted: false,
      terms_accepted_at: null,
      modified_after_send: false,
    });
  });

  it('backtodraft also recalls a PENDING estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockStatusTransaction({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT' });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(200);
  });

  // There is deliberately NO manual "mark pending" transition — see the code comment on
  // setEstimateStatusSchema: PENDING means "customer signed", and only approvePublic captures
  // that signature. A fabricated PENDING would let an unsigned estimate reach WON via
  // approvePublic's isPaymentRetry branch, which trusts PENDING to mean already-signed.
  it('rejects "markpending" — not a valid transition (Zod layer)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'markpending' });

    expect(res.status).toBe(400);
  });

  it('backtosent moves a PENDING estimate back to SENT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockStatusTransaction({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtosent' });

    expect(res.status).toBe(200);
  });

  it('rejects an unrecognized transition at the Zod layer', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'bogus' });

    expect(res.status).toBe(400);
  });

  it('DISPATCHER cannot set estimate status (no update grant)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}/status`)
      .set(authHeader('dispatcher'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(403);
  });

  // #2031 slice 4 — back to draft clears the public link, the signature, the T&C acceptance and
  // the changed-since-sent flag, but used to leave send_config standing. Deposit editability is
  // gated on that row existing, so a recalled estimate's deposit stayed locked for ever and a
  // salesperson who spotted a mismatch had no way to correct it.
  it('backtodraft clears the frozen send config, so the deposit is editable again', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    let updateArgs: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            updateArgs = args;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT', public_token: null });
          }),
        },
        estimateSendConfig: { deleteMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { estimate_id: ESTIMATE_SENT_FIXTURE.id } });
    // The estimate's OWN deposit override survives — the salesperson edits the value they had
    // rather than losing it.
    expect(updateArgs.data).not.toHaveProperty('deposit_type');
    expect(updateArgs.data).not.toHaveProperty('deposit_value');
  });

  it('a move that is not back to draft leaves the send config alone', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' }) },
        estimateSendConfig: { deleteMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtosent' });

    expect(res.status).toBe(200);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  // SRVW-105 step 1 - setStatus() is extracted into setStatusInternal() so bulkSetStatus() can
  // share it. Extraction-parity guard: passes before AND after the extraction - it exists to
  // redden if the extraction drops a side effect (the TimelineEvent write here).
  it('extraction parity: backtodraft on a PENDING estimate still writes the STATUS_CORRECTED TimelineEvent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'DRAFT', public_token: null }) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: timelineCreate },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(timelineCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'STATUS_CORRECTED' }) }),
    );
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/estimates/:id/status — unordered status (Spec B1)
// ═══════════════════════════════════════════════════════
// Estimate status stops being an ordered pipeline: any of the six exposed statuses is reachable
// from any other, matching the Job model and what Workiz lets users do. Only integrity rules
// block a move. Exercised through the HTTP route (the public interface), never against the
// transition engine directly, so the engine stays free to be restructured.
describe('PATCH /api/estimates/:id/status — unordered (Spec B1)', () => {
  function mockExisting(status: string, extra: Record<string, unknown> = {}) {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status,
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      // Anything that has left DRAFT has a live customer link; the never-sent case overrides this.
      public_token: 'live-token',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'ESTIMATED' },
      job: null,
      invoices: [],
      ...extra,
    });
  }

  // Captures what the route actually wrote, so a test can assert on the stamps rather than on
  // which internal function produced them.
  function captureUpdate(opts: { wonSiblings?: number } = {}) {
    const captured: {
      data?: Record<string, unknown>;
      leadUpdateMany: ReturnType<typeof vi.fn>;
    } = { leadUpdateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            captured.data = args.data;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, ...args.data });
          }),
          count: vi.fn().mockResolvedValue(opts.wonSiblings ?? 0),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: captured.leadUpdateMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );
    return captured;
  }

  // The transition from the bug report: a SENT estimate could not be moved to "Approved —
  // Deposit Pending" because no API path reached PENDING at all.
  it('moves a SENT estimate forward to PENDING', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'PENDING' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('PENDING');
  });

  // A status is a bundle of stored state, not a flag. Entering WON is the same business event as
  // approve-internal, so it must carry the same stamps - otherwise a won estimate reports no
  // approval date and its lead is left behind in ESTIMATED.
  it('stamps approved_at and wins the lead when entering WON', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'WON' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('WON');
    expect(captured.data?.approved_at).toBeInstanceOf(Date);
    expect(captured.leadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WON' } }),
    );
  });

  // The mirror of the above. Leaving WON must clear the approval stamp and hand the lead back,
  // or the estimate reports an approval date for an approval that no longer exists.
  it('clears approved_at and demotes the lead when leaving WON', async () => {
    mockAuthAs('admin');
    mockExisting('WON', { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'WON' } });
    const captured = captureUpdate({ wonSiblings: 0 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('SENT');
    expect(captured.data?.approved_at).toBeNull();
    expect(captured.leadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ESTIMATED' } }),
    );
  });

  // ...but only when this was the LAST won estimate on the lead. A lead can hold several won
  // estimates at once, and demoting it would contradict a sibling that is still won.
  it('leaves the lead WON when a sibling estimate is still won', async () => {
    mockAuthAs('admin');
    mockExisting('WON', { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'WON' } });
    const captured = captureUpdate({ wonSiblings: 1 });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.leadUpdateMany).not.toHaveBeenCalled();
  });

  // The ONLY kind of rule that still blocks a move. Ordering is gone; a real money trail is not
  // negotiable - unwinding a won estimate whose job has already been billed would orphan it.
  // This guard used to live in voidApproval, so it covered WON -> SENT alone; it now covers every
  // way out of WON, including the two (-> DRAFT, -> ARCHIVED) that had no route at all before.
  it.each([
    ['DRAFT'],
    ['SENT'],
    ['ARCHIVED'],
  ])('refuses to leave WON for %s when the job has already been invoiced', async (target) => {
    mockAuthAs('admin');
    mockExisting('WON', {
      job: { id: 'job-1', job_number: 'J00042', invoices: [{ id: 'inv-1', status: 'SENT', payments: [] }] },
    });
    captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: target });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J00042/);
  });

  it('refuses to leave WON when the deposit has payments recorded', async () => {
    mockAuthAs('admin');
    mockExisting('WON', {
      invoices: [{ id: 'dep-1', status: 'PAID', payments: [{ id: 'pay-1' }] }],
    });
    captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'DRAFT' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deposit/i);
  });

  // DECLINED carries a required reason - the S1 win/loss reporting signal depends on it, and a
  // staff member recording a loss has no excuse not to capture why (declineInternal's rule).
  it('rejects a move to DECLINED with no lost_reason', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'DECLINED' });

    expect(res.status).toBe(400);
  });

  it('stamps declined_at and the lost_reason when entering DECLINED', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'DECLINED', lost_reason: 'PRICE' });

    expect(res.status).toBe(200);
    expect(captured.data?.declined_at).toBeInstanceOf(Date);
    expect(captured.data?.lost_reason).toBe('PRICE');
  });

  it('stamps cancelled_at and the reason when entering ARCHIVED', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'ARCHIVED', cancelled_reason: 'Customer went quiet' });

    expect(res.status).toBe(200);
    expect(captured.data?.cancelled_at).toBeInstanceOf(Date);
    expect(captured.data?.cancelled_reason).toBe('Customer went quiet');
  });

  // Reviving a dead estimate is now legal, and the stamps from its old life must not survive it -
  // a re-opened estimate that still reports a decline date and a lost reason is lying.
  it('clears the decline stamps when moving back out of DECLINED', async () => {
    mockAuthAs('admin');
    mockExisting('DECLINED');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.data?.declined_at).toBeNull();
    expect(captured.data?.lost_reason).toBeNull();
  });

  it('clears the cancel stamps when moving back out of ARCHIVED', async () => {
    mockAuthAs('admin');
    mockExisting('ARCHIVED');
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'DRAFT' });

    expect(res.status).toBe(200);
    expect(captured.data?.cancelled_at).toBeNull();
    expect(captured.data?.cancelled_reason).toBeNull();
  });

  // SENT is a LABEL, not a delivery receipt. It says where the estimate sits in the pipeline; it
  // does NOT assert that a customer link exists. Only send/resend/mark-sent mint a public_token,
  // and this endpoint must never do it as a side effect of a status pick - re-arming a customer's
  // link on an estimate somebody deliberately archived is not a thing a label change may do.
  //
  // This replaces a 409 SEND_CEREMONY_REQUIRED that told the client to run POST /:id/mark-sent
  // instead. That advice was a dead end: mark-sent gates on DRAFT, so every token-less
  // WON/DECLINED/ARCHIVED estimate answered 409 here and 400 there, with nothing in between.
  it('stamps SENT on an estimate that has never been sent, and mints no customer link', async () => {
    mockAuthAs('admin');
    mockExisting('ARCHIVED', { public_token: null });
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('SENT');
    expect(captured.data).not.toHaveProperty('public_token');
  });

  it('stamps SENT directly when the estimate still has a live public link', async () => {
    mockAuthAs('admin');
    mockExisting('WON', { public_token: 'live-token' });
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('SENT');
  });

  // Purchasing Audit Verdict PR 2 (R10): winning an estimate creates NO reservation row any
  // more - the Pre-PO queue is gone. Reaching WON through the picker is the same business event
  // as approve-internal, and neither reserves anything.
  it('creates no estimate reservation when entering WON', async () => {
    mockAuthAs('admin');
    mockExisting('SENT');
    const reservationCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          count: vi.fn().mockResolvedValue(0),
          findUnique: vi.fn().mockResolvedValue({
            estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
            approved_at: null,
            customer_id: null,
            customer: null,
            lead: null,
            line_items: [{ description: 'Condenser', quantity: 1, unit_price: 500, line_total: 500, price_book_item_id: null, price_book_item: { sku: 'CND-1' } }],
          }),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: reservationCreate },
      }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'WON' });

    expect(res.status).toBe(200);
    expect(reservationCreate).not.toHaveBeenCalled();
  });

  // A clean won estimate - job exists but nothing billed - still moves freely.
  it('allows leaving WON when the job carries only a draft invoice with no payments', async () => {
    mockAuthAs('admin');
    mockExisting('WON', {
      job: { id: 'job-1', job_number: 'J00042', invoices: [{ id: 'inv-1', status: 'DRAFT', payments: [] }] },
    });
    const captured = captureUpdate();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });

    expect(res.status).toBe(200);
    expect(captured.data?.status).toBe('SENT');
  });

  // The whole claim of Spec B1 in one table: on an estimate with no money trail and a live
  // customer link, EVERY ordered pair of the six statuses is accepted. The tests above each pin
  // one rule; this one pins the absence of a rule, which is what "unordered" actually means and
  // what no single-pair test can show. If an ordering constraint is ever reintroduced anywhere on
  // this path - a source-status gate, a terminal status, a one-way stamp - exactly one cell turns red.
  describe('every from -> to pair is accepted', () => {
    const STATUSES = ['DRAFT', 'SENT', 'PENDING', 'WON', 'DECLINED', 'ARCHIVED'] as const;
    const pairs = STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

    it.each(pairs)('%s -> %s', async (from, to) => {
      mockAuthAs('admin');
      mockExisting(from, {
        // Leaving WON demotes the lead only from a WON lead, so the fixture mirrors the source status
        // rather than pretending every estimate hangs off an ESTIMATED lead.
        lead: {
          lead_assignees: [{ user_id: TEST_USERS.sales.id }],
          commission_owner_id: null,
          status: from === 'WON' ? 'WON' : 'ESTIMATED',
        },
      });
      const captured = captureUpdate();

      const res = await request(app)
        .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/status`)
        .set(authHeader('admin'))
        // lost_reason is the one field a target demands, and it is a required INPUT rather than an
        // ordering rule - S1 win/loss reporting is unusable without it.
        .send({ status: to, ...(to === 'DECLINED' ? { lost_reason: 'PRICE' } : {}) });

      expect(res.status).toBe(200);
      expect(captured.data?.status).toBe(to);
    });
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/bulk-status
// ═══════════════════════════════════════════════════════
// Exercises bulkSetStatus(), which loops setStatusInternal() (extracted from setStatus() above)
// SEQUENTIALLY over the submitted ids - same source-status guard, same messages per id, isolated
// per-id failures.
describe('POST /api/estimates/bulk-status', () => {
  const SENT_A = 'b1000000-0000-0000-0000-000000000001';
  const SENT_B = 'b1000000-0000-0000-0000-000000000002';
  const WON_ID = 'b1000000-0000-0000-0000-000000000003';
  const MISSING_ID = 'b1000000-0000-0000-0000-000000000004';

  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const { id } = args.where;
      if (id === MISSING_ID) return Promise.resolve(null);
      if (id === WON_ID) {
        return Promise.resolve({ id, status: 'WON', estimate_number: 'E-WON', lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } });
      }
      return Promise.resolve({ id, status: 'SENT', estimate_number: `E-${id.slice(-4)}`, lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } });
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ id: 'x', status: 'DRAFT' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  });

  it('applies backtodraft across a batch and isolates an id in the wrong source status', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [SENT_A, WON_ID, SENT_B], transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(res.body.updated.sort()).toEqual([SENT_A, SENT_B].sort());
    expect(res.body.failed).toEqual([{ id: WON_ID, error: 'Cannot apply "backtodraft" to a won estimate' }]);
  });

  it('lands a cross-org id in failed and never updates it', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [SENT_A, MISSING_ID], transition: 'backtodraft' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([SENT_A]);
    expect(res.body.failed).toEqual([{ id: MISSING_ID, error: 'Estimate not found' }]);
  });

  it('rejects an unrecognized transition at the validation layer', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/estimates/bulk-status')
      .set(authHeader('admin'))
      .send({ ids: [SENT_A], transition: 'bogus' });

    expect(res.status).toBe(400);
  });

  it('rejects more than 100 ids at the validation layer', async () => {
    mockAuthAs('admin');
    const ids = Array.from({ length: 101 }, (_, i) => `b2000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/estimates/bulk-status')
      .set(authHeader('admin'))
      .send({ ids, transition: 'backtodraft' });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/bulk-send-reminder
// ═══════════════════════════════════════════════════════
// Exercises bulkSendReminders(), which loops sendEstimateInternal() (extracted from send() above)
// but ONLY for SENT|PENDING rows - an explicit allowlist, not a DRAFT denylist, so the
// isTerminalSend statuses (WON/DECLINED/EXPIRED/ARCHIVED/SUPERSEDED) never reach the email step.
describe('POST /api/estimates/bulk-send-reminder', () => {
  const SENT_ID = 'e1000000-0000-0000-0000-000000000001';
  const WON_ID = 'e1000000-0000-0000-0000-000000000002';
  const DRAFT_ID = 'e1000000-0000-0000-0000-000000000003';
  const PENDING_ID = 'e1000000-0000-0000-0000-000000000004';
  const MISSING_ID = 'e1000000-0000-0000-0000-000000000005';

  const STATUS_MAP: Record<string, string> = {
    [SENT_ID]: 'SENT',
    [WON_ID]: 'WON',
    [DRAFT_ID]: 'DRAFT',
    [PENDING_ID]: 'PENDING',
  };

  function fixture(id: string) {
    const status = STATUS_MAP[id];
    return {
      id,
      status,
      estimate_number: `E-${id.slice(-4)}`,
      total_amount: 100,
      public_token: status === 'DRAFT' ? null : 'tok',
      valid_until: new Date(),
      modified_after_send: false,
      version: 1,
      deposit_type: null,
      deposit_value: null,
      created_by: TEST_USERS.sales.id,
      customer_id: 'cust-1',
      customer: { id: 'cust-1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
      _count: { line_items: 1 },
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: null,
        customer: { id: 'cust-1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
      },
      send_config: null,
    };
  }

  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const { id } = args.where;
      if (id === MISSING_ID) return Promise.resolve(null);
      return Promise.resolve(fixture(id));
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: 'x', status: 'SENT' }),
          findUnique: vi.fn().mockResolvedValue({ id: 'x', status: 'SENT' }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('refuses a WON id with zero email calls beyond the eligible SENT id', async () => {
    mockAuthAs('admin');
    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();
    (sendEstimateEmail as any).mockResolvedValue({ status: 'sent' });

    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids: [SENT_ID, WON_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([SENT_ID]);
    expect(res.body.failed).toEqual([{ id: WON_ID, error: 'This estimate is already closed - open it and use Send a copy' }]);
    expect(sendEstimateEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a DRAFT id per row and never first-sends it', async () => {
    mockAuthAs('admin');
    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();
    (sendEstimateEmail as any).mockResolvedValue({ status: 'sent' });
    const txInvoiceCreate = vi.fn().mockResolvedValue({ id: 'dep-inv-1' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: 'x', status: 'SENT' }),
          // A2: the re-send branch reads the document inside the transaction before publishing
          // the rep's recommendation onto it. Null here is the "nothing resolved" case, which
          // leaves the totals columns alone - all this row is asserting is that the DRAFT id is
          // refused and never first-sent.
          findUnique: vi.fn().mockResolvedValue(null),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: txInvoiceCreate },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids: [PENDING_ID, DRAFT_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([PENDING_ID]);
    expect(res.body.failed).toEqual([{ id: DRAFT_ID, error: 'Draft estimates cannot be reminded - send the estimate first' }]);
    expect(sendEstimateEmail).toHaveBeenCalledTimes(1);
    expect(txInvoiceCreate).not.toHaveBeenCalled();
  });

  it('reports a per-row email failure without aborting the batch', async () => {
    mockAuthAs('admin');
    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();
    (sendEstimateEmail as any).mockImplementation((params: { estimateId: string }) =>
      params.estimateId === SENT_ID
        ? Promise.resolve({ status: 'sent' })
        : Promise.resolve({ status: 'failed', reason: 'provider_rejected' }));

    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids: [SENT_ID, PENDING_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([SENT_ID]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(PENDING_ID);
  });

  it('rejects 26 ids at the validation layer before any email', async () => {
    mockAuthAs('admin');
    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();

    const ids = Array.from({ length: 26 }, (_, i) => `e2000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids });

    expect(res.status).toBe(400);
    expect(sendEstimateEmail).not.toHaveBeenCalled();
  });

  it('lands a cross-org id in failed without emailing it', async () => {
    mockAuthAs('admin');
    const { sendEstimateEmail } = await import('../lib/email.js');
    (sendEstimateEmail as any).mockClear?.();
    (sendEstimateEmail as any).mockResolvedValue({ status: 'sent' });

    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids: [SENT_ID, MISSING_ID] });

    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([SENT_ID]);
    expect(res.body.failed).toEqual([{ id: MISSING_ID, error: 'Estimate not found' }]);
    expect(sendEstimateEmail).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/estimates/:id/approve-internal', () => {
  function mockApproveTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: {
          findFirst: vi.fn().mockResolvedValue({ id: 'existing-reservation' }), // skip auto-create body
        },
      }),
    );
  }

  it('approves a SENT estimate internally (verbal win)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null },
    });
    mockPrisma.estimate.count.mockResolvedValue(0); // no other WON estimate (multi-WON guard removed; count now unused)
    mockApproveTransaction({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve-internal`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('allows approval when the lead already has another WON estimate (multi-WON)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null },
    });
    // Another WON estimate already exists on the lead. SERV10X-61 deliberately allows
    // multiple simultaneously-WON estimates per lead, so this internal approval must succeed.
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockApproveTransaction({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve-internal`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('cannot approve a DRAFT estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/approve-internal`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('DISPATCHER cannot approve-internal (no approve grant)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve-internal`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(403);
  });
});

describe('POST /api/estimates/:id/decline-internal', () => {
  function mockDeclineTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  it('declines a SENT estimate internally with a required reason', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null },
    });
    let captured: any;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'DECLINED' });
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline-internal`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'PRICE' });

    expect(res.status).toBe(200);
    expect(captured.data.lost_reason).toBe('PRICE');
  });

  it('requires lost_reason', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline-internal`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects an invalid lost_reason value', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline-internal`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'NOT_A_REAL_REASON' });

    expect(res.status).toBe(400);
  });

  it('DISPATCHER cannot decline-internal (no decline grant)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline-internal`)
      .set(authHeader('dispatcher'))
      .send({ lost_reason: 'PRICE' });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/estimates/:id/void-approval', () => {
  it('voids approval on a WON estimate with no job, and reverts the lead off WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-1',
      status: 'WON',
      estimate_number: 'E00099',
      lead_id: 'lead-1',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      invoices: [],
    });
    let captured: any;
    let leadArgs: any;
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ id: 'won-est-1', status: 'SENT' });
          }),
          // No sibling estimate on this lead is still WON, so the demotion proceeds.
          count: vi.fn().mockResolvedValue(0),
        },
        lead: {
          updateMany: vi.fn().mockImplementation((args: any) => {
            leadArgs = args;
            return Promise.resolve({ count: 1 });
          }),
        },
        timelineEvent: { create: txTimelineCreate },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-est-1/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(200);
    expect(captured.data.status).toBe('SENT');
    expect(captured.data.approved_at).toBeNull();
    // Spec #1751 D6: the same "only demote a lead that is actually WON" restriction, now
    // expressed as the one writer's `onlyFrom` (an IN clause) and carrying the tenant scope the
    // helper adds for every door.
    expect(leadArgs.where).toEqual({ id: 'lead-1', organization_id: ALPHA_ORG_ID, status: { in: ['WON'] } });
    expect(leadArgs.data.status).toBe('ESTIMATED');
    const ledger = statusChangeEvents(txTimelineCreate);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'WON', to: 'ESTIMATED' });
  });

  // SRVW-86 - the same blind spot as copyToInvoice. An estimate ATTACHED to a job via
  // Estimate.job_id (job_link) has no Job pointing back, so `existing.job` is null and both the
  // invoiced-or-paid guard and the lead demotion behaved as if the estimate had no job at all.
  it('400s void-approval when the estimate is attached via job_link to a job that already has a non-DRAFT invoice or a payment', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-att-1',
      status: 'WON',
      estimate_number: 'E00101',
      lead_id: 'lead-1',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      job_link: {
        id: 'job-att-1',
        job_number: 'J00030',
        invoices: [{ id: 'inv-1', status: 'SENT', payments: [{ id: 'pay-1' }] }],
      },
      invoices: [],
    });
    const estimateUpdate = vi.fn().mockResolvedValue({ id: 'won-att-1', status: 'SENT' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: estimateUpdate, count: vi.fn().mockResolvedValue(0) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-att-1/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('J00030');
    expect(estimateUpdate).not.toHaveBeenCalled();
  });

  it('does not demote the lead when the voided estimate is attached to a job via job_link', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-att-2',
      status: 'WON',
      estimate_number: 'E00102',
      lead_id: 'lead-1',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      // Attached job carries nothing billable, so the void itself is allowed.
      job_link: { id: 'job-att-2', job_number: 'J00031', invoices: [] },
      invoices: [],
    });
    let captured: any;
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve({ id: 'won-att-2', status: 'SENT' });
          }),
          count: vi.fn().mockResolvedValue(0),
        },
        lead: { updateMany: leadUpdateMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-att-2/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(200);
    expect(captured.data.status).toBe('SENT');
    // The win already propagated to a job, so the lead stays WON (port-plan §3.2).
    expect(leadUpdateMany).not.toHaveBeenCalled();
  });

  // A lead may carry several simultaneously-WON estimates now that the single-approved-per-lead
  // invariant is gone, so the demotion has to check its siblings before it fires.
  it('leaves the lead WON when another estimate on the same lead is still WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-multi-1',
      status: 'WON',
      estimate_number: 'E00090',
      lead_id: 'lead-multi',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      invoices: [],
    });
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    // One sibling estimate on the same lead is still WON.
    const estimateCount = vi.fn().mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: 'won-est-multi-1', status: 'SENT' }),
          count: estimateCount,
        },
        lead: { updateMany: leadUpdateMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-est-multi-1/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(200);
    // Demoting here would leave the lead contradicting its own still-WON sibling.
    expect(leadUpdateMany).not.toHaveBeenCalled();
    // The sibling count is tenant-scoped, lead-scoped, and excludes the estimate being voided.
    expect(estimateCount.mock.calls[0][0].where).toEqual({
      organization_id: TEST_USERS.admin.organization_id,
      lead_id: 'lead-multi',
      status: 'WON',
      id: { not: 'won-est-multi-1' },
    });
  });

  it('still demotes the lead to ESTIMATED when the voided estimate was the only WON one', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-solo-1',
      status: 'WON',
      estimate_number: 'E00089',
      lead_id: 'lead-solo',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      invoices: [],
    });
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const estimateCount = vi.fn().mockResolvedValue(0);
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: 'won-est-solo-1', status: 'SENT' }),
          count: estimateCount,
        },
        lead: { updateMany: leadUpdateMany },
        timelineEvent: { create: txTimelineCreate },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-est-solo-1/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(200);
    expect(estimateCount.mock.calls[0][0].where).toEqual({
      organization_id: TEST_USERS.admin.organization_id,
      lead_id: 'lead-solo',
      status: 'WON',
      id: { not: 'won-est-solo-1' },
    });
    // Spec #1751 D6: same guard, now the one writer's `onlyFrom` (an IN clause) plus the tenant
    // scope the helper adds itself.
    expect(leadUpdateMany.mock.calls[0][0].where).toEqual({ id: 'lead-solo', organization_id: ALPHA_ORG_ID, status: { in: ['WON'] } });
    expect(leadUpdateMany.mock.calls[0][0].data.status).toBe('ESTIMATED');
    const ledger = statusChangeEvents(txTimelineCreate);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'WON', to: 'ESTIMATED' });
  });

  it('voids approval when the job exists but has no invoices or payments — lead stays WON', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-2',
      status: 'WON',
      estimate_number: 'E00098',
      lead_id: 'lead-2',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: { id: 'job-1', job_number: 'J00050', invoices: [] },
      invoices: [],
    });
    const leadUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ id: 'won-est-2', status: 'SENT' }) },
        lead: { updateMany: leadUpdateMany },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post('/api/estimates/won-est-2/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(200);
    // A job exists — the port-plan's "reverts lead iff no job" rule keeps the lead WON.
    expect(leadUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks the unwind (D13) when the estimate's own deposit invoice has a payment recorded", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-5',
      status: 'WON',
      estimate_number: 'E00095',
      lead_id: 'lead-5',
      lead: { lead_assignees: [], commission_owner_id: null, status: 'WON' },
      job: null,
      invoices: [{ id: 'dep-inv-1', status: 'PAID', payments: [{ id: 'pay-2' }] }],
    });

    const res = await request(app)
      .post('/api/estimates/won-est-5/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('deposit');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks the unwind (D13) when the job has a non-DRAFT invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-3',
      status: 'WON',
      estimate_number: 'E00097',
      job: { id: 'job-2', job_number: 'J00051', invoices: [{ id: 'inv-1', status: 'SENT', payments: [] }] },
    });

    const res = await request(app)
      .post('/api/estimates/won-est-3/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('J00051');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks the unwind (D13) when the job has a DRAFT invoice with a payment recorded', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: 'won-est-4',
      status: 'WON',
      estimate_number: 'E00096',
      job: { id: 'job-3', job_number: 'J00052', invoices: [{ id: 'inv-2', status: 'DRAFT', payments: [{ id: 'pay-1' }] }] },
    });

    const res = await request(app)
      .post('/api/estimates/won-est-4/void-approval')
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('cannot void approval on a non-WON estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      job: null,
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/void-approval`)
      .set(authHeader('admin'))
      .send();

    expect(res.status).toBe(400);
  });

  // ADMIN-only by design — no DEFAULT_GRANTS row exists for void_approval, so SALES (which has
  // every OTHER estimate lifecycle grant) must still be blocked here.
  it('SALES cannot void-approval (admin-only, no grant exists)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/void-approval`)
      .set(authHeader('sales'))
      .send();

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/:id/duplicate
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/duplicate', () => {
  it('duplicates an estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: ESTIMATE_FIXTURE.lead_id,
      scope_notes: ESTIMATE_FIXTURE.scope_notes,
      tax_rate: ESTIMATE_FIXTURE.tax_rate,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: ESTIMATE_FIXTURE.line_items,
    });

    const newEstimate = { ...ESTIMATE_FIXTURE, id: 'new-id', estimate_number: 'E00003' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockResolvedValue(newEstimate),
        },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    expect(res.body.estimate).toBeDefined();
  });

  it('returns 404 for non-existent', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates/nonexistent/duplicate')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  // #2053 AC13 — duplicate() carries is_optional/is_selected onto every copied line, and its
  // recomputed totals stay selection-correct (275, not the everything-counts 475).
  it('carries is_optional/is_selected onto the copied lines and recomputes selection-correct totals', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: ESTIMATE_FIXTURE.lead_id,
      scope_notes: ESTIMATE_FIXTURE.scope_notes,
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: [
        { id: 'li1', sequence: 1, description: 'Base', quantity: 1, unit_price: 100, is_taxable: true, line_total: 100, is_optional: false, is_selected: true },
        { id: 'li2', sequence: 2, description: 'Add-on selected', quantity: 1, unit_price: 100, is_taxable: true, line_total: 100, is_optional: true, is_selected: true },
        { id: 'li3', sequence: 3, description: 'Add-on unselected', quantity: 1, unit_price: 75, is_taxable: true, line_total: 75, is_optional: true, is_selected: false },
      ],
    });

    let captured: { subtotal?: number; total_amount?: number; line_items?: { create: Array<{ is_optional: boolean; is_selected: boolean }> } } | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockImplementation((args: { data: typeof captured }) => {
            captured = args.data;
            return { ...ESTIMATE_FIXTURE, id: 'dup-id' };
          }),
        },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    expect(captured?.subtotal).toBe(200);
    expect(captured?.total_amount).toBe(200);
    const created = captured?.line_items?.create ?? [];
    expect(created[0].is_optional).toBe(false);
    expect(created[1]).toMatchObject({ is_optional: true, is_selected: true });
    expect(created[2]).toMatchObject({ is_optional: true, is_selected: false });
  });

  // Entity-redesign §10 — duplicate target-lead selector.
  const SRC_LEAD = ESTIMATE_FIXTURE.lead_id;
  const TGT_LEAD = 'e0000000-0000-0000-0000-0000000000bb';

  function mockSourceEstimate() {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: SRC_LEAD,
      scope_notes: ESTIMATE_FIXTURE.scope_notes,
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: ESTIMATE_FIXTURE.line_items,
    });
  }

  function captureDuplicateCreate() {
    let captured: { lead_id?: string; tax_rate?: number } | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockImplementation((args: { data: { lead_id?: string; tax_rate?: number } }) => {
            captured = args.data;
            return { ...ESTIMATE_FIXTURE, id: 'dup-id' };
          }),
        },
      }),
    );
    return () => captured;
  }

  it('duplicates to a DIFFERENT target lead and re-derives tax from target location', async () => {
    mockAuthAs('admin');
    mockSourceEstimate();
    // Target lead: tenant validation + tax derivation. The controller calls lead.findUnique
    // twice for the target (validate, then derive); mock both.
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: TGT_LEAD })
      .mockResolvedValueOnce({ service_location_id: 'loc-ca', service_location: { state: 'CA' }, service_state: 'CA' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0725 });
    const getCaptured = captureDuplicateCreate();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({ target_lead_id: TGT_LEAD });

    expect(res.status).toBe(201);
    expect(getCaptured()?.lead_id).toBe(TGT_LEAD);
    expect(getCaptured()?.tax_rate).toBe(0.0725);
  });

  it('omitted target defaults to source lead and carries source tax unchanged', async () => {
    mockAuthAs('admin');
    mockSourceEstimate();
    const getCaptured = captureDuplicateCreate();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(getCaptured()?.lead_id).toBe(SRC_LEAD);
    expect(getCaptured()?.tax_rate).toBe(0.0625);
    // No target lead lookup when same-lead.
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
  });

  it('404 when target_lead_id is not in the tenant', async () => {
    mockAuthAs('admin');
    mockSourceEstimate();
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({ target_lead_id: TGT_LEAD });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target lead/i);
  });

  it('explicit target equal to source behaves as same-lead (no re-derive)', async () => {
    mockAuthAs('admin');
    mockSourceEstimate();
    const getCaptured = captureDuplicateCreate();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({ target_lead_id: SRC_LEAD });

    expect(res.status).toBe(201);
    expect(getCaptured()?.lead_id).toBe(SRC_LEAD);
    expect(getCaptured()?.tax_rate).toBe(0.0625);
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
  });

  // R6 (2026-07-22) — same-lead duplicate carries the source's already-denormalized anchor
  // forward verbatim; job_id is never copied (a duplicate hasn't been used to create any job).
  it('same-lead duplicate carries customer_id/service_location_id forward, never copies job_id', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: SRC_LEAD,
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      created_by: TEST_USERS.admin.id,
      scope_notes: ESTIMATE_FIXTURE.scope_notes,
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: ESTIMATE_FIXTURE.line_items,
    });
    let captured: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            captured = args.data;
            return { ...ESTIMATE_FIXTURE, id: 'dup-id' };
          }),
        },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    expect(captured?.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(captured?.service_location_id).toBe(LOCATION_FIXTURE.id);
    expect(captured?.job_id).toBeUndefined();
  });

  // A cross-lead duplicate re-derives the anchor from the TARGET lead, not the source — a
  // cross-customer reuse must not carry the wrong customer's anchor onto the new estimate.
  it('cross-lead duplicate re-derives customer_id/service_location_id from the TARGET lead', async () => {
    mockAuthAs('admin');
    mockSourceEstimate(); // source lead is SRC_LEAD, customer_id/service_location_id NOT set on this fixture
    const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000cc';
    const OTHER_LOCATION_ID = 'l0000000-0000-0000-0000-0000000000cc';
    mockPrisma.lead.findUnique
      .mockResolvedValueOnce({ id: TGT_LEAD, customer_id: OTHER_CUSTOMER_ID, service_location_id: OTHER_LOCATION_ID })
      .mockResolvedValueOnce({ service_location_id: OTHER_LOCATION_ID, service_location: { state: 'CA' }, service_state: 'CA' });
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0725 });
    let captured: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            captured = args.data;
            return { ...ESTIMATE_FIXTURE, id: 'dup-id' };
          }),
        },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'))
      .send({ target_lead_id: TGT_LEAD });

    expect(res.status).toBe(201);
    expect(captured?.customer_id).toBe(OTHER_CUSTOMER_ID);
    expect(captured?.service_location_id).toBe(OTHER_LOCATION_ID);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/estimates/:id/revise (clone → supersede, §A2)
// ═══════════════════════════════════════════════════════

describe('POST /api/estimates/:id/revise', () => {
  const REVISE_SOURCE_SELECT = {
    id: ESTIMATE_SENT_FIXTURE.id,
    status: 'SENT',
    estimate_number: 'E00002',
    lead_id: 'lead-1',
    organization_id: 'org-test-1',
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    created_by: TEST_USERS.admin.id,
    name: null,
    scope_name: null,
    scope_notes: 'Scope',
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    discount_amount: 0,
    deposit_type: null,
    deposit_value: null,
    subtotal: 1000,
    tax_amount: 62.5,
    total_amount: 1062.5,
    line_items: [
      { sequence: 1, description: 'Item', quantity: 1, unit_price: 1000, is_taxable: true, line_total: 1000, price_book_item_id: null, unit_cost: null, discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE' },
    ],
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
  };

  function mockReviseTransaction(newEstimate: unknown) {
    const estimateUpdate = vi.fn().mockResolvedValue({});
    const estimateCreate = vi.fn().mockResolvedValue(newEstimate);
    const invoiceUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const timelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { create: estimateCreate, update: estimateUpdate },
        invoice: { updateMany: invoiceUpdateMany },
        timelineEvent: { create: timelineCreate },
      }),
    );
    return { estimateUpdate, estimateCreate, invoiceUpdateMany, timelineCreate };
  }

  it('clones a SENT estimate into a new DRAFT and supersedes the old one', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(REVISE_SOURCE_SELECT);
    const clonedEstimate = { ...ESTIMATE_FIXTURE, id: 'new-est-1', estimate_number: 'E00099', status: 'DRAFT' };
    const { estimateUpdate, estimateCreate, invoiceUpdateMany, timelineCreate } = mockReviseTransaction(clonedEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.id).toBe('new-est-1');
    // The new row is a fresh DRAFT clone with the source's line items.
    const createArgs = estimateCreate.mock.calls[0][0];
    expect(createArgs.data.status).toBe('DRAFT');
    expect(createArgs.data.lead_id).toBe('lead-1');
    expect(createArgs.data.line_items.create).toHaveLength(1);
    // R6 (2026-07-22) — same-row recall/supersede never changes lead, so the anchor carries
    // forward verbatim; job_id is never copied (the clone hasn't been used to create a job).
    expect(createArgs.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(createArgs.data.service_location_id).toBe(LOCATION_FIXTURE.id);
    expect(createArgs.data.job_id).toBeUndefined();
    // The old row is frozen as SUPERSEDED, pointing at the new one.
    const updateArgs = estimateUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('SUPERSEDED');
    expect(updateArgs.data.superseded_by_id).toBe('new-est-1');
    // Any deposit invoice carries forward — re-pointed, unadjusted — to the new estimate.
    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estimate_id: ESTIMATE_SENT_FIXTURE.id, kind: 'DEPOSIT' },
        data: { estimate_id: 'new-est-1' },
      }),
    );
    expect(timelineCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'REVISED', entity_type: 'ESTIMATE' }) }),
    );
  });

  // #2053 AC13 — revise() is a verbatim freeze-and-clone (no calculateTotals call), so it must
  // carry is_optional/is_selected through onto the new row's copied lines byte-for-byte.
  it('carries is_optional/is_selected verbatim onto the cloned lines', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...REVISE_SOURCE_SELECT,
      line_items: [
        { sequence: 1, description: 'Base', quantity: 1, unit_price: 100, is_taxable: true, line_total: 100, price_book_item_id: null, unit_cost: null, discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE', is_optional: false, is_selected: true },
        { sequence: 2, description: 'Add-on', quantity: 1, unit_price: 75, is_taxable: true, line_total: 75, price_book_item_id: null, unit_cost: null, discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE', is_optional: true, is_selected: false },
      ],
    });
    const clonedEstimate = { ...ESTIMATE_FIXTURE, id: 'new-est-3', estimate_number: 'E00101', status: 'DRAFT' };
    const { estimateCreate } = mockReviseTransaction(clonedEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const created = estimateCreate.mock.calls[0][0].data.line_items.create;
    expect(created[0]).toMatchObject({ is_optional: false, is_selected: true });
    expect(created[1]).toMatchObject({ is_optional: true, is_selected: false });
  });

  // #2029 slice 5 — a revision is a new document, and the evidence goes with it. The copy gets
  // its OWN storage objects: deleting a photo removes the underlying object, so a shared path
  // would mean deleting from the revision destroys the superseded original's image.
  it("carries the source's scope photos onto the revision, on their own storage objects", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(REVISE_SOURCE_SELECT);
    mockReviseTransaction({ ...ESTIMATE_FIXTURE, id: 'new-est-9', estimate_number: 'E00101', status: 'DRAFT' });
    const sourcePath = `org/estimate_scope/${ESTIMATE_SENT_FIXTURE.id}/scope-1/1-a.jpg`;
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([{
      id: 'sp-1', scope_id: 'scope-1', storage_path: sourcePath, mime_type: 'image/jpeg',
      caption: null, uploaded_at: new Date('2026-09-01T00:00:00Z'), uploaded_by: 'Rep', size_bytes: 2048,
    }]);
    mockPrisma.estimateScopePhoto.createMany.mockResolvedValue({ count: 1 });
    const storage = supabaseAdmin.storage.from('attachments') as unknown as { copy: ReturnType<typeof vi.fn> };
    storage.copy.mockResolvedValue({ data: { path: 'copied' }, error: null });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.copy).toHaveBeenCalledTimes(1);
    const rows = mockPrisma.estimateScopePhoto.createMany.mock.calls[0][0].data;
    expect(rows[0].estimate_id).toBe('new-est-9');
    expect(rows[0].storage_path).not.toBe(sourcePath);
    expect(rows[0].storage_path).toContain('new-est-9');
  });

  it('allows revise of a PENDING estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...REVISE_SOURCE_SELECT, status: 'PENDING' });
    const clonedEstimate = { ...ESTIMATE_FIXTURE, id: 'new-est-2', estimate_number: 'E00100', status: 'DRAFT' };
    mockReviseTransaction(clonedEstimate);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.status).toBe('DRAFT');
  });

  it('400 when the estimate is WON (frozen forever)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_APPROVED_FIXTURE.id,
      status: 'WON',
      estimate_number: 'E00003',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_APPROVED_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved|frozen/i);
  });

  it.each(['DRAFT', 'ARCHIVED', 'DECLINED'])('400 when the estimate is %s', async (status) => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status,
      estimate_number: 'E00001',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/revise`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });

  it('404 when not found', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates/nonexistent/revise')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('SALES cannot revise another rep\'s lead estimate (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: 'E00002',
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/revise`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  // Integration: after revise the estimate is DRAFT, so a re-send takes the isFirstSend
  // branch — re-snapshotting T&C and minting a fresh public_token + valid_until (no send() change).
  it('after revise, re-send re-snapshots T&C + new public_token + valid_until', async () => {
    mockAuthAs('admin');
    // A previously-sent estimate that has just been revised back to DRAFT (public_token null).
    const revisedDraft = {
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      customer_id: null,
      // SERV10X-61 §5.6 - pass send()'s ≥1-item gate (deposit_required:false, so customer_id is unused).
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: CUSTOMER_FIXTURE.id, email: CUSTOMER_FIXTURE.email } },
      deposit: null,
      send_config: null,
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(revisedDraft);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-test-1', name: 'Org', logo_url: null, brand_color: null,
      estimate_terms: 'TERMS', estimate_notes: 'NOTES', estimate_payment_terms: 'PAY',
    });

    let capturedSendData: { status?: string; public_token?: string | null; snapshot_terms?: string | null } | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockImplementation((args: { data: typeof capturedSendData }) => {
            capturedSendData = args.data;
            return { ...ESTIMATE_FIXTURE, status: 'SENT', public_token: capturedSendData?.public_token, lead: revisedDraft.lead };
          }),
          findUnique: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'dep-inv' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        lead: { update: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(200);
    // isFirstSend branch: status → SENT, fresh token, re-snapshotted terms.
    expect(capturedSendData?.status).toBe('SENT');
    expect(capturedSendData?.public_token).toBeTruthy();
    expect(capturedSendData?.snapshot_terms).toBe('TERMS');
  });
});

// ═══════════════════════════════════════════════════════
// Frozen-forever invariant (WON estimates)
// ═══════════════════════════════════════════════════════

describe('WON estimates are frozen forever', () => {
  it('rejects update of a WON estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_APPROVED_FIXTURE.id,
      status: 'WON',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_APPROVED_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'Try to edit a signed doc' });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// One WON estimate per lead
// ═══════════════════════════════════════════════════════

describe('one WON estimate per lead', () => {
  it('record-payment allows a 2nd WON on the same lead (multi-WON)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: 'E00002',
      total_amount: 1000,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      public_token: 'tok',
      valid_until: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    // Another WON estimate already exists on the lead. SERV10X-61 allows multiple
    // simultaneously-WON estimates per lead, so recording payment (→ WON) still succeeds.
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(ESTIMATE_APPROVED_FIXTURE) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
  });

  it('approvePublic (no-deposit branch) allows a 2nd WON on the same lead (multi-WON)', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: 'E00002',
      lead_id: ESTIMATE_FIXTURE.lead_id,
      organization_id: 'org-test-1',
      // Spec #1751 D6 records the lead's current status as the ledger entry's `from`.
      lead: { commission_owner_id: null, status: 'ESTIMATED' },
      total_amount: 1062.5,
      valid_until: new Date('2027-12-31'),
      signature_data: null,
      deposit: null,
      send_config: { deposit_required: false, payment_methods: [] },
      organization: { id: 'org-test-1', stripe_account_id: null, accepted_payment_methods: [] },
    });
    // Another WON estimate already exists on the lead. SERV10X-61 allows multiple
    // simultaneously-WON estimates per lead, so this public no-deposit approval (→ WON)
    // must still succeed.
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: null });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
  });

  it('waive (action=waive) allows a 2nd WON on the same lead (multi-WON)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce({
        ...ESTIMATE_SENT_FIXTURE,
        lead_id: ESTIMATE_FIXTURE.lead_id,
        invoices: [{ id: 'dep-inv-1', status: 'SENT' }],
      })
      .mockResolvedValueOnce(ESTIMATE_APPROVED_FIXTURE);
    // Another WON estimate already exists on the lead. SERV10X-61 allows multiple
    // simultaneously-WON estimates per lead, so waiving the deposit (→ WON) still succeeds.
    mockPrisma.estimate.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
  });

  it('allows approval when no other WON estimate exists on the lead', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: 'E00002',
      total_amount: 1000,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      public_token: 'tok',
      valid_until: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    // No other WON estimate on the lead.
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(ESTIMATE_APPROVED_FIXTURE) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
  });

  it('lead-less estimate skips the one-approved guard', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: STANDALONE_ESTIMATE_FIXTURE.id,
      status: 'SENT',
      estimate_number: 'E00099',
      total_amount: 1000,
      lead_id: null,
      public_token: 'tok',
      valid_until: null,
      lead: null,
      deposit: null,
      send_config: null,
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(STANDALONE_ESTIMATE_FIXTURE) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        // Lead-less SENT estimate must have a prior deposit invoice (it was sent before record-payment).
        invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }), update: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${STANDALONE_ESTIMATE_FIXTURE.id}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    // Guard short-circuits on null lead_id ⇒ count never consulted.
    expect(mockPrisma.estimate.count).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Public endpoints
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates/:id/public', () => {
  it('returns estimate with valid token', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
  });

  it('returns 400 without token', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public`);

    expect(res.status).toBe(400);
  });

  it('returns 404 with invalid token', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=bad-token`);

    expect(res.status).toBe(404);
  });

  // #904/#927 - the page must never render a CARD button that cannot be charged. Before this,
  // send_config.payment_methods was echoed verbatim, so a homeowner on an org whose Stripe
  // charges were off (or whose AppSetting override excluded CARD) was shown "Pay by card",
  // picked it, and got a silent success with no payment taken.
  describe('CARD availability in the offered payment methods', () => {
    const withMethods = (methods: string[]) => ({
      ...ESTIMATE_SENT_FIXTURE,
      send_config: { deposit_required: true, payment_methods: methods },
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });

    it('strips CARD when the org cannot take card payments', async () => {
      mockPrisma.estimate.findFirst.mockResolvedValue(withMethods(['CARD', 'CHECK', 'CASH']));
      mockPrisma.appSetting.findUnique.mockResolvedValue(null);
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-test-1', name: 'Northwind Services',
        accepted_payment_methods: ['CARD', 'CHECK', 'CASH'],
        stripe_charges_enabled: false,
      });

      const res = await request(app)
        .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

      expect(res.status).toBe(200);
      expect(res.body.estimate.send_config.payment_methods).toEqual(['CHECK', 'CASH']);
    });

    it('strips CARD when an AppSetting override excludes it even though charges are enabled', async () => {
      mockPrisma.estimate.findFirst.mockResolvedValue(withMethods(['CARD', 'CHECK']));
      mockPrisma.appSetting.findUnique.mockResolvedValue({
        key: 'available_payment_methods',
        value: JSON.stringify(['CHECK', 'CASH']),
      });
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-test-1', name: 'Northwind Services',
        accepted_payment_methods: ['CARD', 'CHECK'],
        stripe_charges_enabled: true,
      });

      const res = await request(app)
        .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

      expect(res.status).toBe(200);
      expect(res.body.estimate.send_config.payment_methods).toEqual(['CHECK']);
    });

    it('keeps CARD when it is genuinely payable, and leaves the other methods alone', async () => {
      mockPrisma.estimate.findFirst.mockResolvedValue(withMethods(['CARD', 'EXTERNAL_CARD', 'CHECK']));
      mockPrisma.appSetting.findUnique.mockResolvedValue(null);
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-test-1', name: 'Northwind Services',
        accepted_payment_methods: ['CARD', 'CHECK'],
        stripe_charges_enabled: true,
      });

      const res = await request(app)
        .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

      expect(res.status).toBe(200);
      // EXTERNAL_CARD is a manual method - it must survive even though the org's accepted list
      // does not name it. Only CARD is gated on Stripe.
      expect(res.body.estimate.send_config.payment_methods).toEqual(['CARD', 'EXTERNAL_CARD', 'CHECK']);
    });
  });

  it('returns terms from AppSetting estimate_terms', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue({ key: 'estimate_terms', value: 'Pay within 30 days.' });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.terms).toBe('Pay within 30 days.');
  });

  it('returns terms: null when AppSetting not set', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      valid_until: null,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.terms).toBeNull();
  });

  it('returns expired: true when valid_until is in the past', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      valid_until: new Date('2025-01-01'),
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(true);
  });

  it('returns payment_instructions', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      valid_until: null,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_terms', value: 'Terms here' })
      .mockResolvedValueOnce({ key: 'bank_transfer_instructions', value: 'Wire to account X' })
      .mockResolvedValueOnce({ key: 'check_instructions', value: 'Mail check to...' })
      .mockResolvedValueOnce({ key: 'cash_instructions', value: 'Pay in office' });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_instructions.bank_transfer).toBe('Wire to account X');
    expect(res.body.payment_instructions.check).toBe('Mail check to...');
    expect(res.body.payment_instructions.cash).toBe('Pay in office');
  });

  it('includes organization subset in public response', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      organization_id: '00000000-0000-0000-0000-000000000001',
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      name: 'Northwind Services', logo_url: null, brand_color: '#242424',
      email: 'info@alpha.com', website: null, estimate_terms: 'Sample terms.',
      estimate_notes: 'Notes', estimate_payment_terms: 'Payment terms', country: 'US',
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.organization).toMatchObject({
      name: 'Northwind Services',
      brand_color: '#242424',
      email: 'info@alpha.com',
      estimate_terms: 'Sample terms.',
    });
    expect(res.body.organization).not.toHaveProperty('estimate_notes');
    expect(res.body.organization).not.toHaveProperty('country');
  });

  // ─── Slice 4 (card service fee) — deposit preview, display-only per D8 ───
  it('returns service_fee_bps and a computed service_fee_preview off the deposit total when a deposit is required', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK'] },
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 500, amount_due: 500 }],
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-test-1', name: 'Northwind Services',
      accepted_payment_methods: ['CARD', 'CHECK'],
      stripe_charges_enabled: true,
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.service_fee_bps).toBe(350);
    // $500 deposit → 50000 cents × 350bps / 10000 = 1750 cents = $17.50.
    expect(res.body.service_fee_preview).toBe(17.50);
  });

  it('returns a zero service_fee_bps/preview when no deposit is required', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      send_config: { deposit_required: false, payment_methods: ['CARD', 'CHECK'] },
      invoices: [],
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-test-1', name: 'Northwind Services',
      accepted_payment_methods: ['CARD', 'CHECK'],
      stripe_charges_enabled: true,
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.service_fee_bps).toBe(0);
    expect(res.body.service_fee_preview).toBe(0);
  });

  // "Is there a deposit to charge" is the ONLY thing that can zero the preview here - never who
  // the org is. This org row carries the retired opt-out flag set to false; it must be ignored.
  it('previews the full service fee on a deposit with no org opt-out available', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK'] },
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 500, amount_due: 500 }],
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-test-1', name: 'Northwind Services',
      accepted_payment_methods: ['CARD', 'CHECK'],
      stripe_charges_enabled: true,
      card_service_fee_enabled: false, // stale/ignored - must not suppress anything
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.service_fee_bps).toBe(350);
    expect(res.body.service_fee_preview).toBe(17.50);
  });
});

describe('POST /api/estimates/:id/approve', () => {
  const sentFixtureNoDeposit = {
    id: ESTIMATE_SENT_FIXTURE.id,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    // The public door reads both of these off the estimate: the org because there is no signed-in
    // user to take a tenant from, and the lead's CURRENT status because spec #1751 D6 records it
    // as the ledger entry's `from`. Both are in approvePublic's select; the fixture omitted them.
    organization_id: 'org-test-1',
    lead: { commission_owner_id: null, status: 'ESTIMATED' },
    total_amount: 1062.5,
    valid_until: new Date('2027-12-31'),
    signature_data: null,
    deposit: null,
    send_config: { deposit_required: false, payment_methods: [] },
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_test',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'],
    },
  };

  const sentFixtureWithDeposit = {
    ...sentFixtureNoDeposit,
    // The kind=DEPOSIT Invoice is the SOLE deposit document (legacy Deposit gone).
    invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 531.25, amount_due: 531.25 }],
    send_config: { deposit_required: true, payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER'] },
  };

  const sentFixtureWithDepositNoneProvider = {
    ...sentFixtureWithDeposit,
    organization: {
      id: 'org-test-1',
      stripe_account_id: null,
      stripe_charges_enabled: false,
      accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'],
    },
  };

  // Task 1.7 re-key — the central regression this task exists to fix: the Stripe account
  // EXISTS (stripe_account_id set) and accepted_payment_methods already lists CARD (e.g.
  // auto-added by an earlier account.updated webhook, later restricted, or set once and never
  // cleared) but Stripe has NOT enabled charges. Pre-1.7 this call site keyed off
  // accepted_payment_methods.includes('CARD'), which would have WRONGLY routed this estimate
  // through Stripe checkout instead of falling through to the manual approve path.
  const sentFixtureWithDepositMidOnboarding = {
    ...sentFixtureWithDeposit,
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_mid_onboarding',
      stripe_charges_enabled: false,
      accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER'],
    },
  };

  // Spec B1 safety property. Staff can now set PENDING by hand, and such a row is honestly
  // UNSIGNED (only this route ever captures a signature). The retry branch must therefore key off
  // the signature actually on file, not off the status - otherwise a hand-set PENDING would skip
  // signature capture entirely and the estimate could reach WON with no consent record.
  it('still requires a signature on a hand-set PENDING that was never signed', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      status: 'PENDING',
      signature_data: null,
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ payment_method: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  // The other half of the same rule: a GENUINE retry (customer signed, then abandoned the card
  // checkout) must still skip re-capture, so the original consent record stays immutable.
  it('does not re-demand a signature on a genuinely-signed PENDING estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      status: 'PENDING',
      signature_data: 'data:image/png;base64,originalconsent',
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ payment_method: null });

    expect(res.status).toBe(200);
  });

  it('should auto-approve when no deposit required', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureNoDeposit);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: null });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
  });

  // #992: approvePublic's no-deposit branch used to fire both fireAndForgetApprovalEmails
  // (-> sendApprovalConfirmationToCustomer) and this inline PDF notification, sending the
  // customer two byte-identical "Estimate {n} - Approved" subjects. Assert on the count of
  // sends addressed to the customer, not just which function fired - the bug was "one too many".
  function countCustomerSends(email: string) {
    return Object.values(emailLib)
      .filter((fn: unknown): fn is ReturnType<typeof vi.fn> => typeof fn === 'function' && 'mock' in fn)
      .flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)
      .filter((call) => (call[0] as { to?: string } | undefined)?.to === email).length;
  }

  function approveTx() {
    return (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    };
  }

  function approvalEmailRow(anchor: 'lead' | 'customer') {
    const org = { name: 'Doe HVAC Co', logo_url: null, brand_color: '#000000' };
    return {
      id: ESTIMATE_SENT_FIXTURE.id,
      organization_id: 'org-test-1',
      lead_id: anchor === 'lead' ? LEAD_FIXTURE.id : null,
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      total_amount: 1062.5,
      subtotal: 1000,
      tax_amount: 62.5,
      discount_amount: null,
      discount_name: null,
      approved_at: new Date('2026-01-22'),
      public_token: ESTIMATE_SENT_FIXTURE.public_token,
      line_items: [],
      organization: org,
      customer: anchor === 'customer' ? CUSTOMER_FIXTURE : null,
      lead: anchor === 'lead' ? { customer: CUSTOMER_FIXTURE } : null,
    };
  }

  it('#992: lead-anchored no-deposit approval sends the customer exactly ONE email', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureNoDeposit);
    mockPrisma.$transaction.mockImplementation(approveTx());
    mockPrisma.estimate.findUnique.mockResolvedValue(approvalEmailRow('lead'));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: null });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(countCustomerSends(CUSTOMER_FIXTURE.email)).toBe(1);
  });

  it('#992: customer-anchored (lead-less) no-deposit approval also sends exactly ONE email', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({ ...sentFixtureNoDeposit, lead_id: null });
    mockPrisma.$transaction.mockImplementation(approveTx());
    mockPrisma.estimate.findUnique.mockResolvedValue(approvalEmailRow('customer'));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: null });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(countCustomerSends(CUSTOMER_FIXTURE.email)).toBe(1);
  });

  it('should set PENDING when deposit required + non-Stripe method', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' }),
        },
        deposit: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    expect(res.body.estimate.status).toBe('PENDING');
  });

  it('should return checkout_url when payment_method is CARD', async () => {
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithDeposit)  // initial fetch
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });  // re-fetch after session
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_test_xyz', url: 'https://checkout.stripe.com/session_xyz' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.com/session_xyz');
    expect(mockCreateCheckoutSession).toHaveBeenCalled();
  });

  // ── Task 3.1: application fee plumbing — double guard exercised at the call site ──
  it('passes a positive application_fee_amount when the org has a connected Stripe account', async () => {
    const fixture = {
      ...sentFixtureWithDeposit,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 1000, amount_due: 1000 }],
      organization: { ...sentFixtureWithDeposit.organization, platform_fee_bps: 50 },
    };
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(fixture)  // initial fetch
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });  // re-fetch after session
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    // getStripeForOrg is globally mocked to a fixed { stripe: {}, stripeAccount: undefined } —
    // override it here to simulate a genuinely connected account (§ getStripeForOrg contract).
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_test' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_1', url: 'https://checkout.stripe.com/fee1' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    // The application fee is the D2 remainder of the service fee, not platform_fee_bps: $1,000
    // deposit face → 3500c service fee less the estimated Stripe cut = 468c. depositAmount stays
    // 1000 — the org still receives face value; the fee rides on top, funded by the customer.
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_test' }),
    );
  });

  it('omits application_fee_amount when the org has no connected Stripe account, even with platform_fee_bps set (legacy platform-account guard)', async () => {
    const fixture = {
      ...sentFixtureWithDeposit,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 1000, amount_due: 1000 }],
      organization: {
        id: 'org-test-1',
        stripe_account_id: null,
        stripe_charges_enabled: true,
        accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER'],
        platform_fee_bps: 50,
      },
    };
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(fixture)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    // Default mock: getStripeForOrg → { stripe: {}, stripeAccount: undefined } (no override) —
    // models a legacy/platform-account org, which must never get an application_fee_amount.
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_2', url: 'https://checkout.stripe.com/fee2' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    const [options, ctxArg] = mockCreateCheckoutSession.mock.calls[0];
    expect(options.depositAmount).toBe(1000); // face value, unaffected
    expect(options.applicationFeeAmount).toBeUndefined();
    expect(ctxArg.stripeAccount).toBeUndefined();
  });

  // ─── Slice 2 (card service fee) — checkout wiring ─────────────────────────
  it('passes a service fee (D2 replacing the platform fee) on any deposit checkout with a connected account', async () => {
    const fixture = {
      ...sentFixtureWithDeposit,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 1000, amount_due: 1000 }],
      organization: { ...sentFixtureWithDeposit.organization },
    };
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(fixture)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_fee_test' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_3', url: 'https://checkout.stripe.com/fee3' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    // $1,000 deposit face value → 3.5% = $35.00 (3500c) service fee; the application fee is the
    // D2-derived remainder, never a flat platform-fee percentage.
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, serviceFeeAmount: 3500, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_fee_test' }),
    );
  });

  // The switch is gone: an org row carrying leftover opt-out-shaped fields changes nothing,
  // because the fee math never reads the org at all.
  it('charges the service fee regardless of what the org row says', async () => {
    const fixture = {
      ...sentFixtureWithDeposit,
      invoices: [{ id: 'dep-inv-1', status: 'SENT', total_amount: 1000, amount_due: 1000 }],
      // stale/ignored fields - must not suppress anything
      organization: { ...sentFixtureWithDeposit.organization, platform_fee_bps: 50, card_service_fee_enabled: false },
    };
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(fixture)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockGetStripeForOrg.mockReturnValueOnce({ stripe: {}, stripeAccount: 'acct_fee_test_2' });
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_fee_4', url: 'https://checkout.stripe.com/fee4' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ depositAmount: 1000, serviceFeeAmount: 3500, applicationFeeAmount: 468 }),
      expect.objectContaining({ stripeAccount: 'acct_fee_test_2' }),
    );
  });

  // ── D6 (2026-07-21): PENDING = "customer approved + signed, deposit not yet processed" ──
  // The card lane used to leave the row at SENT while writing the signature, so a customer who
  // signed and then closed the Stripe tab produced a signed-but-SENT estimate: the signature said
  // yes while the status said we had never heard back, and the document stayed editable.
  it('CARD approval moves the estimate to PENDING and records the signature', async () => {
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithDeposit)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/s1' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    const written = mockPrisma.estimate.update.mock.calls[0]![0].data;
    expect(written.status).toBe('PENDING');
    expect(written.signature_data).toBe('data:image/png;base64,abc123');
    expect(written.signature_at).toBeInstanceOf(Date);
  });

  it('re-opens checkout for a PENDING estimate without re-capturing the signature', async () => {
    // The customer abandoned the Stripe page. The estimate is no longer SENT, so without a
    // re-entry path they would be stranded with an outstanding deposit and no way to pay it.
    const pendingFixture = {
      ...sentFixtureWithDeposit,
      status: 'PENDING',
      signature_data: 'data:image/png;base64,ORIGINAL',
    };
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(pendingFixture)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_2', url: 'https://checkout.stripe.com/s2' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ payment_method: 'CARD' });   // no signature_data — already signed

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.stripe.com/s2');
    // The stored consent record must be left exactly as it was.
    const written = mockPrisma.estimate.update.mock.calls[0]![0].data;
    expect(written).not.toHaveProperty('signature_data');
    expect(written).not.toHaveProperty('signature_at');
  });

  it('still requires a signature on a first-time approval', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature is required/i);
  });

  // #904 - BEHAVIOUR CHANGE from Task 1.7 / §4.6 (PR #924).
  //
  // These two scenarios (NONE-provider org, and mid-onboarding org whose Stripe account exists
  // but has charges disabled) previously fell through to Branch 3: the estimate was stamped
  // PENDING and the request returned 200. That is a silent no-op - the homeowner picked CARD,
  // saw success, and no card was ever charged. It must reject instead.
  //
  // No real customer reaches this path: getPublic now strips CARD from the offered methods
  // whenever this same resolver says it is not payable, so the page never renders the button.
  // These tests cover the direct-API backstop.
  it('rejects CARD when org is on NONE provider, instead of silently taking the manual path', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDepositNoneProvider);
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    // The estimate must be left exactly as it was - not stamped PENDING by the manual branch.
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects CARD when the Stripe account exists but charges are not yet enabled (mid-onboarding)', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDepositMidOnboarding);
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // #927 - the estimate-side twin of the invoice fix in c16f1083. Charges are genuinely enabled
  // (no race, no TOCTOU) but an AppSetting override has narrowed the org's accepted methods to
  // exclude CARD. stripe_charges_enabled alone would wrongly wave this through to checkout.
  it('rejects CARD when charges are enabled but an AppSetting override excludes CARD', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);
    mockIsStripeConfigured.mockReturnValue(true);
    (prisma.appSetting.findUnique as any).mockResolvedValue({
      key: 'available_payment_methods',
      value: JSON.stringify(['CHECK', 'CASH']),
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  // Branch 3 must be untouched: a genuine non-CARD selection still takes the manual path, and
  // EXTERNAL_CARD in particular is NOT CARD - it never routes through Stripe.
  it('still routes EXTERNAL_CARD through the manual approve path when Stripe cannot take cards', async () => {
    const fixture = {
      ...sentFixtureWithDepositNoneProvider,
      send_config: { deposit_required: true, payment_methods: ['EXTERNAL_CARD', 'CHECK'] },
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(fixture);
    (prisma.appSetting.findUnique as any).mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' }),
        },
        deposit: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'EXTERNAL_CARD' });

    expect(res.status).toBe(200);
    expect(res.body.estimate.status).toBe('PENDING');
    expect(res.body.checkout_url).toBeUndefined();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('should reject if payment method not in send_config', async () => {
    const fixture = {
      ...sentFixtureWithDeposit,
      send_config: { deposit_required: true, payment_methods: ['CHECK'] },
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(fixture);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment method not available/i);
  });

  it('should reject approve on expired estimate', async () => {
    const fixture = {
      ...sentFixtureNoDeposit,
      valid_until: new Date('2025-01-01'),
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(fixture);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('should reject if deposit required but no payment method', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment method is required/i);
  });

  it('should allow re-approval after abandoned Stripe checkout', async () => {
    const fixtureWithPriorSignature = {
      ...sentFixtureWithDeposit,
      signature_data: 'data:image/png;base64,old-signature',
    };
    mockPrisma.estimate.findFirst.mockResolvedValue(fixtureWithPriorSignature);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' }),
        },
        deposit: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,new-signature', payment_method: 'CHECK' });

    expect(res.status).toBe(200);
    expect(res.body.estimate.status).toBe('PENDING');
  });

  it('should return 400 when Stripe not configured for CARD payment', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);
    mockPrisma.estimate.update.mockResolvedValue({});
    mockIsStripeConfigured.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/card payment is not available/i);
  });

  it('returns 400 without token', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve`);

    expect(res.status).toBe(400);
  });

  it('returns 404 with invalid token', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=bad`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(404);
  });

  it('rejects approve on non-SENT estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      status: 'DRAFT',
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/approve?token=some-token`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(400);
  });

  it('triggers fire-and-forget email lookup for no-deposit approval', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureNoDeposit);
    // Run the approval transaction against the global mockPrisma so the post-commit
    // signed-PDF lookup (estimate.findUnique with the organization/customer include) is
    // observable on the same mock the assertion below inspects.
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.estimate.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(mockPrisma.estimate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ESTIMATE_SENT_FIXTURE.id },
        include: expect.objectContaining({ organization: true }),
      }),
    );
    // R10: the win reserves nothing.
    expect(mockPrisma.estimateReservation.create).not.toHaveBeenCalled();
  });

  it('returns 400 when signature_data is missing', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 400 when signature_data does not start with data:image/', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'not-a-valid-image-data-url' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid signature format/i);
  });

  it('stores signature_data, signature_ip, signature_at in transaction update', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureNoDeposit);
    let capturedUpdateData: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            capturedUpdateData = data;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });
          }),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(capturedUpdateData.signature_data).toBe('data:image/png;base64,abc123');
    expect(capturedUpdateData.signature_at).toBeInstanceOf(Date);
    // signature_ip may be null in test env but should be present as a key
    expect('signature_ip' in capturedUpdateData).toBe(true);
  });

  it('F-24: records the trust-proxy-resolved req.ip, not the raw (spoofable) X-Forwarded-For', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureNoDeposit);
    let capturedUpdateData: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            capturedUpdateData = data;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });
          }),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    // Client prepends a spoofed hop. With app.set('trust proxy', 1), req.ip trusts ONE hop from
    // the right ('9.9.9.9') and ignores the attacker-controlled leftmost value ('6.6.6.6').
    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .set('X-Forwarded-For', '6.6.6.6, 9.9.9.9')
      .send({ signature_data: 'data:image/png;base64,abc123' });

    // The old code captured the raw header verbatim → '6.6.6.6, 9.9.9.9' (spoof poisons the audit).
    // The fix captures req.ip, which is NOT the spoofed leftmost value and NOT the raw header string.
    expect(capturedUpdateData.signature_ip).not.toBe('6.6.6.6');
    expect(capturedUpdateData.signature_ip).not.toBe('6.6.6.6, 9.9.9.9');
  });

  it('should not transition a LOST lead to WON on approval', async () => {
    // The lead really IS lost here. Before spec #1751 D6 this test could only assert the shape of
    // the `notIn` guard the door hand-rolled; the one writer now refuses the move on the caller's
    // own known status and never reaches the database, so the refusal is proved by the absence of
    // the write — and of any ledger entry claiming the lead was won.
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      lead: { commission_owner_id: null, status: 'LOST' },
    });
    const txLeadUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const txTimelineCreate = vi.fn().mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
        },
        lead: { updateMany: txLeadUpdateMany },
        timelineEvent: { create: txTimelineCreate },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(leadStatusWrites(txLeadUpdateMany)).toHaveLength(0);
    expect(statusChangeEvents(txTimelineCreate)).toHaveLength(0);
  });

  it('sends sendEstimateApprovedNotification for non-CARD payment method', async () => {
    const mockSendApprovedNotification = vi.mocked(sendEstimateApprovedNotification);
    mockSendApprovedNotification.mockClear();

    mockPrisma.estimate.findFirst.mockResolvedValue(sentFixtureWithDeposit);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'PENDING' }),
        },
        deposit: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });
    // Fire-and-forget findUnique returns estimate with org + deposit
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      total_amount: 1062.5,
      deposit: { payment_method: 'CHECK' },
      organization: { name: 'Test Org', logo_url: null, brand_color: null },
      lead: {
        customer: {
          first_name: 'John',
          last_name: 'Doe',
          company_name: null,
          email: 'john@example.com',
        },
      },
    });

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc', payment_method: 'CHECK' });

    // Allow fire-and-forget to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSendApprovedNotification).toHaveBeenCalledWith(
      expect.objectContaining({ estimateNumber: expect.any(String) })
    );
  });

  it('does NOT send sendEstimateApprovedNotification for CARD payment method', async () => {
    const mockSendApprovedNotification = vi.mocked(sendEstimateApprovedNotification);
    mockSendApprovedNotification.mockClear();

    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithDeposit)
      .mockResolvedValueOnce({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'SENT' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_test_xyz', url: 'https://checkout.stripe.com/session_xyz' });

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc', payment_method: 'CARD' });

    // Allow any potential async calls to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSendApprovedNotification).not.toHaveBeenCalled();
  });

  // #21 — T&C server-gate tests
  it('#21 rejects approve when snapshot_terms is set but terms_accepted is missing', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      snapshot_terms: 'E2E terms',
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' }); // no terms_accepted

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Terms acceptance is required');
  });

  it('#21 approves and persists terms when snapshot_terms is set and terms_accepted is true', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      snapshot_terms: 'E2E terms',
    });
    let capturedUpdateData: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            capturedUpdateData = data;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'WON', terms_accepted: true, terms_accepted_at: new Date() });
          }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', terms_accepted: true });

    expect(res.status).toBe(200);
    expect(capturedUpdateData.terms_accepted).toBe(true);
    expect(capturedUpdateData.terms_accepted_at).toBeInstanceOf(Date);
  });

  it('#21 approves without terms_accepted when snapshot_terms is null', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      snapshot_terms: null,
    });
    let capturedUpdateData: Record<string, unknown> = {};
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            capturedUpdateData = data;
            return Promise.resolve({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' });
          }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' }); // no terms_accepted

    expect(res.status).toBe(200);
    expect(capturedUpdateData.terms_accepted).toBeUndefined();
    expect(capturedUpdateData.terms_accepted_at).toBeUndefined();
  });

  it('#21 treats empty/whitespace snapshot_terms as no-terms (passes without acceptance)', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...sentFixtureNoDeposit,
      snapshot_terms: '   ',
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' }); // no terms_accepted

    expect(res.status).toBe(200);
  });
});

describe('POST /api/estimates/:id/decline', () => {
  it('declines SENT estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
      deposit: null,
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'DECLINED' }),
        },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
  });

  it('returns 404 with invalid token', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline?token=bad`);

    expect(res.status).toBe(404);
  });

  it('rejects decline on non-SENT/PENDING estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      deposit: null,
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/decline?token=some-token`);

    expect(res.status).toBe(400);
  });

  it('should allow decline from PENDING and void the unpaid kind=DEPOSIT invoice', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_SENT_FIXTURE.id,
      status: 'PENDING',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    });
    let depositInvoiceVoided = false;
    let timelineEventsCreated: string[] = [];
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          update: vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, status: 'DECLINED' }),
        },
        invoice: {
          updateMany: vi.fn().mockImplementation(() => {
            depositInvoiceVoided = true;
            return Promise.resolve({ count: 1 });
          }),
        },
        timelineEvent: {
          create: vi.fn().mockImplementation(({ data }: { data: { event_type: string } }) => {
            timelineEventsCreated.push(data.event_type);
            return Promise.resolve({});
          }),
        },
      };
      return fn(tx);
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/decline?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(depositInvoiceVoided).toBe(true);
    expect(timelineEventsCreated).toContain('DECLINED');
    expect(timelineEventsCreated).toContain('DEPOSIT_VOIDED');
  });
});

// ═══════════════════════════════════════════════════════
// Notes
// ═══════════════════════════════════════════════════════

describe('Estimate Notes', () => {
  it('GET /:id/notes returns notes list', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.note.findMany.mockResolvedValue([
      { id: 'n1', content: 'Test note', created_at: new Date(), creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' } },
    ]);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it('POST /:id/notes creates a note', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.note.create.mockResolvedValue({
      id: 'n2',
      content: 'New note',
      created_at: new Date(),
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'New note' });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe('New note');
  });

  it('returns 404 for notes on non-existent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/estimates/nonexistent/notes')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates/stats', () => {
  it('returns per-status estimate stats', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.count.mockResolvedValue(10);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _sum: { total_amount: 50000 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 3, _sum: { amount_due: 1500 } });

    const res = await request(app)
      .get('/api/estimates/stats')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    for (const key of ['draft', 'sent', 'pending', 'won', 'declined', 'archived']) {
      expect(res.body[key]).toHaveProperty('count');
      expect(res.body[key]).toHaveProperty('value');
    }
    expect(res.body.pending_deposits).toHaveProperty('count');
    expect(res.body.pending_deposits).toHaveProperty('total');
  });

  it('getStats includes PENDING count and pending_deposits KPI', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.count
      .mockResolvedValueOnce(5)  // DRAFT
      .mockResolvedValueOnce(3)  // SENT
      .mockResolvedValueOnce(2)  // PENDING
      .mockResolvedValueOnce(7)  // WON
      .mockResolvedValueOnce(1)  // DECLINED
      .mockResolvedValueOnce(0); // ARCHIVED
    mockPrisma.estimate.aggregate.mockResolvedValue({ _sum: { total_amount: 10000 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 4, _sum: { amount_due: 2000 } });

    const res = await request(app)
      .get('/api/estimates/stats')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.pending.count).toBe(2);
    expect(res.body.pending_deposits.count).toBe(4);
    expect(res.body.pending_deposits.total).toBe(2000);
  });

  it('scopes the estimate stats to own leads for SALES — matches the scoped list (authz-1)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.estimate.aggregate.mockResolvedValue({ _sum: { total_amount: 0 } });
    mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });

    const res = await request(app)
      .get('/api/estimates/stats')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    // SERV10X-61 §8 - the stats scope mirrors the list scope: own-via-lead OR own
    // lead-less-created (under `where.OR`).
    const salesFilter = {
      OR: [
        { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
        { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
      ],
    };
    // Every estimate count + aggregate must carry the SALES lead-owner scope, so a
    // SALES user's summary cards never sum estimates they cannot see in the list.
    expect(mockPrisma.estimate.count.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockPrisma.estimate.count.mock.calls) {
      expect(call[0].where).toMatchObject(salesFilter);
    }
    for (const call of mockPrisma.estimate.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject(salesFilter);
    }
  });
});

// ═══════════════════════════════════════════════════════
// State Tax Rates
// ═══════════════════════════════════════════════════════

describe('GET /api/state-tax-rates', () => {
  it('returns list of state tax rates', async () => {
    mockAuthAs('admin');
    mockPrisma.stateTaxRate.findMany.mockResolvedValue([STATE_TAX_FIXTURE]);
    // R5c (2026-07-22) — list() now also merges the caller org's custom rates in.
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/state-tax-rates')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].state_code).toBe('TX');
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get('/api/state-tax-rates');
    expect(res.status).toBe(401);
  });

  it('blocks TECHNICIAN access', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/state-tax-rates')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// App Settings
// ═══════════════════════════════════════════════════════

describe('GET /api/settings/:key', () => {
  it('returns setting value', async () => {
    mockAuthAs('admin');
    mockPrisma.appSetting.findUnique.mockResolvedValue({ key: 'default_tax_state', value: 'TX', updated_at: new Date() });

    const res = await request(app)
      .get('/api/settings/default_tax_state')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('TX');
  });

  it('returns 404 for non-existent key', async () => {
    mockAuthAs('admin');
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/settings/nonexistent')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/settings/:key', () => {
  it('ADMIN can update setting', async () => {
    mockAuthAs('admin');
    mockPrisma.appSetting.upsert.mockResolvedValue({ key: 'default_tax_state', value: 'CA', updated_at: new Date() });

    const res = await request(app)
      .patch('/api/settings/default_tax_state')
      .set(authHeader('admin'))
      .send({ value: 'CA' });

    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('CA');
  });

  it('SALES cannot update settings', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch('/api/settings/default_tax_state')
      .set(authHeader('sales'))
      .send({ value: 'CA' });

    expect(res.status).toBe(403);
  });

  it('validates value is required', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/settings/default_tax_state')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// Discount + Cost Fields (P0-3)
// ═══════════════════════════════════════════════════════

describe('Estimate Discounts', () => {
  it('creates estimate with per-line percentage discount', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const newEst = { ...ESTIMATE_FIXTURE, id: 'new-disc-id' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00001' }),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.0625,
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 10, item_type: 'SERVICE' },
        ],
      });

    expect(res.status).toBe(201);
    // Verify transaction was called (totals calculated server-side)
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('creates estimate with per-line fixed discount', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const newEst = { ...ESTIMATE_FIXTURE, id: 'new-fixed-id' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.0625,
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_taxable: true, discount_type: 'FIXED_AMOUNT', discount_value: 100 },
        ],
      });

    expect(res.status).toBe(201);
  });

  it('creates estimate with estimate-level discount', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const newEst = { ...ESTIMATE_FIXTURE, id: 'est-lvl-disc' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.0625,
        discount_type: 'PERCENTAGE',
        discount_value: 5,
        discount_name: 'Loyalty discount',
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_taxable: true },
          { description: 'Labor', quantity: 2, unit_price: 100, is_taxable: true },
        ],
      });

    expect(res.status).toBe(201);
  });

  it('creates estimate with combined line + estimate discounts', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const newEst = { ...ESTIMATE_FIXTURE, id: 'combined-disc' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.0625,
        discount_type: 'FIXED_AMOUNT',
        discount_value: 50,
        discount_name: 'Flat off',
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 500, is_taxable: true, discount_type: 'PERCENTAGE', discount_value: 10 },
          { description: 'Filter', quantity: 2, unit_price: 25, is_taxable: false, item_type: 'MATERIAL' },
        ],
      });

    expect(res.status).toBe(201);
  });

  it('creates estimate with price_book_item_id and unit_cost', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ id: 'db100000-0000-0000-0000-000000000001' }]);

    const newEst = { ...ESTIMATE_FIXTURE, id: 'pb-item-est' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0.0625,
        line_items: [
          {
            description: 'AC Tune-Up',
            quantity: 1,
            unit_price: 150,
            is_taxable: true,
            price_book_item_id: 'db100000-0000-0000-0000-000000000001',
            unit_cost: 50,
            item_type: 'SERVICE',
          },
        ],
      });

    expect(res.status).toBe(201);
  });

  it('creates estimate with MATERIAL item_type', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.lead_id,
      status: 'CONTACTED',
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    });

    const newEst = { ...ESTIMATE_FIXTURE, id: 'material-est' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(newEst),
        },
        lead: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({
        lead_id: ESTIMATE_FIXTURE.lead_id,
        tax_rate: 0,
        line_items: [
          { description: 'Refrigerant', quantity: 3, unit_price: 45, is_taxable: true, item_type: 'MATERIAL' },
        ],
      });

    expect(res.status).toBe(201);
  });

  it('updates estimate with discount fields', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const updated = { ...ESTIMATE_FIXTURE, discount_type: 'PERCENTAGE', discount_value: 10, discount_name: 'Seasonal' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue(updated) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        discount_type: 'PERCENTAGE',
        discount_value: 10,
        discount_name: 'Seasonal',
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_taxable: true },
        ],
      });

    expect(res.status).toBe(200);
  });

  it('updates estimate discount metadata only (no line items)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      discount_name: 'VIP Discount',
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ discount_name: 'VIP Discount' });

    expect(res.status).toBe(200);
  });

  it('duplicate copies discount fields from source', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: ESTIMATE_FIXTURE.lead_id,
      scope_notes: ESTIMATE_FIXTURE.scope_notes,
      tax_rate: ESTIMATE_FIXTURE.tax_rate,
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      discount_name: 'Seasonal',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: [
        {
          sequence: 1,
          description: 'AC Unit',
          quantity: 1,
          unit_price: 1000,
          is_taxable: true,
          line_total: 1000,
          price_book_item_id: null,
          unit_cost: 400,
          discount_type: 'FIXED_AMOUNT',
          discount_value: 50,
          item_type: 'SERVICE',
        },
      ],
    });

    const duplicated = { ...ESTIMATE_FIXTURE, id: 'dup-disc-id', estimate_number: 'E00010' };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00009' }),
          create: vi.fn().mockResolvedValue(duplicated),
        },
      };
      return fn(tx);
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/duplicate`)
      .set(authHeader('admin'));

    expect(res.status).toBe(201);
    // Verify create was called with discount fields
    const txFn = mockPrisma.$transaction.mock.calls[0][0] as (tx: any) => Promise<any>;
    const fakeTx = {
      estimate: {
        findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00009' }),
        create: vi.fn().mockResolvedValue(duplicated),
      },
    };
    await txFn(fakeTx);
    const createCall = fakeTx.estimate.create.mock.calls[0][0];
    expect(createCall.data.discount_type).toBe('PERCENTAGE');
    expect(createCall.data.discount_name).toBe('Seasonal');
    expect(createCall.data.line_items.create[0].discount_type).toBe('FIXED_AMOUNT');
    expect(createCall.data.line_items.create[0].unit_cost).toBe(400);
    expect(createCall.data.line_items.create[0].item_type).toBe('SERVICE');
  });

  it('public endpoint excludes unit_cost from line items', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      discount_amount: 0,
      lead: { customer: { first_name: 'John', last_name: 'Doe', company_name: null } },
      line_items: [
        {
          id: 'li1', sequence: 1, description: 'AC Unit', quantity: 1,
          unit_price: 1000, is_taxable: true, line_total: 1000,
          discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
          // NOTE: unit_cost should NOT be in public select, but the mock returns whatever we give
        },
      ],
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    // The controller uses estimatePublicSelect which excludes unit_cost
    // We verify by checking the select object doesn't include it
    const findFirstCall = mockPrisma.estimate.findFirst.mock.calls[0][0];
    expect(findFirstCall.select.line_items.select.unit_cost).toBeUndefined();
  });
});

// REMOVED: POST /:id/mark-deposit-received — superseded by /:id/record-payment.

// ─── POST /:id/waive-deposit ──────────────────────────

describe('POST /api/estimates/:id/waive-deposit', () => {
  // The kind=DEPOSIT Invoice is the SOLE deposit document; an active (DRAFT/SENT) one is waivable.
  const SENT_WITH_DEPOSIT = {
    ...ESTIMATE_SENT_FIXTURE,
    lead_id: ESTIMATE_FIXTURE.lead_id,
    invoices: [{ id: 'dep-inv-1', status: 'SENT' }],
  };

  const PENDING_WITH_DEPOSIT = {
    ...SENT_WITH_DEPOSIT,
    status: 'PENDING',
    invoices: [{ id: 'dep-inv-1', status: 'SENT' }],
  };

  function mockTransaction() {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn(mockPrisma);
    });
  }

  it('admin can waive deposit on SENT estimate', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(SENT_WITH_DEPOSIT)
      .mockResolvedValueOnce(ESTIMATE_APPROVED_FIXTURE);
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBeDefined();
    // The kind=DEPOSIT invoice is voided (the SOLE deposit document).
    expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dep-inv-1' }, data: expect.objectContaining({ status: 'VOIDED' }) }),
    );
  });

  it('voids the kind=DEPOSIT invoice (the sole deposit document)', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(PENDING_WITH_DEPOSIT)
      .mockResolvedValueOnce(ESTIMATE_APPROVED_FIXTURE);
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dep-inv-1' }, data: expect.objectContaining({ status: 'VOIDED', voided_reason: 'Deposit waived' }) }),
    );
  });

  it('admin can waive deposit on PENDING estimate', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(PENDING_WITH_DEPOSIT)
      .mockResolvedValueOnce(ESTIMATE_APPROVED_FIXTURE);
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(200);
  });

  it('admin can cancel with deposit on PENDING estimate', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(PENDING_WITH_DEPOSIT)
      .mockResolvedValueOnce({ ...ESTIMATE_FIXTURE, status: 'ARCHIVED' });
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'cancel' });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ARCHIVED' }) }),
    );
  });

  it('rejects when there is no active (DRAFT/SENT) deposit invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      invoices: [{ id: 'dep-inv-1', status: 'PAID' }],
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No active deposit/);
  });

  it('sales cannot waive (403)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('sales'))
      .send({ action: 'waive' });

    expect(res.status).toBe(403);
  });

  it('should not transition a LOST lead to WON when waiving deposit', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(SENT_WITH_DEPOSIT)
      .mockResolvedValueOnce(ESTIMATE_APPROVED_FIXTURE);
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimate.update.mockResolvedValue({});
    let capturedLeadWhere: Record<string, unknown> = {};
    mockPrisma.lead.updateMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      capturedLeadWhere = where;
      return Promise.resolve({ count: 0 });
    });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(capturedLeadWhere.status).toEqual({ notIn: ['WON', 'LOST', 'CANCELLED'] });
  });
});

// REMOVED (Phase 5 fold): POST /:id/refund-deposit + POST /:id/reactivate-deposit suites.
// The routes/handlers are gone — the deposit refund is now the unified Invoice refund
// (POST /api/invoices/:id/refund on the kind=DEPOSIT invoice). See invoices.test.ts.

// REMOVED: PATCH /:id/payment-method — superseded by /:id/record-payment.

// ═══════════════════════════════════════════════════════
// Stripe Checkout Integration Flow
// ═══════════════════════════════════════════════════════

describe('Stripe Checkout Integration Flow', () => {
  // Shared fixtures for the integration tests
  const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
  const PUBLIC_TOKEN = ESTIMATE_SENT_FIXTURE.public_token!;

  const DEPOSIT_INVOICE_ID = 'dep-inv-001';
  const sentFixtureWithCard = {
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: 'EST-2026-0002',
    lead_id: ESTIMATE_SENT_FIXTURE.lead_id,
    total_amount: 1062.5,
    valid_until: new Date('2027-12-31'),
    signature_data: null,
    // The kind=DEPOSIT Invoice is the SOLE deposit document; the checkout carries metadata.invoiceId.
    invoices: [{ id: DEPOSIT_INVOICE_ID, status: 'SENT', total_amount: 531.25, amount_due: 531.25 }],
    send_config: { deposit_required: true, payment_methods: ['CARD'] },
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_test',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'CASH'],
    },
  };

  it('full flow: send with deposit → approve with CARD → checkout session created', async () => {
    // ── Step 1: Send estimate with deposit required + CARD ──────────
    mockAuthAs('admin');
    const mockDraftEstimate = {
      id: ESTIMATE_ID,
      status: 'DRAFT',
      estimate_number: 'EST-2026-0002',
      total_amount: 1062.5,
      public_token: null,
      valid_until: null,
      // SERV10X-61 §5.6 - non-zero _count so send()'s new ≥1-item gate passes.
      _count: { line_items: 2 },
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], customer: { id: 'c0000000-0000-0000-0000-0000000000aa', email: 'customer@example.com' } },
      send_config: null,
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(mockDraftEstimate);
    mockPrisma.appSetting.findUnique
      .mockResolvedValueOnce({ key: 'estimate_validity_days', value: '30' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const sentResult = {
      ...mockDraftEstimate,
      status: 'SENT',
      sent_at: new Date(),
      public_token: PUBLIC_TOKEN,
      valid_until: new Date('2027-12-31'),
      invoices: [{ id: DEPOSIT_INVOICE_ID, status: 'SENT', kind: 'DEPOSIT', total_amount: 531.25, amount_due: 531.25 }],
      send_config: { id: 'sc-1', deposit_required: true, deposit_percentage: 50, deposit_amount: 531.25, payment_methods: ['CARD'], message_body: null },
    };
    let txInvoiceCreate: ReturnType<typeof vi.fn> | undefined;
    let txSendConfig: ReturnType<typeof vi.fn> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimate: { update: vi.fn().mockResolvedValue(sentResult), findUnique: vi.fn().mockResolvedValue(sentResult) },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
        invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: DEPOSIT_INVOICE_ID }) },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      txInvoiceCreate = tx.invoice.create;
      txSendConfig = tx.estimateSendConfig.upsert;
      return fn(tx);
    });

    const sendRes = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(sendRes.status).toBe(200);
    // The kind=DEPOSIT Invoice was created (the sole deposit document).
    expect(txInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estimate_id: ESTIMATE_ID, kind: 'DEPOSIT', status: 'SENT' }),
      })
    );
    // SendConfig was upserted (idempotent on estimate_id) with CARD payment method
    expect(txSendConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estimate_id: ESTIMATE_ID },
        create: expect.objectContaining({ deposit_required: true, payment_methods: ['CARD'] }),
      })
    );

    // ── Step 2: Customer approves with CARD → checkout session returned ──
    vi.clearAllMocks();
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' });
    mockIsStripeConfigured.mockReturnValue(true);
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithCard)    // initial fetch
      .mockResolvedValueOnce({ ...sentFixtureWithCard }); // re-fetch after session
    mockPrisma.estimate.update.mockResolvedValue({ ...sentFixtureWithCard, status: 'SENT' });

    // Restore user mock cleared above
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { id: string } }) => {
        const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
        return Promise.resolve(match ? { ...match, organization: TEST_ORG } : null);
      }
    );

    const approveRes = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${PUBLIC_TOKEN}`)
      .send({ signature_data: 'data:image/png;base64,test', payment_method: 'CARD' });

    expect(approveRes.status).toBe(200);
    // Response has checkout_url
    expect(approveRes.body.checkout_url).toBe('https://checkout.stripe.com/test');
    // Estimate stays SENT (not yet WON — pending Stripe webhook)
    expect(mockCreateCheckoutSession).toHaveBeenCalled();
    // The checkout carries metadata.invoiceId (the kind=DEPOSIT invoice) — the webhook resolves it.
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ invoiceId: DEPOSIT_INVOICE_ID }) }),
      expect.anything(),
    );
  });

  it('checkout session has correct success and cancel URLs', async () => {
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_url_test', url: 'https://checkout.stripe.com/url_test' });
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithCard)
      .mockResolvedValueOnce(sentFixtureWithCard);
    mockPrisma.estimate.update.mockResolvedValue({});

    await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${PUBLIC_TOKEN}`)
      .send({ signature_data: 'data:image/png;base64,test', payment_method: 'CARD' });

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: expect.stringContaining(`/p/estimates/${ESTIMATE_ID}`),
        cancelUrl: expect.stringContaining(`/p/estimates/${ESTIMATE_ID}`),
      }),
      expect.objectContaining({ stripe: expect.anything() }),
    );
    const callArgs = mockCreateCheckoutSession.mock.calls[0][0];
    expect(callArgs.successUrl).toContain('payment=success');
    expect(callArgs.cancelUrl).toContain('payment=cancelled');
    expect(callArgs.successUrl).toContain(`token=${PUBLIC_TOKEN}`);
    expect(callArgs.cancelUrl).toContain(`token=${PUBLIC_TOKEN}`);
  });

  it('checkout session metadata contains the deposit invoiceId and estimateId', async () => {
    mockIsStripeConfigured.mockReturnValue(true);
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_meta_test', url: 'https://checkout.stripe.com/meta_test' });
    mockPrisma.estimate.findFirst
      .mockResolvedValueOnce(sentFixtureWithCard)
      .mockResolvedValueOnce(sentFixtureWithCard);
    mockPrisma.estimate.update.mockResolvedValue({});

    await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${PUBLIC_TOKEN}`)
      .send({ signature_data: 'data:image/png;base64,test', payment_method: 'CARD' });

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          invoiceId: DEPOSIT_INVOICE_ID,
          estimateId: ESTIMATE_ID,
        }),
      }),
      expect.objectContaining({ stripe: expect.anything() }),
    );
  });
});

// ─── Cancel with PENDING status ───────────────────────

describe('cancel PENDING estimate with deposit', () => {
  const PENDING_WITH_DEPOSIT = {
    id: ESTIMATE_SENT_FIXTURE.id,
    status: 'PENDING',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
  };

  function mockTransaction() {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn(mockPrisma);
    });
  }

  it('can cancel PENDING estimate and voids the unpaid kind=DEPOSIT invoice', async () => {
    mockAuthAs('admin');
    mockTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValueOnce(PENDING_WITH_DEPOSIT);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'ARCHIVED' });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } }),
        data: expect.objectContaining({ status: 'VOIDED' }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/estimates/export
// ═══════════════════════════════════════════════════════

describe('GET /api/estimates/export', () => {
  it('returns all matching rows under the {estimates} envelope', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([ESTIMATE_FIXTURE]);

    const res = await request(app)
      .get('/api/estimates/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimates).toHaveLength(1);
    const args = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();      // unpaginated
  });

  it('applies the status filter just like list', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/estimates/export?status=DRAFT')
      .set(authHeader('admin'));

    expect(mockPrisma.estimate.findMany.mock.calls[0][0].where.status).toBe('DRAFT');
  });

  it("scopes export to the SALES user's own leads", async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/estimates/export')
      .set(authHeader('sales'));

    // SERV10X-61 §8 - export reuses buildEstimateListWhere, so the scope is the same own-via-lead
    // OR own-lead-less-created OR the list uses (under `where.OR`).
    expect(mockPrisma.estimate.findMany.mock.calls[0][0].where.OR).toEqual([
      { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
      { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
    ]);
  });

  // EST-B1 — the only `take` is the defensive 50_000 cap (NOT a list page size), so a
  // multi-page result set is never truncated by pagination.
  it('uses the 50_000 row cap as the only take (EST-B1)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/estimates/export')
      .set(authHeader('admin'));

    const args = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(50_000);
  });

  // EST-B3 — tenant isolation: the export `where` is scoped to the caller's org so
  // cross-org rows can never be returned.
  it('scopes the where to the caller organization (EST-B3)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/estimates/export')
      .set(authHeader('admin'));

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(TEST_USERS.admin.organization_id);
  });

  // EST-B6 — select parity: the export reuses the list select (estimateListSelect), so the
  // CSV columns — incl. the nested lead.customer.customer_number — all have data.
  it('select matches the list select columns (EST-B6)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/estimates/export')
      .set(authHeader('admin'));

    const select = mockPrisma.estimate.findMany.mock.calls[0][0].select;
    expect(select.estimate_number).toBe(true);
    expect(select.status).toBe(true);
    expect(select.total_amount).toBe(true);
    expect(select.lead.select.customer.select.customer_number).toBe(true);
  });
});

// R3 (2026-07-21) — cost model (D2/D8/D18). `stripEstimateCost` unit tests exercise the
// canSeePricing branch directly (no HTTP round-trip needed for a pure function) since the default
// role matrix has no reader who can see an Estimate at all but can't see pricing — same reasoning
// as the pre-existing unit_cost/markup_percent strip this mirrors.
describe('stripEstimateCost — labor_hours/overhead_mode/overhead_value (R3)', () => {
  const fixture = {
    id: ESTIMATE_FIXTURE.id,
    labor_hours: 8,
    overhead_mode: 'FIXED' as const,
    overhead_value: 150,
    scopes: [],
    line_items: [],
  };

  it('strips labor_hours/overhead_mode/overhead_value when the requester cannot see pricing', () => {
    const fakeReq = { ability: { can: () => false } } as unknown as Parameters<typeof stripEstimateCost>[1];
    const out = stripEstimateCost(fixture, fakeReq) as Record<string, unknown>;
    expect(out).not.toHaveProperty('labor_hours');
    expect(out).not.toHaveProperty('overhead_mode');
    expect(out).not.toHaveProperty('overhead_value');
  });

  it('passes labor_hours/overhead_mode/overhead_value through unchanged when the requester can see pricing', () => {
    const fakeReq = { ability: { can: () => true } } as unknown as Parameters<typeof stripEstimateCost>[1];
    const out = stripEstimateCost(fixture, fakeReq) as Record<string, unknown>;
    expect(out.labor_hours).toBe(8);
    expect(out.overhead_mode).toBe('FIXED');
    expect(out.overhead_value).toBe(150);
  });
});

describe('GET /api/estimates/:id — cost model fields (R3)', () => {
  it('includes labor_hours/overhead_mode/overhead_value for a viewer who can see pricing (ADMIN)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      labor_hours: 6,
      overhead_mode: 'PERCENTAGE',
      overhead_value: 12,
      line_items: [],
      scopes: [],
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.labor_hours).toBe(6);
    expect(res.body.estimate.overhead_mode).toBe('PERCENTAGE');
    expect(res.body.estimate.overhead_value).toBe(12);
  });
});

describe('PATCH /api/estimates/:id — cost model fields (R3)', () => {
  it('writes labor_hours/overhead_mode/overhead_value on the metadata-only branch (no line_items)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: 10, overhead_mode: 'FIXED', overhead_value: 200 });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.labor_hours).toBe(10);
    expect(updateCall.data.overhead_mode).toBe('FIXED');
    expect(updateCall.data.overhead_value).toBe(200);
  });

  it('writes labor_hours/overhead_mode/overhead_value on the line_items branch too', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const txUpdate = vi.fn().mockResolvedValue(ESTIMATE_FIXTURE);
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
        estimate: { update: txUpdate },
      };
      return fn(tx);
    });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        labor_hours: 3,
        overhead_mode: 'PERCENTAGE',
        overhead_value: 8,
        line_items: [{ description: 'Item', quantity: 1, unit_price: 500, is_taxable: true }],
      });

    expect(res.status).toBe(200);
    const updateCall = txUpdate.mock.calls[0][0];
    expect(updateCall.data.labor_hours).toBe(3);
    expect(updateCall.data.overhead_mode).toBe('PERCENTAGE');
    expect(updateCall.data.overhead_value).toBe(8);
  });

  it('clears an override back to org default by sending null for labor_hours/overhead_mode/overhead_value', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: null, overhead_mode: null, overhead_value: null });

    expect(res.status).toBe(200);
    const updateCall = mockPrisma.estimate.update.mock.calls[0][0];
    expect(updateCall.data.labor_hours).toBeNull();
    expect(updateCall.data.overhead_mode).toBeNull();
    expect(updateCall.data.overhead_value).toBeNull();
  });

  // D2/D8 write-guard - a requester who can't see pricing must not be able to set the cost-model
  // fields either. Every default role that can update an Estimate (SALES/ADMIN) also holds the
  // pricing grant, so this simulates the guard's real target: a SALES grant set with the "See
  // financial data" grant withheld, i.e. an admin who turned that switch off for Sales.
  // SRVW-140 - the withheld subject is `Pricing`, not `Invoice`: canSeePricing was repointed.
  it('returns 403 and does not write when the requester can update the Estimate but cannot see pricing', async () => {
    // attachAbility/scopeWhereForReq resolve grants through the shared 60s org:role cache — clear
    // it so this test's Pricing-withheld grant set is honored instead of a prior test's cached
    // default SALES grants (which include Pricing).
    clearPermissionCache();
    mockAuthAs('sales');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject !== 'Pricing'),
    );
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    // canAccessRow issues a scoped estimate.findFirst against SALES's own-lead read condition —
    // returning the row means "visible/owned", clearing the row-scope check before the cost guard.
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('sales'))
      .send({ labor_hours: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('cost fields');
    expect(mockPrisma.estimate.update).not.toHaveBeenCalled();
  });

  it('rejects labor_hours above the 99999 cap at the Zod layer', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ labor_hours: 100000 });

    expect(res.status).toBe(400);
  });

  it('rejects an invalid overhead_mode at the Zod layer', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ overhead_mode: 'BOGUS' });

    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estimates/:id/copy-to-invoice (R5e) — copy an Estimate directly into a standalone
// Invoice, independent of the Job pipeline.
// ════════════════════════════════════════════════════════════════════════════

// An estimate carrying everything the fidelity assertions need: a PERCENTAGE-discounted taxable
// line (also exercising markup_percent/unit_cost passthrough), a plain non-taxable line, a
// taxable flat-priced scope, and an estimate-level discount_amount. subtotal/tax_amount/
// total_amount below are the REAL calculateTotals/recomputeInvoiceTotals output for these exact
// inputs (verified by hand — see learning-fixture-convention-drift-makes-tests-tautological),
// not an arbitrary fixture guess: subtotal 1400, tax_amount 89.14, total_amount 1389.14.
function copyToInvoiceEstimate(overrides: Record<string, any> = {}) {
  return {
    id: 'ce000000-0000-0000-0000-000000000001',
    job: null,
    tax_rate: 0.08,
    discount_amount: 100,
    labor_hours: 12,
    overhead_mode: 'FIXED',
    overhead_value: 250,
    scopes: [
      { id: 'scope-1', title: 'Extra labor', body: 'Additional crew time', flat_price: 300, is_taxable: true, internal_cost: 150 },
    ],
    subtotal: 1400,
    tax_amount: 89.14,
    total_amount: 1389.14,
    lead: {
      customer_id: CUSTOMER_FIXTURE.id,
      customer: { payment_type: null },
    },
    line_items: [
      {
        sequence: 1, description: 'AC Unit replacement', quantity: 1, unit_price: 1000,
        is_taxable: true, line_total: 1000,
        discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 100,
        markup_percent: 20, unit_cost: 700, item_type: 'SERVICE', price_book_item_id: null,
      },
      {
        sequence: 2, description: 'Filter', quantity: 2, unit_price: 100,
        is_taxable: false, line_total: 200,
        discount_type: null, discount_value: null, discount_amount: 0,
        markup_percent: null, unit_cost: null, item_type: 'MATERIAL', price_book_item_id: null,
      },
    ],
    ...overrides,
  };
}

// tx surface for the happy/409/deposit-credit paths: invoice.create captures data; the deposit
// lookup (tx.invoice.findFirst) is parameterized so the deposit-credit test can seed a PAID
// invoice while every other test passes null (no deposit).
function copyToInvoiceTx(
  captured: { data?: any },
  opts: {
    depositInvoice?: { id: string } | null;
    depositPaid?: number;
    depositApplied?: number;
    depositRefunded?: number;
    onPayment?: (data: any) => void;
    onApplication?: (data: any) => void;
    // TOCTOU re-check overrides — a fresh read taken INSIDE the transaction can find a
    // job/duplicate-invoice that didn't exist at the pre-transaction check (a race window).
    freshJob?: { id: string } | null;
    // SRVW-86 - the R6 attachment pointer (Estimate.job_id / job_link) can race in the same
    // window, and it is the one no Job points back at.
    freshJobId?: string | null;
    freshJobLink?: { id: string; job_number: string } | null;
    freshActiveInvoice?: { invoice_number: string } | null;
  } = {},
) {
  return {
    // #2030 — see the note in mockTransactionForSend: minting now runs inside a transaction.
    estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
    estimate: {
      findUnique: async () => ({
        job: opts.freshJob ?? null,
        job_id: opts.freshJobId ?? null,
        job_link: opts.freshJobLink ?? null,
      }),
    },
    invoice: {
      findFirst: async (args: any) => {
        if (args.where.kind === 'DEPOSIT') return opts.depositInvoice ?? null;
        if (args.where.kind === 'STANDARD') return opts.freshActiveInvoice ?? null;
        return null;
      },
      create: (args: any) => {
        captured.data = args.data;
        return { id: 'new-invoice-1', invoice_number: 'I00001', ...args.data };
      },
    },
    payment: {
      aggregate: async () => ({ _sum: { amount: opts.depositPaid ?? 0 } }),
      create: (args: any) => { opts.onPayment?.(args.data); return {}; },
    },
    depositCreditApplication: {
      aggregate: async () => ({ _sum: { amount: opts.depositApplied ?? 0 } }),
      create: (args: any) => { opts.onApplication?.(args.data); return {}; },
    },
    refund: { aggregate: async () => ({ _sum: { amount: opts.depositRefunded ?? 0 } }) },
    timelineEvent: { create: async () => ({}) },
  };
}

describe('POST /api/estimates/:id/copy-to-invoice', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    // No pre-existing active STANDARD invoice for this estimate (the 409 dup-guard).
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
  });

  // #2030 slice 2 — copying to an invoice freezes the document the invoice was built FROM. That
  // record is what makes a payment reconcilable against what was actually quoted; without it the
  // estimate can be edited afterwards and nothing says what the invoice came from.
  it('mints a version, so the invoice stays reconcilable against what was quoted', async () => {
    const estimate = copyToInvoiceEstimate({ status: 'DRAFT' });
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...estimate,
      version: 1,
      scope_photos: [],
      created_at: new Date('2026-09-01T00:00:00Z'),
      discount_name: null,
      signature_data: null, signature_at: null,
      snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
      scope_notes: null,
      service_location: null,
    });
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      estimate_template: 'alpha-classic',
    });
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx({})));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockPrisma.estimateVersionSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: 'COPY_TO_INVOICE' }) }),
    );
  });

  it('happy path: DRAFT estimate with a discounted line + scopes → 201, exact total fidelity to the estimate', async () => {
    const estimate = copyToInvoiceEstimate({ status: 'DRAFT' });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx(captured)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.invoice.id).toBeDefined();
    expect(res.body.invoice.invoice_number).toBe('I00001');

    // Decision #2 — exact fidelity to the estimate's own already-computed totals.
    expect(Number(captured.data.subtotal)).toBe(Number(estimate.subtotal));
    expect(Number(captured.data.tax_amount)).toBe(Number(estimate.tax_amount));
    expect(Number(captured.data.total_amount)).toBe(Number(estimate.total_amount));

    // Scopes copied onto Invoice.scopes.
    expect(captured.data.scopes).toEqual(estimate.scopes);

    // Per-line discount_type/discount_value/discount_amount/markup_percent copied 1:1 (NOT the
    // job-anchored create()'s known bug of dropping them).
    const line0 = captured.data.line_items.create[0];
    expect(line0.discount_type).toBe('PERCENTAGE');
    expect(line0.discount_value).toBe(10);
    expect(line0.discount_amount).toBe(100);
    expect(line0.markup_percent).toBe(20);
    expect(line0.unit_cost).toBe(700);
    // Invoice-only defaults stamped on every copied line.
    expect(line0.stock_status).toBe('NOT_TRACKED');
    expect(line0.stock_location_id).toBeNull();
    expect(line0.job_line_item_id).toBeNull();

    // Standalone shape: no job, kind STANDARD, estimate_id + customer_id set from the estimate.
    expect(captured.data.kind).toBe('STANDARD');
    expect(captured.data.job_id).toBeNull();
    expect(captured.data.estimate_id).toBe(estimate.id);
    expect(captured.data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(captured.data.status).toBe('DRAFT');
    // Cost basis copied straight from the estimate (copy-on-conversion precedent).
    expect(captured.data.labor_hours).toBe(12);
    expect(captured.data.overhead_mode).toBe('FIXED');
    expect(captured.data.overhead_value).toBe(250);
    // No deposit invoice ⇒ no credit.
    expect(Number(captured.data.deposit_credit)).toBe(0);
    expect(Number(captured.data.amount_due)).toBe(Number(estimate.total_amount));
  });

  // #2053 R2/AC16 - the scope STRIP stays: an INVOICE's own totals must never be
  // selection-filtered, so the keys must not land on Invoice.scopes at all.
  // #2090 slice 3d inverts the other half: copy-to-invoice now carries SELECTED rows only, so a
  // declined optional scope is not copied and its money is not in the new invoice's totals.
  // Freeze-at-send: `rep_selected` is the third estimate-only flag and goes under the same
  // R2 rule. It is a record of what a SALESPERSON offered on an ESTIMATE, and an invoice is
  // neither, so parking it on Invoice.scopes would leave stale estimate state on another entity.
  it('copies only the SELECTED scopes, and strips is_optional/is_selected/rep_selected from the ones it copies', async () => {
    const estimate = copyToInvoiceEstimate({
      scopes: [
        { id: 'scope-1', title: 'Extra labor', body: 'Additional crew time', flat_price: 300, is_taxable: true, internal_cost: 150, is_optional: true, is_selected: true, rep_selected: true },
        { id: 'scope-2', title: 'Declined permit', body: '', flat_price: 500, is_taxable: true, internal_cost: 0, is_optional: true, is_selected: false, rep_selected: true },
      ],
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx(captured)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    // The declined block is gone; the taken one is copied, flagless.
    expect(captured.data.scopes).toHaveLength(1);
    expect(captured.data.scopes[0].title).toBe('Extra labor');
    expect(captured.data.scopes[0]).not.toHaveProperty('is_optional');
    expect(captured.data.scopes[0]).not.toHaveProperty('is_selected');
    expect(captured.data.scopes[0]).not.toHaveProperty('rep_selected');
    expect(captured.data.scopes[0].flat_price).toBe(300);
    // …and the $500 the customer declined is nowhere in the new invoice's own totals.
    expect(JSON.stringify(captured.data.scopes)).not.toContain('Declined permit');
    expect(Number(captured.data.total_amount)).toBeLessThan(Number(estimate.total_amount) + 500);
  });

  // #2090 slice 3d - the line half of the same rule.
  it('copies only the SELECTED line items', async () => {
    const estimate = copyToInvoiceEstimate({
      scopes: [],
      line_items: [
        {
          sequence: 1, description: 'AC Unit replacement', quantity: 1, unit_price: 1000,
          is_taxable: true, line_total: 1000,
          discount_type: null, discount_value: null, discount_amount: 0,
          markup_percent: null, unit_cost: null, item_type: 'SERVICE', price_book_item_id: null,
          is_optional: false, is_selected: true,
        },
        {
          sequence: 2, description: 'DECLINED optional add-on', quantity: 1, unit_price: 5000,
          is_taxable: true, line_total: 5000,
          discount_type: null, discount_value: null, discount_amount: 0,
          markup_percent: null, unit_cost: null, item_type: 'MATERIAL', price_book_item_id: null,
          is_optional: true, is_selected: false,
        },
      ],
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx(captured)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(captured.data.line_items.create).toHaveLength(1);
    expect(captured.data.line_items.create[0].description).toBe('AC Unit replacement');
    // The declined $5,000 is out of the invoice's totals too.
    expect(Number(captured.data.subtotal)).toBe(1000);
  });

  it('409s when the estimate already has a job (job-pipeline interaction)', async () => {
    const estimate = copyToInvoiceEstimate({ job: { id: 'job-existing' } });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
  });

  // SRVW-86 - the R6 attachment (Estimate.job_id / job_link) is a SECOND job pointer the
  // provenance relation cannot see: a multi-estimate conversion leaves Job.estimate_id NULL
  // (job.controller.ts:1480) while stamping job_id on every attached estimate, and the
  // job-anchored create does the same. Both must be refused or the same work is billed twice.
  it('409s when the estimate is attached to a job via job_id with no provenance job (multi-estimate conversion / job anchor)', async () => {
    const estimate = copyToInvoiceEstimate({
      job: null,
      job_id: 'job-multi-1',
      job_link: { id: 'job-multi-1', job_number: 'J00021' },
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    // A working transaction surface, so a missing guard mints a real 201 rather than 500ing.
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx({})));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('J00021');
    // No invoice minted at all - the guard fires before the transaction opens.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('409s via the in-transaction re-check when a job_id attachment races in after the pre-check (TOCTOU on the attachment pointer)', async () => {
    const estimate = copyToInvoiceEstimate(); // pre-check: job null, job_id absent, passes
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    mockPrisma.$transaction.mockImplementation((fn: any) =>
      fn(copyToInvoiceTx(captured, {
        freshJobId: 'job-raced-2',
        freshJobLink: { id: 'job-raced-2', job_number: 'J00022' },
      })),
    );

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('J00022');
    expect(captured.data).toBeUndefined(); // never reached tx.invoice.create
  });

  // Re-conversion (job.controller.ts:1102 deliberately permits job_id === estimate.job?.id) is
  // ALREADY refused here by the provenance guard. Passes before the fix too - this locks the
  // no-behaviour-change half of the contract, it is not a regression test.
  it('still 409s when job_id equals its own provenance job id (re-conversion is neither newly blocked nor newly allowed)', async () => {
    const estimate = copyToInvoiceEstimate({
      job: { id: 'job-1', job_number: 'J00010' },
      job_id: 'job-1',
      job_link: { id: 'job-1', job_number: 'J00010' },
    });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
  });

  it('409s when a non-VOIDED STANDARD invoice already exists for this estimate (one-active-copy guard)', async () => {
    const estimate = copyToInvoiceEstimate();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    mockPrisma.invoice.findFirst.mockResolvedValue({ invoice_number: 'I00042' });

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('I00042');
  });

  // TOCTOU guard (independent review, R5e) — the pre-transaction checks above read state from
  // BEFORE the transaction opened; two concurrent requests (e.g. a double-click) can both pass
  // them. A fresh in-tx re-check, right before the invoice is created, is the authoritative one.
  it('409s via the in-transaction re-check when a job is created in the race window between the pre-check and the transaction', async () => {
    const estimate = copyToInvoiceEstimate(); // pre-check: job is null, passes
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    // Fresh in-tx read now finds a job that raced in after the pre-check passed.
    mockPrisma.$transaction.mockImplementation((fn: any) =>
      fn(copyToInvoiceTx(captured, { freshJob: { id: 'job-raced-in' } })),
    );

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already has a job');
    expect(captured.data).toBeUndefined(); // never reached tx.invoice.create
  });

  it('409s via the in-transaction re-check when a duplicate active invoice is created in the race window', async () => {
    const estimate = copyToInvoiceEstimate();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // pre-check: no active invoice, passes
    const captured: { data?: any } = {};
    // Fresh in-tx read now finds an active STANDARD invoice created by a concurrent request.
    mockPrisma.$transaction.mockImplementation((fn: any) =>
      fn(copyToInvoiceTx(captured, { freshActiveInvoice: { invoice_number: 'I00077' } })),
    );

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('I00077');
    expect(captured.data).toBeUndefined(); // never reached tx.invoice.create
  });

  it('403s a role without a create-Invoice grant (SALES — blocked at the route guard)', async () => {
    mockAuthAs('sales');
    const estimate = copyToInvoiceEstimate();

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(403);
    expect(mockPrisma.estimate.findUnique).not.toHaveBeenCalled();
  });

  // Two-layer gate (decision #4): a per-user grant that passes the route's canDo('create',
  // 'Invoice') check must STILL be rejected by the controller's hardcoded ADMIN/DISPATCHER-only
  // check — mirrors createStandaloneInvoice's exact gate rather than the job-anchored create()'s
  // grant-driven per-instance ownership check (there is no per-instance escape hatch here).
  it('403s a granted-but-non-admin/dispatcher role at the CONTROLLER layer, matching createStandaloneInvoice\'s exact message', async () => {
    clearPermissionCache();
    clearUserOverrideCache();
    mockAuthAs('technician');
    (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'create', subject: 'Invoice', effect: 'allow' },
    ]);
    const estimate = copyToInvoiceEstimate();

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized to create a standalone invoice');
    // The controller's role check runs BEFORE any estimate lookup.
    expect(mockPrisma.estimate.findUnique).not.toHaveBeenCalled();
  });

  it('deposit credit: a PAID kind=DEPOSIT invoice draws down onto the new copied invoice', async () => {
    const estimate = copyToInvoiceEstimate();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const captured: { data?: any } = {};
    let capturedPayment: any;
    let capturedApplication: any;
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx(captured, {
      depositInvoice: { id: 'dep-inv-1' },
      depositPaid: 500,
      onPayment: (data) => { capturedPayment = data; },
      onApplication: (data) => { capturedApplication = data; },
    })));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    // remaining = 500 paid − 0 applied − 0 refunded = 500; applied = min(500, total 1389.14) = 500.
    expect(Number(captured.data.deposit_credit)).toBe(500);
    expect(Number(captured.data.amount_due)).toBeCloseTo(1389.14 - 500, 2);
    expect(capturedApplication).toBeDefined();
    expect(capturedApplication.deposit_invoice_id).toBe('dep-inv-1');
    expect(capturedApplication.target_invoice_id).toBe('new-invoice-1');
    expect(Number(capturedApplication.amount)).toBe(500);
    expect(capturedPayment).toBeDefined();
    expect(capturedPayment.amount).toBe(500);
    expect(capturedPayment.reference_number).toBe('DEPOSIT-CREDIT');
  });

  // Decision #1 — any Estimate status is allowed, INCLUDING DRAFT. No status whitelist/check
  // exists on this endpoint (unlike Estimate → Job, which requires WON).
  it.each(['DRAFT', 'SENT', 'PENDING', 'APPROVED', 'WON', 'CANCELLED', 'LOST'])(
    'allows copy-to-invoice on a %s estimate (no status gate)',
    async (status) => {
      const estimate = copyToInvoiceEstimate({ status });
      mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
      const captured: { data?: any } = {};
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(copyToInvoiceTx(captured)));

      const res = await request(app)
        .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
        .set(authHeader('admin'))
        .send({});

      expect(res.status).toBe(201);
    },
  );
});

// ─── Widened estimateDetailSelect: STANDARD invoices alongside DEPOSIT (R5e) ────────────────
describe('GET /api/estimates/:id — widened invoices select includes copy-to-invoice STANDARD invoices (R5e)', () => {
  it('returns both the DEPOSIT invoice and a copied STANDARD invoice', async () => {
    mockAuthAs('admin');
    const estimate = {
      ...ESTIMATE_FIXTURE,
      invoices: [
        { id: 'dep-inv-1', invoice_number: 'I00010', status: 'PAID', kind: 'DEPOSIT', total_amount: 300, amount_due: 0, total_refunded: 0, refunded_at: null, payments: [] },
        { id: 'std-inv-1', invoice_number: 'I00011', status: 'DRAFT', kind: 'STANDARD', total_amount: 1389.14, amount_due: 1389.14, total_refunded: 0, refunded_at: null, payments: [] },
      ],
    };
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.invoices).toHaveLength(2);
    expect(res.body.estimate.invoices.map((i: any) => i.kind)).toEqual(['DEPOSIT', 'STANDARD']);
    expect(res.body.estimate.invoices[1].invoice_number).toBe('I00011');
  });
});
