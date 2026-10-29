/**
 * Logistic Orders — HTTP controller + routes (LO-2, plan §2.1).
 *
 * Route-level suite (supertest through the real app): pins the CRUD/lifecycle state machine,
 * anchored numbering at creation, the org-scoped anchor guard (E18), the cancelled-job transition
 * guard (L3/E12), the fast-forward capability path + notification suppression (E20), the
 * SALES-submit/approve permission split + capability flip (E19), scopeWhereFor on the list, and
 * cancel-from-PROCESSED rejection. The deduction ENGINE contract is pinned separately in
 * logistic-orders-processing.test.ts — here we assert HTTP shape and the controller-only guards.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  TEST_USERS,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
  matchesScopeWhere,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { clearTokenCache } from '../middleware/authenticate';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Numbering: keep pickAnchor / ANCHORS / ANCHOR_PRECEDENCE REAL (precedence logic is under test),
// spy only the two allocators so we can assert WHICH one the controller reached, and with what.
vi.mock('../lib/numbering', async (orig) => {
  const actual = await orig<typeof import('../lib/numbering')>();
  return {
    ...actual,
    allocateNumber: vi.fn().mockResolvedValue('LO00001'),
    allocateAnchoredNumber: vi.fn().mockResolvedValue({ number: 'LO-J00001-1', seq: 1 }),
  };
});
import { allocateNumber, allocateAnchoredNumber } from '../lib/numbering';

// scopeWhereForReq is the row-scope the list must spread; spy it to prove the list applies it.
vi.mock('../lib/permissions/enforce', async (orig) => {
  const actual = await orig<typeof import('../lib/permissions/enforce')>();
  return { ...actual, scopeWhereForReq: vi.fn() };
});
import { scopeWhereForReq } from '../lib/permissions/enforce';

// emit — assert the submit/approve notifications fire and the /process path suppresses them (E20).
vi.mock('../services/notifications/notificationService', async (orig) => {
  const actual = await orig<typeof import('../services/notifications/notificationService')>();
  return { ...actual, emit: vi.fn().mockResolvedValue(undefined) };
});
import { emit } from '../services/notifications/notificationService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000001';
const LINE_1 = 'bbbbbbb2-0000-0000-0000-000000000001';
// A valid-hex job id for the anchor body/query. The shared JOB_ID ('j0000000-…') has a
// non-hex leading char, which z.string().uuid() correctly rejects — irrelevant to the LO logic.
const JOB_ID = 'ba000000-0000-0000-0000-000000000001';
const LOC = INVENTORY_LOCATION_FIXTURE.id;
const ITEM = TRACKED_ITEM_FIXTURE.id;

const ITEM_ROW = {
  id: ITEM,
  sku: TRACKED_ITEM_FIXTURE.sku,
  name: TRACKED_ITEM_FIXTURE.name,
  track_inventory: true,
  unit_cost: 20,
};

function loLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_1,
    item_id: ITEM,
    item_sku: TRACKED_ITEM_FIXTURE.sku,
    item_name: TRACKED_ITEM_FIXTURE.name,
    qty: 3,
    from_location_id: LOC,
    sequence: 0,
    from_location: { id: LOC, name: 'Main Warehouse' },
    ...over,
  };
}

// A row wide enough to satisfy BOTH the controller detail include AND the engine's leaner select.
function loRow(over: Record<string, unknown> = {}) {
  return {
    id: LO_ID,
    number: 'LO-J00001-1',
    seq: 1,
    status: 'APPROVED',
    job_id: JOB_ID,
    invoice_id: null,
    estimate_id: null,
    lead_id: null,
    customer_id: null,
    service_plan_id: null,
    notes: null,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    processed_at: null,
    processed_by: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_by: TEST_USERS.admin.id,
    created_at: new Date('2026-07-20'),
    updated_at: new Date('2026-07-20'),
    organization_id: ALPHA_ORG_ID,
    job: { id: JOB_ID, job_number: 'J00001', status: 'SCHEDULED' },
    invoice: null,
    estimate: null,
    lead: null,
    customer: null,
    service_plan: null,
    creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    submitter: null,
    approver: null,
    processor: null,
    lines: [loLine()],
    ...over,
  };
}

function loListRow(over: Record<string, unknown> = {}) {
  return {
    id: LO_ID,
    number: 'LO-J00001-1',
    seq: 1,
    status: 'DRAFT',
    job_id: JOB_ID,
    invoice_id: null,
    estimate_id: null,
    lead_id: null,
    customer_id: null,
    service_plan_id: null,
    processed_at: null,
    created_at: new Date('2026-07-20'),
    job: { id: JOB_ID, job_number: 'J00001' },
    invoice: null,
    estimate: null,
    lead: null,
    customer: null,
    service_plan: null,
    creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    _count: { lines: 2 },
    ...over,
  };
}

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        logisticOrder: {
          create: mockPrisma.logisticOrder.create,
          update: mockPrisma.logisticOrder.update,
          updateMany: mockPrisma.logisticOrder.updateMany,
          delete: mockPrisma.logisticOrder.delete,
          findFirst: mockPrisma.logisticOrder.findFirst,
        },
        logisticOrderLine: {
          create: mockPrisma.logisticOrderLine.create,
          createMany: mockPrisma.logisticOrderLine.createMany,
          update: mockPrisma.logisticOrderLine.update,
          deleteMany: mockPrisma.logisticOrderLine.deleteMany,
          findMany: mockPrisma.logisticOrderLine.findMany,
        },
        priceBookItem: {
          findFirst: mockPrisma.priceBookItem.findFirst,
          findMany: mockPrisma.priceBookItem.findMany,
        },
        inventoryLocation: {
          findFirst: mockPrisma.inventoryLocation.findFirst,
          findMany: mockPrisma.inventoryLocation.findMany,
        },
        organization: { findUnique: mockPrisma.organization.findUnique },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: {
          findMany: mockPrisma.stockBalance.findMany,
          upsert: mockPrisma.stockBalance.upsert,
          updateMany: mockPrisma.stockBalance.updateMany,
          findUnique: mockPrisma.stockBalance.findUnique,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

const loEmits = () =>
  asMock(emit).mock.calls.filter((c: unknown[]) =>
    String((c[0] as { verb?: string })?.verb ?? '').startsWith('lo.'),
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  setupTransaction();
  mockAuthAs('admin');

  asMock(scopeWhereForReq).mockResolvedValue({});
  asMock(emit).mockResolvedValue(undefined);

  // Line validation + engine item/location resolution.
  mockPrisma.priceBookItem.findMany.mockResolvedValue([ITEM_ROW]);
  mockPrisma.inventoryLocation.findMany.mockResolvedValue([{ id: LOC, name: 'Main Warehouse' }]);

  // Anchor org-scope probes default to "found in org".
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
  mockPrisma.customer.findFirst.mockResolvedValue({ id: 'cust-1' });
  mockPrisma.estimate.findFirst.mockResolvedValue({ id: 'est-1' });
  mockPrisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
  mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: 'plan-1' });

  mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow());
  mockPrisma.logisticOrder.findMany.mockResolvedValue([loListRow()]);
  mockPrisma.logisticOrder.count.mockResolvedValue(1);
  mockPrisma.logisticOrder.create.mockResolvedValue(loRow({ status: 'DRAFT' }));
  mockPrisma.logisticOrder.update.mockResolvedValue(loRow());
  mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrder.delete.mockResolvedValue({ id: LO_ID });
  mockPrisma.logisticOrderLine.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.createMany.mockResolvedValue({ count: 1 });

  mockPrisma.organization.findUnique.mockResolvedValue({
    block_negative_stock: false,
    default_inventory_location_id: LOC,
  });
  mockPrisma.stockBalance.findMany.mockResolvedValue([]);
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entitlement axis, orthogonal to CASL: `inventory` is minPlan SCALE, so every org
// below SCALE (PRO included, not just STARTER) must be denied at the router even
// though its own ADMIN is a CASL superuser (`manage all`).
describe('entitlement gate - requireFeature(inventory)', () => {
  beforeEach(() => {
    // authenticate caches the resolved user per bearer token for 60s and fills that
    // cache BEFORE requireFeature runs, so without this the SCALE control below would
    // be served the STARTER user queued by an earlier case.
    clearTokenCache();
    mockAuthAs('realOrgAdmin');
  });

  it('402s FEATURE_NOT_IN_PLAN on GET / for an org admin whose plan lacks inventory', async () => {
    mockAuthAs('realOrgAdmin');
    // Override the SCALE-org test default with a STARTER org, for this one request.
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      ...TEST_USERS.realOrgAdmin,
      organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
    });

    const res = await request(app).get('/api/logistic-orders').set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(402);
    expect(res.status).not.toBe(403);
    expect(res.body).toMatchObject({
      error: 'FEATURE_NOT_IN_PLAN',
      feature: 'inventory',
      current_plan: 'STARTER',
      required_plan: 'SCALE',
    });
    expect(res.body.error).not.toBe('FEATURE_DISABLED');
    // The gate runs ahead of any DB work.
    expect(mockPrisma.logisticOrder.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.count).not.toHaveBeenCalled();
  });

  it('402s POST /:id/approve too, so the router-level gate covers the lifecycle verbs', async () => {
    mockAuthAs('realOrgAdmin');
    // PRO on purpose: inventory is minPlan SCALE, so PRO leaks as well as STARTER.
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      ...TEST_USERS.realOrgAdmin,
      organization: { is_demo: false, plan: 'PRO', trial_ends_at: null, feature_overrides: {} },
    });

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/approve`)
      .set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: 'FEATURE_NOT_IN_PLAN',
      feature: 'inventory',
      current_plan: 'PRO',
      required_plan: 'SCALE',
    });
    expect(mockPrisma.logisticOrder.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
  });

  it('200s the identical GET when the org DOES have inventory (sensitivity control)', async () => {
    // No org override: helpers.TEST_ORG resolves realOrgAdmin to a SCALE org with
    // every built feature, so this pins the ENTITLEMENT axis and not CASL.
    const res = await request(app).get('/api/logistic-orders').set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockPrisma.logisticOrder.findMany).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/logistic-orders — create + numbering', () => {
  it('creates a standalone DRAFT with a flat number (allocateNumber, no anchor)', async () => {
    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ notes: 'Stage parts', lines: [{ item_id: ITEM, qty: 3, from_location_id: LOC }] });

    expect(res.status).toBe(201);
    expect(asMock(allocateNumber)).toHaveBeenCalled();
    expect(asMock(allocateNumber).mock.calls[0][1]).toBe('logistic_order');
    expect(asMock(allocateAnchoredNumber)).not.toHaveBeenCalled();

    const data = mockPrisma.logisticOrder.create.mock.calls[0][0].data;
    expect(data.number).toBe('LO00001');
    expect(data.seq).toBeNull();
    expect(data.status).toBe('DRAFT');
    expect(data.created_by).toBe(TEST_USERS.admin.id);
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
    expect(data.lines.create[0]).toMatchObject({
      item_id: ITEM,
      item_sku: TRACKED_ITEM_FIXTURE.sku,
      item_name: TRACKED_ITEM_FIXTURE.name,
      qty: 3,
      from_location_id: LOC,
    });
  });

  it('mints an ANCHORED number when a job anchor is present (allocateAnchoredNumber)', async () => {
    mockPrisma.logisticOrder.create.mockResolvedValue(loRow({ status: 'DRAFT', number: 'LO-J00001-1' }));

    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID, lines: [{ item_id: ITEM, qty: 1, from_location_id: LOC }] });

    expect(res.status).toBe(201);
    expect(asMock(allocateNumber)).not.toHaveBeenCalled();
    expect(asMock(allocateAnchoredNumber)).toHaveBeenCalledTimes(1);
    expect(asMock(allocateAnchoredNumber).mock.calls[0][1]).toMatchObject({
      organizationId: ALPHA_ORG_ID,
      anchorTable: 'jobs',
      anchorColumn: 'job_id',
      anchorId: JOB_ID,
    });
    const data = mockPrisma.logisticOrder.create.mock.calls[0][0].data;
    expect(data.number).toBe('LO-J00001-1');
    expect(data.seq).toBe(1);
  });

  it('resolves anchors + lines on the global client BEFORE opening the transaction (pool-safe)', async () => {
    await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID, lines: [{ item_id: ITEM, qty: 1, from_location_id: LOC }] });

    // Every resolution must precede $transaction — a global-client query inside the tx would
    // take a SECOND pooled connection and P2024 on a connection-limited deployment (PR #859).
    const txOrder = mockPrisma.$transaction.mock.invocationCallOrder[0];
    expect(mockPrisma.job.findFirst.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.priceBookItem.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.inventoryLocation.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
  });

  it('picks the most-specific anchor for numbering when several are present (job > customer)', async () => {
    await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID, customer_id: 'ca000000-0000-0000-0000-000000000001', lines: [] });

    expect(asMock(allocateAnchoredNumber).mock.calls[0][1]).toMatchObject({
      anchorTable: 'jobs',
      anchorColumn: 'job_id',
    });
  });

  it('E18: a cross-org anchor id 404s and mints nothing', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(null); // not in caller org

    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID, lines: [] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ANCHOR_NOT_FOUND');
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
    expect(asMock(allocateAnchoredNumber)).not.toHaveBeenCalled();
    expect(asMock(allocateNumber)).not.toHaveBeenCalled();
  });

  it('E28: a NOT_BILLABLE plan-visit job may anchor an LO', async () => {
    // A plan-visit job carries source_plan_id; the anchor probe only checks org-membership,
    // so it must NOT be blocked (an LO is goods issue, not a billing line).
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.logisticOrder.create.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ job_id: JOB_ID, lines: [{ item_id: ITEM, qty: 2, from_location_id: LOC }] });

    expect(res.status).toBe(201);
    expect(mockPrisma.logisticOrder.create).toHaveBeenCalled();
  });

  it('422s a line whose item is not track_inventory (add-time rule)', async () => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([{ ...ITEM_ROW, track_inventory: false }]);

    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ lines: [{ item_id: ITEM, qty: 1, from_location_id: LOC }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('LO_LINE_INVALID');
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('422s a from_location outside the org', async () => {
    mockPrisma.inventoryLocation.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ lines: [{ item_id: ITEM, qty: 1, from_location_id: LOC }] });

    expect(res.status).toBe(422);
    expect(res.body.details[0].reason).toBe('UNKNOWN_LOCATION');
  });

  it('rejects qty <= 0 at the schema (400)', async () => {
    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('admin'))
      .send({ lines: [{ item_id: ITEM, qty: 0, from_location_id: LOC }] });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/logistic-orders — list + scope', () => {
  it('returns the list scoped to the org', async () => {
    const res = await request(app).get('/api/logistic-orders').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].number).toBe('LO-J00001-1');
    const where = mockPrisma.logisticOrder.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('spreads the scopeWhereFor fragment into the list where (row-scope applied)', async () => {
    asMock(scopeWhereForReq).mockResolvedValue({ id: { in: ['scoped-lo-id'] } });

    await request(app).get('/api/logistic-orders').set(authHeader('admin'));

    const where = mockPrisma.logisticOrder.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ organization_id: ALPHA_ORG_ID, id: { in: ['scoped-lo-id'] } });
  });

  it('applies status + job_id filters', async () => {
    await request(app)
      .get('/api/logistic-orders?status=PROCESSED&job_id=' + JOB_ID)
      .set(authHeader('admin'));

    const where = mockPrisma.logisticOrder.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('PROCESSED');
    expect(where.job_id).toBe(JOB_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/logistic-orders/:id', () => {
  it('returns the LO scoped to the org', async () => {
    const res = await request(app).get(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LO_ID);
    expect(mockPrisma.logisticOrder.findFirst.mock.calls[0][0].where).toMatchObject({
      id: LO_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('404s a cross-org / unknown id (findFirst is the tenancy gate)', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Lifecycle — submit', () => {
  it('DRAFT → PENDING_APPROVAL, and notifies approvers', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/submit`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: LO_ID, status: 'DRAFT', organization_id: ALPHA_ORG_ID });
    expect(claim.data.status).toBe('PENDING_APPROVAL');
    expect(claim.data.submitted_by).toBe(TEST_USERS.admin.id);
    expect(loEmits().map((c) => c[0].verb)).toContain('lo.submitted');
  });

  it('409 STALE_STATUS when the LO is not DRAFT', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'APPROVED' }));
    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/submit`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_STATUS');
  });

  it('404 when the LO does not exist in the org', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/submit`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Lifecycle — approve', () => {
  it('PENDING_APPROVAL → APPROVED, and notifies the creator', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PENDING_APPROVAL' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/approve`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.data.status).toBe('APPROVED');
    expect(claim.data.approved_by).toBe(TEST_USERS.admin.id);
    expect(loEmits().map((c) => c[0].verb)).toContain('lo.approved');
  });

  it('409 STALE_STATUS when not PENDING_APPROVAL', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));
    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/approve`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Lifecycle — process (delegates to the engine)', () => {
  it('APPROVED → PROCESSED (dispatcher, no fast-forward — only processed_* stamped)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'APPROVED' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/process`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.where.status).toEqual({ in: ['APPROVED'] });
    expect(claim.data.processed_at).toBeDefined();
    expect(claim.data.submitted_at).toBeUndefined();
    expect(loEmits()).toEqual([]);
  });

  it('dispatcher (no approve) processing a DRAFT is 409 STALE — no fast-forward', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/process`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_STATUS');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('E20: fast-forward Process from DRAFT stamps all six *_at/_by and emits NOTHING', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/process`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
    const data = mockPrisma.logisticOrder.updateMany.mock.calls[0][0].data;
    expect(data.submitted_at).toBeInstanceOf(Date);
    expect(data.approved_at).toBeInstanceOf(Date);
    expect(data.processed_at).toBeInstanceOf(Date);
    expect(data.submitted_by).toBe(TEST_USERS.admin.id);
    expect(data.approved_by).toBe(TEST_USERS.admin.id);
    expect(data.processed_by).toBe(TEST_USERS.admin.id);
    // The straight-through path must never notify the actor about their own click.
    expect(loEmits()).toEqual([]);
  });

  it('409 SHORTAGE (block mode) leaves nothing deducted', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'APPROVED' }));
    mockPrisma.organization.findUnique.mockResolvedValue({
      block_negative_stock: true,
      default_inventory_location_id: LOC,
    });
    mockPrisma.stockBalance.findMany.mockResolvedValue([{ item_id: ITEM, location_id: LOC, on_hand: 1 }]);

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/process`)
      .set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SHORTAGE');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Lifecycle — cancel', () => {
  it('APPROVED → CANCELLED with an optional reason', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'APPROVED' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Duplicate request' });

    expect(res.status).toBe(200);
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.data.status).toBe('CANCELLED');
    expect(claim.data.cancelled_reason).toBe('Duplicate request');
  });

  it('cancel-from-PROCESSED is rejected (409) — document verbs own that unwind', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PROCESSED' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/cancel`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_STATUS');
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Lifecycle — terminal states reject transitions', () => {
  for (const terminal of ['CANCELLED', 'RETURNED'] as const) {
    it(`${terminal} rejects submit / approve / process / cancel`, async () => {
      mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: terminal }));

      for (const verb of ['submit', 'approve', 'process', 'cancel']) {
        const res = await request(app)
          .post(`/api/logistic-orders/${LO_ID}/${verb}`)
          .set(authHeader('admin'))
          .send({});
        expect(res.status).toBe(409);
        expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('L3/E12 — no transition is legal on a CANCELLED job', () => {
  for (const verb of ['submit', 'approve', 'process', 'cancel']) {
    it(`${verb} is 409 JOB_CANCELLED when the anchored job is cancelled`, async () => {
      const status = verb === 'approve' ? 'PENDING_APPROVAL' : verb === 'process' ? 'APPROVED' : 'DRAFT';
      mockPrisma.logisticOrder.findFirst.mockResolvedValue(
        loRow({ status, job: { id: JOB_ID, job_number: 'J00001', status: 'CANCELLED' } }),
      );

      const res = await request(app)
        .post(`/api/logistic-orders/${LO_ID}/${verb}`)
        .set(authHeader('admin'))
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('JOB_CANCELLED');
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E19 — SALES permission split + capability flip', () => {
  it('SALES can submit its own draft (200)', async () => {
    mockAuthAs('sales');
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/submit`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('SALES is 403 on approve WITHOUT the capability (route guard)', async () => {
    mockAuthAs('sales');
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PENDING_APPROVAL' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/approve`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
  });

  it('an approve capability override flips SALES approve to 200', async () => {
    mockAuthAs('sales');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'approve', subject: 'LogisticOrder', effect: 'allow' },
    ]);
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PENDING_APPROVAL' }));

    const res = await request(app)
      .post(`/api/logistic-orders/${LO_ID}/approve`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrder.updateMany.mock.calls[0][0].data.status).toBe('APPROVED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/logistic-orders/:id', () => {
  it('updates notes on a DRAFT without touching lines', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ notes: 'Updated' });

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrder.update.mock.calls[0][0].data).toMatchObject({ notes: 'Updated' });
    expect(mockPrisma.logisticOrderLine.deleteMany).not.toHaveBeenCalled();
  });

  it('full-replaces lines on a DRAFT (delete all + create), no stock', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ item_id: ITEM, qty: 5, from_location_id: LOC }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('routes a PROCESSED line edit through the engine (auto-posts the stock delta)', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PROCESSED', lines: [loLine({ qty: 3 })] }));
    // The processed edit re-reads the lines INSIDE the tx (after the status CAS) and diffs against
    // THAT committed state. No concurrent change here, so it matches the pre-tx snapshot (qty 3).
    mockPrisma.logisticOrderLine.findMany.mockResolvedValue([loLine({ qty: 3 })]);

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ id: LINE_1, item_id: ITEM, qty: 5, from_location_id: LOC }] });

    expect(res.status).toBe(200);
    // qty 3 → 5 consumes a delta of 2.
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
    const mv = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(mv.type).toBe('consume');
    expect(mv.qty).toBe(2);
  });

  it('rejects a line edit on a terminal (CANCELLED) LO', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'CANCELLED' }));

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ item_id: ITEM, qty: 5, from_location_id: LOC }] });

    expect(res.status).toBe(409);
  });

  it('400s a PROCESSED edit that lists the same existing line id twice, before any stock write', async () => {
    // A duplicated existing line id would apply its qty delta twice (two stock movements) while
    // the row is written once — a silent ledger desync. The lines-id-uniqueness refine rejects it
    // at the schema, so the request 400s in the validate() middleware BEFORE the tx opens.
    // REVERT-CHECK TARGET: drop the .refine on updateLogisticOrderSchema and the dup reaches the
    // handler → the response is no longer a 400 'Validation failed' → RED.
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ status: 'PROCESSED', lines: [loLine({ qty: 3 })] }),
    );
    mockPrisma.logisticOrderLine.findMany.mockResolvedValue([loLine({ qty: 3 })]);

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({
        lines: [
          { id: LINE_1, item_id: ITEM, qty: 5, from_location_id: LOC },
          { id: LINE_1, item_id: ITEM, qty: 5, from_location_id: LOC },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('422s a PROCESSED edit that repoints an EXISTING line at a cross-org location, before any stock write', async () => {
    // The existing line lives at LOC; the edit moves it to a location in ANOTHER org. Only NEW lines
    // pass through validateAndSnapshotLines, so an EXISTING line's changed from_location_id must be
    // org-validated separately or applyProcessedLineDiff hands the cross-org id straight to
    // applyStockMovement (a cross-tenant stock write). canAccessRow is NOT a tenancy gate for LOs —
    // every incoming location id is org-scoped explicitly.
    const OTHER_ORG_LOC = 'aaaaaaa1-0000-0000-0000-0000000000ff';
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ status: 'PROCESSED', lines: [loLine({ qty: 3, from_location_id: LOC })] }),
    );
    // The org-scoped InventoryLocation lookup does not return the cross-org location.
    mockPrisma.inventoryLocation.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ id: LINE_1, item_id: ITEM, qty: 3, from_location_id: OTHER_ORG_LOC }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('LO_LINE_INVALID');
    expect(res.body.details[0].reason).toBe('UNKNOWN_LOCATION');
    // The load-bearing assertion — REVERT-CHECK TARGET: without the existing-line location guard the
    // cross-org id reaches applyStockMovement and both a return + a consume movement are written.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.upsert).not.toHaveBeenCalled();
  });

  // ─── Concurrency: the PROCESSED edit is a stock-moving verb and must serialize like the
  //     process / return verbs (in-tx status CAS + diff against committed state, NOT the pre-tx
  //     snapshot). Two interleavings, one per half of the guard. ───

  it('diffs a PROCESSED edit against the lines RE-READ inside the tx, not the stale pre-tx snapshot (edit/edit lost-update)', async () => {
    // Two Save-edits of the same PROCESSED line race. THIS request read qty 3 pre-tx; a concurrent
    // edit already committed qty 5 before this tx acquired the LO row. The delta MUST be computed
    // against the committed state re-read inside the tx (5), not the stale snapshot (3) — otherwise
    // the same +2 is consumed twice (silent double-deduction + line-vs-movement ledger desync).
    // REVERT-CHECK TARGET: drop the in-tx re-read and the diff runs off the qty-3 snapshot → a
    // spurious consume of qty 2 is posted → RED.
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ status: 'PROCESSED', lines: [loLine({ qty: 3 })] }),
    );
    // The committed row THIS tx must diff against — a concurrent edit already moved it to 5.
    mockPrisma.logisticOrderLine.findMany.mockResolvedValue([loLine({ qty: 5 })]);

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ id: LINE_1, item_id: ITEM, qty: 5, from_location_id: LOC }] });

    expect(res.status).toBe(200);
    // 5 (committed) → 5 (incoming) = no delta = no movement. Off the stale snapshot it would be +2.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('409s a PROCESSED edit whose LO a racing unwind already flipped to RETURNED, moving nothing (in-tx status CAS)', async () => {
    // The pre-tx read saw PROCESSED; before this tx claimed the row, a job-cancel / invoice-void /
    // delete unwind flipped it to RETURNED and credited the stock. Without an in-tx CAS this edit
    // still posts consume/return movements against an already-unwound document — re-moving stock.
    // The CAS updateMany filtered on status:PROCESSED is the whole serialization story: 0 matched
    // rows ⇒ 409, nothing written. REVERT-CHECK TARGET: remove the CAS and the edit proceeds → the
    // count:0 stub is ignored, so it returns 200 and posts a stock movement → RED.
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ status: 'PROCESSED', lines: [loLine({ qty: 3 })] }),
    );
    mockPrisma.logisticOrderLine.findMany.mockResolvedValue([loLine({ qty: 3 })]);
    // The racing unwind already left the row RETURNED — the CAS matches 0 PROCESSED rows.
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send({ lines: [{ id: LINE_1, item_id: ITEM, qty: 5, from_location_id: LOC }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_STATUS');
    expect(res.body.expected_status).toContain('PROCESSED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/logistic-orders/:id', () => {
  it('deletes a DRAFT with no unwind', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrder.delete).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('E13: a PROCESSED LO returns its stock BEFORE the row is deleted, one tx', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'PROCESSED' }));
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 }); // returnProcessedLo CAS

    const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.type).toBe('return');
    expect(mockPrisma.logisticOrder.delete).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.logisticOrder.delete.mock.invocationCallOrder[0],
    );
  });

  it('404s a cross-org / unknown id', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(null);
    const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #2042 SLICE 1 — enforcement of a conditioned purchasing grant on LogisticOrder create + the
// existing-row verbs. DEFAULT_GRANTS carries no CONDITIONED row for any of these actions yet
// (SALES's create/submit stay unconditional, read stays unconditional, update/delete are absent
// entirely — that is slice 2's migration), so every case here hand-injects a job-scoped grant on
// top of SALES's normal defaults, REPLACING the default row for the action under test rather than
// adding beside it (an unconditional default row left in place would make `scopeWhereFor` widen
// to `{}` regardless of the injected one — `readGrants.some(g => !g.conditions)`).
// ═══════════════════════════════════════════════════════════════════════════════════════════

const OWN_VIA_JOB_CONDITION = {
  job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
};

/** SALES's DEFAULT_GRANTS with any existing row for (action, 'LogisticOrder') REPLACED by a
 * job-scoped one, for each action in `actions`. Call after `mockAuthAs('sales')`. */
function mockSalesConditionedLoActions(actions: string[]) {
  const base = DEFAULT_GRANTS.filter(
    (g) => g.role === 'SALES' && !(g.subject === 'LogisticOrder' && actions.includes(g.action)),
  );
  const rows = [
    ...base,
    ...actions.map((action) => ({ role: 'SALES', action, subject: 'LogisticOrder', conditions: OWN_VIA_JOB_CONDITION })),
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

describe("#2042 — POST /api/logistic-orders anchored to the caller's own job (discriminating create trio, R1)", () => {
  const JOB_OWN_ID = 'ba000000-0000-0000-0000-0000000000a1';
  const JOB_OTHER_ID = 'ba000000-0000-0000-0000-0000000000a2';
  const JOB_OWN = { id: JOB_OWN_ID, organization_id: ALPHA_ORG_ID, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } };
  const JOB_OTHER = { id: JOB_OTHER_ID, organization_id: ALPHA_ORG_ID, estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] } } };

  function mockSalesConditionedCreate() {
    mockAuthAs('sales');
    mockSalesConditionedLoActions(['create']);
    // E18's org-membership probe stays permissive (any id "exists" in-org) — the OWNERSHIP
    // question is canCreateOnAnchor's `count` probe below, wired through matchesScopeWhere
    // against the real job fixtures (R1), not a permissive stub.
    mockPrisma.job.findFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }));
    mockPrisma.job.count.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve([JOB_OWN, JOB_OTHER].filter((j) => matchesScopeWhere(where, j)).length),
    );
  }

  it("201s on the rep's own job", async () => {
    mockSalesConditionedCreate();
    const res = await request(app).post('/api/logistic-orders').set(authHeader('sales')).send({ job_id: JOB_OWN_ID, lines: [] });
    expect(res.status).toBe(201);
    expect(mockPrisma.logisticOrder.create).toHaveBeenCalled();
  });

  it("403s on another rep's job, mints nothing", async () => {
    mockSalesConditionedCreate();
    const res = await request(app).post('/api/logistic-orders').set(authHeader('sales')).send({ job_id: JOB_OTHER_ID, lines: [] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('DISPATCHER control: 201s on BOTH jobs (unconditional create today, unchanged)', async () => {
    mockAuthAs('dispatcher');
    for (const jobId of [JOB_OWN_ID, JOB_OTHER_ID]) {
      const res = await request(app).post('/api/logistic-orders').set(authHeader('dispatcher')).send({ job_id: jobId, lines: [] });
      expect(res.status).toBe(201);
    }
  });

  it("R4: a conditioned create carrying an anchor OTHER than job_id is refused, even for the rep's own job", async () => {
    mockSalesConditionedCreate();
    const res = await request(app).post('/api/logistic-orders').set(authHeader('sales'))
      .send({ job_id: JOB_OWN_ID, customer_id: 'ca000000-0000-0000-0000-000000000099', lines: [] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('R4 control: an unconditional caller keeps every anchor', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post('/api/logistic-orders').set(authHeader('dispatcher'))
      .send({ job_id: JOB_OWN_ID, customer_id: 'ca000000-0000-0000-0000-000000000099', lines: [] });
    expect(res.status).toBe(201);
  });
});

describe("#2042 — LogisticOrder existing-row verbs scoped to the rep's own job", () => {
  const LO_OWN_ID = 'bbbbbbb1-0000-0000-0000-0000000000b1';
  const LO_OTHER_ID = 'bbbbbbb1-0000-0000-0000-0000000000b2';

  function ownershipJob(ownerId: string) {
    return { id: JOB_ID, status: 'SCHEDULED', estimate: { lead: { lead_assignees: [{ user_id: ownerId }] } } };
  }

  function wireLoFindFirst(rows: Record<string, unknown>[]) {
    mockPrisma.logisticOrder.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === (where as { id: string }).id);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
    });
  }

  describe('GET /api/logistic-orders/:id (R8)', () => {
    it("404s another rep's LO, 200s the rep's own — grant hand-conditioned for this case", async () => {
      mockAuthAs('sales');
      // getLogisticOrder imports scopeWhereForReq directly (mocked file-wide, R8 mirrors the
      // list's OWN test above at line ~466) — the fragment is set here, not via rolePermission,
      // because this file's `enforce` mock replaces that specific export for every direct
      // importer (the list AND the detail read), unlike canActOnRow/canCreateOnAnchor below
      // (real, grant-driven — see the module comment above `mockSalesConditionedLoActions`).
      // Already-substituted (scopeWhereForReq normally does the {{userId}} substitution itself;
      // mocking it directly bypasses that, so the real id is inlined here instead).
      asMock(scopeWhereForReq).mockResolvedValue({
        job: { estimate: { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } } },
      });
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);

      const otherRes = await request(app).get(`/api/logistic-orders/${LO_OTHER_ID}`).set(authHeader('sales'));
      expect(otherRes.status).toBe(404);

      const ownRes = await request(app).get(`/api/logistic-orders/${LO_OWN_ID}`).set(authHeader('sales'));
      expect(ownRes.status).toBe(200);
      expect(ownRes.body.id).toBe(LO_OWN_ID);
    });

    it('DISPATCHER control: 200s both (unconditional read today, unchanged)', async () => {
      mockAuthAs('dispatcher');
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);
      for (const id of [LO_OWN_ID, LO_OTHER_ID]) {
        const res = await request(app).get(`/api/logistic-orders/${id}`).set(authHeader('dispatcher'));
        expect(res.status).toBe(200);
      }
    });
  });

  describe('PATCH /api/logistic-orders/:id', () => {
    it("404s another rep's LO, 200s the rep's own", async () => {
      mockAuthAs('sales');
      mockSalesConditionedLoActions(['update']);
      const own = loRow({ id: LO_OWN_ID, status: 'APPROVED', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'APPROVED', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);

      const otherRes = await request(app).patch(`/api/logistic-orders/${LO_OTHER_ID}`).set(authHeader('sales')).send({ notes: 'x' });
      expect(otherRes.status).toBe(404);
      expect(mockPrisma.logisticOrder.update).not.toHaveBeenCalled();

      const ownRes = await request(app).patch(`/api/logistic-orders/${LO_OWN_ID}`).set(authHeader('sales')).send({ notes: 'x' });
      expect(ownRes.status).toBe(200);
    });

    it('DISPATCHER control: 200s both (unconditional update today, unchanged)', async () => {
      mockAuthAs('dispatcher');
      const own = loRow({ id: LO_OWN_ID, status: 'APPROVED', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'APPROVED', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);
      for (const id of [LO_OWN_ID, LO_OTHER_ID]) {
        const res = await request(app).patch(`/api/logistic-orders/${id}`).set(authHeader('dispatcher')).send({ notes: 'x' });
        expect(res.status).toBe(200);
      }
    });
  });

  describe('POST /api/logistic-orders/:id/submit', () => {
    it("404s another rep's LO, 200s the rep's own", async () => {
      mockAuthAs('sales');
      mockSalesConditionedLoActions(['submit']);
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);

      const otherRes = await request(app).post(`/api/logistic-orders/${LO_OTHER_ID}/submit`).set(authHeader('sales'));
      expect(otherRes.status).toBe(404);
      expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();

      const ownRes = await request(app).post(`/api/logistic-orders/${LO_OWN_ID}/submit`).set(authHeader('sales'));
      expect(ownRes.status).toBe(200);
    });

    // DISPATCHER holds no `submit LogisticOrder` grant at all today (only SALES does) — the
    // unconditional-caller control here is ADMIN, the one role that always short-circuits.
    it('ADMIN control: 200s both (unconditional/superuser, unchanged)', async () => {
      mockAuthAs('admin');
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);
      for (const id of [LO_OWN_ID, LO_OTHER_ID]) {
        const res = await request(app).post(`/api/logistic-orders/${id}/submit`).set(authHeader('admin'));
        expect(res.status).toBe(200);
      }
    });
  });

  describe('DELETE /api/logistic-orders/:id', () => {
    it("404s another rep's LO (still exists after), 200s the rep's own", async () => {
      mockAuthAs('sales');
      mockSalesConditionedLoActions(['delete']);
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);

      const otherRes = await request(app).delete(`/api/logistic-orders/${LO_OTHER_ID}`).set(authHeader('sales'));
      expect(otherRes.status).toBe(404);
      expect(mockPrisma.logisticOrder.delete).not.toHaveBeenCalled();

      const ownRes = await request(app).delete(`/api/logistic-orders/${LO_OWN_ID}`).set(authHeader('sales'));
      expect(ownRes.status).toBe(200);
      expect(mockPrisma.logisticOrder.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: LO_OWN_ID } }));
    });

    // DISPATCHER holds no `delete LogisticOrder` grant at all today — same reasoning as submit.
    it('ADMIN control: 200s both (unconditional/superuser, unchanged)', async () => {
      mockAuthAs('admin');
      const own = loRow({ id: LO_OWN_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.sales.id) });
      const other = loRow({ id: LO_OTHER_ID, status: 'DRAFT', job: ownershipJob(TEST_USERS.admin.id) });
      wireLoFindFirst([own, other]);
      for (const id of [LO_OWN_ID, LO_OTHER_ID]) {
        const res = await request(app).delete(`/api/logistic-orders/${id}`).set(authHeader('admin'));
        expect(res.status).toBe(200);
      }
    });
  });
});
