import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// Live QA, 2026-08-05: the technician creator-control promotion (PR #1300) granted TECHNICIAN
// `create Estimate` but no `read Estimate` of any kind, so a technician who raises a STANDALONE
// estimate (lead-less, `lead: null`) cannot see it afterwards - list scope resolved to
// MATCH_NOTHING (no read grant at all). The fix reuses OWN_ESTIMATE_VIA_LEAD_OR_CREATOR, the same
// condition SALES already holds for exactly this shape (estimate-leadless-ownscope.test.ts) - a
// technician's estimate is always lead-less, so it lands on the creator arm.

const mockTech = prisma as unknown as {
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  invoice: { aggregate: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockTech.estimate.findMany.mockResolvedValue([]);
  mockTech.estimate.count.mockResolvedValue(0);
  mockTech.estimate.groupBy.mockResolvedValue([]);
  mockTech.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockTech.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });
  mockTech.appSetting.findUnique.mockResolvedValue(null);
});

const listWhere = () =>
  mockTech.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;

describe('GET /api/estimates (LIST) - TECHNICIAN own-scope (creator arm)', () => {
  it("TECHNICIAN's read grant carries the lead_id:null + created_by-self arm, pinned to their own id", async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/estimates').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(listWhere().OR).toEqual([
      { lead: { lead_assignees: { some: { user_id: TEST_USERS.technician.id } } } },
      { AND: [{ lead_id: null }, { created_by: TEST_USERS.technician.id }] },
    ]);
  });

  it("does not leak another technician's lead-less estimate: the creator arm is pinned to the requester", async () => {
    mockAuthAs('technician');

    await request(app).get('/api/estimates').set(authHeader('technician'));

    const or = listWhere().OR as Array<Record<string, unknown>>;
    const leadlessArm = or.find((b) => Array.isArray(b.AND));
    expect(leadlessArm).toBeDefined();
    expect(leadlessArm!.AND).toContainEqual({ created_by: TEST_USERS.technician.id });
    expect(leadlessArm!.AND).not.toContainEqual({ created_by: TEST_USERS.sales.id });
  });
});

describe('GET /api/estimates/:id - TECHNICIAN own-scope (canAccessEstimate)', () => {
  it('TECHNICIAN gets 200 on a standalone estimate it created (lead: null, created_by: self)', async () => {
    mockAuthAs('technician');
    mockTech.estimate.findUnique.mockResolvedValue({
      id: 'est-tech-1',
      estimate_number: 'E00099',
      status: 'DRAFT',
      total_amount: 250,
      lead: null,
      created_by: TEST_USERS.technician.id,
      line_items: [],
      scopes: [],
      scope_photos: [],
    });

    const res = await request(app).get('/api/estimates/est-tech-1').set(authHeader('technician'));

    expect(res.status).toBe(200);
  });

  it("TECHNICIAN gets 403 on another user's standalone estimate", async () => {
    mockAuthAs('technician');
    mockTech.estimate.findUnique.mockResolvedValue({
      id: 'est-other-1',
      estimate_number: 'E00100',
      status: 'DRAFT',
      total_amount: 250,
      lead: null,
      created_by: TEST_USERS.sales.id,
      line_items: [],
      scopes: [],
      scope_photos: [],
    });

    const res = await request(app).get('/api/estimates/est-other-1').set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});
