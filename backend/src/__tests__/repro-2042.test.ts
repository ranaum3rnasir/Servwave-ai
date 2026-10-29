/**
 * #2042 — SALES purchasing grants (Ran's decision, QA row 023).
 *
 * Ran's decision: SALES gets full READ of inventory (stock, locations, price book incl.
 * cost/GM, vendors org-wide), NO writes except LOGISTIC ORDERS for jobs they are assigned to
 * (create/edit/delete, job-attached only); purchase orders are READ-ONLY and only those on the
 * rep's own jobs (a PO with no job is invisible).
 *
 * Reproduced on prod (Pass A, demo org, commit 2837b4565): as SALES, GET
 * /api/inventory/purchase-orders lists every PO in the org regardless of whose job it is on
 * (and one with no job at all); GET .../purchase-orders/:id 200s a PO on someone else's job;
 * POST /api/logistic-orders lets SALES create a logistic order on ANY job in the org, or with
 * no job anchor at all.
 *
 * Root cause (two independent defects):
 *   1. `scopeWhereFor.ts`'s `ScopeResource` union omits `'PurchaseOrder'`
 *      (scopeWhereFor.ts:17), so `inv-po.controller.ts`'s `listPurchaseOrders` /
 *      `getPurchaseOrder` apply ONLY `tenantWhere(req)` — never `scopeWhereForReq` — no matter
 *      what condition a `read PurchaseOrder` grant carries. (a)/(b) below prove this by handing
 *      SALES a job-scoped `read PurchaseOrder` grant directly (the shape the fix's migration is
 *      expected to write) and showing the controller ignores it anyway.
 *   2. `logistic-order.controller.ts`'s `createLogisticOrder` (507-584) performs zero
 *      ownership/ability check against the caller for any anchor — `assertAnchorsInOrg` only
 *      checks the anchor id is IN-ORG, not that it belongs to the caller. This is reachable
 *      today because DEFAULT_GRANTS already gives SALES an UNCONDITIONAL `create LogisticOrder`
 *      (defaultGrants.ts:178) — no test-only grant injection needed for (c).
 *
 * DEFAULT_GRANTS itself is also wrong on all three subjects for SALES (case (d)): no `read
 * PurchaseOrder` row at all (prod's unconditional one is pure drift, not a code default), no
 * `read Vendor` row at all (Vendor read is CORRECT per Ran's decision and just needs adding,
 * unconditional), and `read`/`create`/`submit LogisticOrder` are present but UNCONDITIONAL
 * (should be job-scoped) with no `update`/`delete LogisticOrder` rows at all (the Brief calls
 * for create/edit/delete on the rep's own jobs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, matchesScopeWhere, TEST_USERS, ALPHA_ORG_ID, PURCHASE_ORDER_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// The controller's create path is anchored (job present), so it mints via allocateAnchoredNumber
// — not covered by setup.ts's global numbering mock (which only stubs allocateNumber). Mirrors
// the pattern in logistic-orders.test.ts.
vi.mock('../lib/numbering', async (orig) => {
  const actual = await orig<typeof import('../lib/numbering')>();
  return {
    ...actual,
    allocateNumber: vi.fn().mockResolvedValue('LO00001'),
    allocateAnchoredNumber: vi.fn().mockResolvedValue({ number: 'LO-J00016-2', seq: 1 }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;
const ADMIN_ID = TEST_USERS.admin.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (a)/(b) — PurchaseOrder read-scope leak (inv-po.controller.ts applies only tenantWhere)
// ═══════════════════════════════════════════════════════════════════════════════════════════

// The job-scoped condition the fix's migration is expected to write for `read PurchaseOrder`
// (mirrors OWN_JOB_VIA_ESTIMATE, nested under PurchaseOrder's `job` relation).
const OWN_JOB_PO_CONDITION = {
  job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
};

/** Grant SALES a job-scoped `read PurchaseOrder` on top of its normal defaults, then reload the
 * ability. Necessary because DEFAULT_GRANTS carries NO `read PurchaseOrder` row at all today
 * (case (d)) — without this, `canDo('read','PurchaseOrder')` 403s at the ROUTER, before ever
 * reaching the controller code these cases are pinning. */
function mockSalesReadPurchaseOrderScoped() {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
    { role: 'SALES', action: 'read', subject: 'PurchaseOrder', conditions: OWN_JOB_PO_CONDITION },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

function poFixture(over: Record<string, unknown>) {
  return { ...PURCHASE_ORDER_FIXTURE, ...over };
}

const PO_A_ID = 'aaaaaaa4-1111-0000-0000-000000000001'; // on the rep's own job
const PO_B_ID = 'aaaaaaa4-2222-0000-0000-000000000002'; // on another rep's (admin's) job
const PO_C_ID = 'aaaaaaa4-3333-0000-0000-000000000003'; // no job at all
const JOB_A_ID = 'ba000000-0000-0000-0000-00000000000a';
const JOB_B_ID = 'ba000000-0000-0000-0000-00000000000b';

const PO_A = poFixture({
  id: PO_A_ID,
  job_id: JOB_A_ID,
  job: { job_number: 'J-A', estimate: { lead: { lead_assignees: [{ user_id: SALES_ID }] } } },
});
const PO_B = poFixture({
  id: PO_B_ID,
  job_id: JOB_B_ID,
  job: { job_number: 'J-B', estimate: { lead: { lead_assignees: [{ user_id: ADMIN_ID }] } } },
});
const PO_C = poFixture({ id: PO_C_ID, job_id: null, job: null });

const ALL_POS = [PO_A, PO_B, PO_C];

/** Wire findMany to really evaluate the `where` clause against the fixtures (matchesScopeWhere),
 * the way inv-po.test.ts and job-creator-control.test.ts do — Prisma itself is mocked, so
 * without this the mock hands back whatever it's told regardless of the query the controller
 * built, and the assertion below would be vacuous either way. */
function wireScopedPoFindMany() {
  mockPrisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(ALL_POS.filter((row) => matchesScopeWhere(where, row))),
  );
}

function wireScopedPoFindFirst() {
  mockPrisma.purchaseOrder.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    const row = ALL_POS.find((p) => p.id === where.id);
    if (!row) return Promise.resolve(null);
    return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
  });
}

describe('#2042 (a) GET /api/inventory/purchase-orders — SALES sees every org PO, not just their own', () => {
  it('lists ONLY the PO on the rep\'s own job (today: all three, incl. another job and a no-job PO)', async () => {
    mockAuthAs('sales');
    mockSalesReadPurchaseOrderScoped();
    wireScopedPoFindMany();

    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const ids = (res.body.purchaseOrders as Array<{ id: string }>).map((p) => p.id);
    // Reported reason: inv-po.controller.ts's listPurchaseOrders never calls scopeWhereForReq
    // (scopeWhereFor.ts's ScopeResource union omits 'PurchaseOrder'), so the job-scoped grant
    // above is silently ignored and tenantWhere alone lets every org PO through.
    expect(ids).toEqual([PO_A_ID]);
  });
});

describe('#2042 (b) GET /api/inventory/purchase-orders/:id — a PO on someone else\'s job is visible', () => {
  beforeEach(() => {
    mockAuthAs('sales');
    mockSalesReadPurchaseOrderScoped();
    wireScopedPoFindFirst();
  });

  it('404s a PO on another job (today: 200 with the full PO body, incl. costs)', async () => {
    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_B_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(404);
  });

  it('404s a PO with no job at all — "a PO with no job is invisible" (today: 200)', async () => {
    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_C_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(404);
  });

  it('control: 200s the PO that really is on the rep\'s own job', async () => {
    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_A_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrder.id).toBe(PO_A_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (c) — POST /api/logistic-orders has zero ownership check (createLogisticOrder, 507-584)
// ═══════════════════════════════════════════════════════════════════════════════════════════

function setupLoTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        logisticOrder: { create: mockPrisma.logisticOrder.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function loCreateRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-0000-0000-0000-000000000001',
    number: 'LO-J00016-2',
    seq: 1,
    status: 'DRAFT',
    notes: null,
    lines: [],
    creator: null,
    submitter: null,
    approver: null,
    processor: null,
    submitted_at: null,
    approved_at: null,
    processed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_at: new Date('2026-09-11'),
    updated_at: new Date('2026-09-11'),
    job: null,
    invoice: null,
    estimate: null,
    lead: null,
    customer: null,
    service_plan: null,
    ...over,
  };
}

describe('#2042 (c) POST /api/logistic-orders — SALES can open work on ANY job, or none', () => {
  beforeEach(() => {
    mockAuthAs('sales'); // DEFAULT_GRANTS already gives SALES unconditional `create LogisticOrder` — no injection needed.
    setupLoTransaction();
    // E18 (assertAnchorsInOrg) only checks the anchor id is IN-ORG — any id "exists" here.
    mockPrisma.job.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ id: where.id }),
    );
    mockPrisma.logisticOrder.create.mockResolvedValue(loCreateRow());
  });

  it('403s a create for a job that belongs to someone else, not the rep (today: 201)', async () => {
    const res = await request(app)
      .post('/api/logistic-orders')
      .set(authHeader('sales'))
      .send({ job_id: JOB_B_ID }); // admin's job, not this rep's

    expect(res.status).toBe(403);
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('refuses a create with no job/anchor at all — LOs must be job-attached (today: 201)', async () => {
    const res = await request(app).post('/api/logistic-orders').set(authHeader('sales')).send({});

    expect([400, 403]).toContain(res.status);
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// (d) — DEFAULT_GRANTS itself is wrong on all three subjects for SALES
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('#2042 (d) DEFAULT_GRANTS — SALES purchasing rows', () => {
  const salesGrants = () => DEFAULT_GRANTS.filter((g) => g.role === 'SALES');
  const find = (action: string, subject: string) =>
    salesGrants().find((g) => g.action === action && g.subject === subject);

  it('holds a job-scoped `read PurchaseOrder` grant (today: no row for the subject at all)', () => {
    const grant = find('read', 'PurchaseOrder');
    expect(grant, 'SALES has no read PurchaseOrder grant in DEFAULT_GRANTS today').toBeDefined();
    expect(grant?.conditions, 'read PurchaseOrder must be job-scoped, not org-wide').toBeTruthy();
  });

  it('holds an UNCONDITIONAL `read Vendor` grant (org-wide reference data; today: no row at all)', () => {
    const grant = find('read', 'Vendor');
    expect(grant, 'SALES has no read Vendor grant in DEFAULT_GRANTS today').toBeDefined();
    expect(grant?.conditions ?? null, 'read Vendor should stay org-wide per Ran\'s decision').toBeNull();
  });

  it('holds job-scoped `read`/`create`/`submit LogisticOrder` (today: present but UNCONDITIONAL)', () => {
    for (const action of ['read', 'create', 'submit']) {
      const grant = find(action, 'LogisticOrder');
      expect(grant, `SALES has no ${action} LogisticOrder grant`).toBeDefined();
      expect(grant?.conditions, `${action} LogisticOrder is unconditional (org-wide) today`).toBeTruthy();
    }
  });

  it('holds job-scoped `update`/`delete LogisticOrder` (today: no row for either action at all)', () => {
    for (const action of ['update', 'delete']) {
      const grant = find(action, 'LogisticOrder');
      expect(grant, `SALES has no ${action} LogisticOrder grant in DEFAULT_GRANTS today`).toBeDefined();
      expect(grant?.conditions).toBeTruthy();
    }
  });
});
