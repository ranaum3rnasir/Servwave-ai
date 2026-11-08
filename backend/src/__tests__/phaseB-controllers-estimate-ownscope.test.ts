import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// Phase B — technician redesign. Estimate own-scope without role literals (F-004).
//
// The dangerous literal was `canAccessEstimate`'s `if (role !== 'SALES') return true` — it
// allow-all'd any non-SALES role, so a per-user OWN-scoped `read Estimate` grant (a technician)
// could read ANY estimate. After the fix, estimate access is grant-driven: a row-scoped reader
// (SALES by default, or a granted tech) reaches ONLY estimates on a lead they own; ADMIN/DISPATCHER
// (unconditional read) reach any. No `role === 'X'` literal may DEFEAT a per-user grant.
//
// Estimate CREATE keeps the parent-lead ownership check (estimate.controller.ts:745), generalized
// so a granted tech can create an estimate only on a lead they own.

// Zod validates POST bodies' ids as UUIDs (estimate create lead_id) — use UUID-shaped fixtures.
const LEAD_ID = '00000000-0000-0000-0000-0000000beef1';
const LEAD_OTHER_ID = '00000000-0000-0000-0000-0000000beef2';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  lead: { findUnique: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  stateTaxRate: { findFirst: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// A loaded estimate whose parent lead is owned by the technician (lead_assignees ∋ tech).
const ESTIMATE_OWNED_BY_TECH = {
  id: 'est-1',
  estimate_number: 'E00010',
  status: 'DRAFT',
  total_amount: 1000,
  lead: { id: LEAD_ID, lead_assignees: [{ user_id: TEST_USERS.technician.id }] },
};

const ESTIMATE_OWNED_BY_OTHER = {
  ...ESTIMATE_OWNED_BY_TECH,
  id: 'est-2',
  estimate_number: 'E00011',
  lead: { id: LEAD_OTHER_ID, lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }] },
};

function grantTech(action: string) {
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
    { action, subject: 'Estimate', effect: 'allow' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  (prisma.appSetting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('GET /api/estimates/:id — Phase B own-scope (no role-literal leak)', () => {
  it('granted tech CAN read an estimate on a lead they OWN', async () => {
    mockAuthAs('technician');
    grantTech('read');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_TECH);

    const res = await request(app).get('/api/estimates/est-1').set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('granted tech CANNOT read an estimate on a lead they do NOT own (the F-004 fix)', async () => {
    mockAuthAs('technician');
    grantTech('read');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_OTHER);

    const res = await request(app).get('/api/estimates/est-2').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('SALES is still own-scoped: 200 on own lead, 403 on another (regression)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_OWNED_BY_TECH,
      lead: { id: LEAD_ID, lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    const ownRes = await request(app).get('/api/estimates/est-1').set(authHeader('sales'));
    expect(ownRes.status).toBe(200);

    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_OTHER);
    const otherRes = await request(app).get('/api/estimates/est-2').set(authHeader('sales'));
    expect(otherRes.status).toBe(403);
  });

  it('DISPATCHER (unconditional read) reads any estimate', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_OTHER);
    const res = await request(app).get('/api/estimates/est-2').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });
});

// R6/D19 (2026-07-22) — a lead-less estimate has no assignee to own-scope through (lead is
// null), so canAccessEstimate falls back to created_by = self. No estimate produces a null lead
// yet (createEstimateSchema still requires lead_id), but the RBAC branch must be correct now so
// a future create path can land on top of it without reopening this gate.
const ESTIMATE_NO_LEAD_CREATED_BY_TECH = {
  id: 'est-3',
  estimate_number: 'E00012',
  status: 'DRAFT',
  total_amount: 500,
  lead: null,
  created_by: TEST_USERS.technician.id,
};

describe('GET /api/estimates/:id — Phase B own-scope, lead-less estimate (D19)', () => {
  it('granted tech CAN read a lead-less estimate they created', async () => {
    mockAuthAs('technician');
    grantTech('read');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_NO_LEAD_CREATED_BY_TECH);

    const res = await request(app).get('/api/estimates/est-3').set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('granted tech CANNOT read a lead-less estimate someone else created (own-scope holds with no lead to fall back on)', async () => {
    mockAuthAs('technician');
    grantTech('read');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_NO_LEAD_CREATED_BY_TECH,
      created_by: TEST_USERS.dispatcher.id,
    });

    const res = await request(app).get('/api/estimates/est-3').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('SALES own-scope also falls back to created_by on a lead-less estimate (regression-shaped, same rule as tech)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_NO_LEAD_CREATED_BY_TECH,
      created_by: TEST_USERS.sales.id,
    });
    const ownRes = await request(app).get('/api/estimates/est-3').set(authHeader('sales'));
    expect(ownRes.status).toBe(200);

    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_NO_LEAD_CREATED_BY_TECH); // created_by: technician
    const otherRes = await request(app).get('/api/estimates/est-3').set(authHeader('sales'));
    expect(otherRes.status).toBe(403);
  });

  it('DISPATCHER (unconditional read) reads any lead-less estimate too', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_NO_LEAD_CREATED_BY_TECH);
    const res = await request(app).get('/api/estimates/est-3').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/estimates — Phase B create parent-ownership (granted tech)', () => {
  const validBody = {
    lead_id: LEAD_ID,
    line_items: [{ description: 'Work', quantity: 1, unit_price: 100, is_taxable: true }],
  };

  beforeEach(() => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.stateTaxRate.findFirst.mockResolvedValue({ tax_rate: 0.0625 });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        estimate: { create: vi.fn().mockResolvedValue({ id: 'est-new', estimate_number: 'E00099', lead_id: LEAD_ID, line_items: [] }) },
        timelineEvent: { create: vi.fn() },
      }),
    );
  });

  it('granted tech CAN create an estimate on a lead they OWN', async () => {
    mockAuthAs('technician');
    grantTech('create');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: LEAD_ID, status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.technician.id }],
    });

    const res = await request(app).post('/api/estimates').set(authHeader('technician')).send(validBody);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it('granted tech CANNOT create an estimate on a lead they do NOT own (403)', async () => {
    mockAuthAs('technician');
    grantTech('create');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: LEAD_ID, status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
    });

    const res = await request(app).post('/api/estimates').set(authHeader('technician')).send(validBody);
    expect(res.status).toBe(403);
  });

  // Was: "strict (un-granted) tech is blocked at the route guard (403)". `create Estimate` became a
  // TECHNICIAN role default in the technician-ownership spec, Part C, so there is no un-granted
  // technician any more and the route guard is not the gate. The gate that survives is the
  // controller's parent-ownership check, which is what the two tests above exercise - re-asserted
  // here off the ROLE DEFAULT with no per-user grant, since that is the path every technician takes.
  // The positive half of the new `create Estimate` role default. Only the refusal was covered, which
  // is satisfiable by a grant that does not exist at all - the point of Part C's addition is that a
  // technician CAN raise an estimate, so that has to be asserted directly.
  it('tech on the ROLE DEFAULT can create an estimate on a lead they own, with no per-user grant', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: LEAD_ID, status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.technician.id }],
    });

    const res = await request(app).post('/api/estimates').set(authHeader('technician')).send(validBody);
    expect(res.status).toBe(201);
  });

  it('tech on the role default is still bound by parent ownership: 403 on a lead they do NOT own', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: LEAD_ID, status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
    });

    const res = await request(app).post('/api/estimates').set(authHeader('technician')).send(validBody);
    expect(res.status).toBe(403);
  });

  it('SALES create is still own-scoped: 403 on a lead they do not own (regression)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      id: LEAD_ID, status: 'NEW',
      lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
    });

    const res = await request(app).post('/api/estimates').set(authHeader('sales')).send(validBody);
    expect(res.status).toBe(403);
  });
});
