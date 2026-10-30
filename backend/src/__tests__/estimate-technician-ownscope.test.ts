import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, attachedEstimateWhere, creatorEstimateWhere } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Technician's Estimates scope is Attached: the estimates on a lead or job they are attached to. Having
// created a lead-less (standalone) estimate attaches nobody, so it is no longer reached by this scope; the
// creator rule (S01.4) is what keeps a person's own customer-only estimate open to them, for every role.

const mockTech = prisma as unknown as {
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
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
  mockTech.estimate.findMany.mockResolvedValue([]);
  mockTech.estimate.count.mockResolvedValue(0);
  mockTech.estimate.groupBy.mockResolvedValue([]);
  mockTech.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockTech.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });
  mockTech.appSetting.findUnique.mockResolvedValue(null);
});

const listWhere = () =>
  mockTech.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;

describe('GET /api/estimates (LIST) - TECHNICIAN Attached scope', () => {
  it("TECHNICIAN's list is the estimates attached to them through their lead or job", async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/estimates').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(listWhere().OR).toEqual([
      { OR: attachedEstimateWhere(TEST_USERS.technician.id) },
      creatorEstimateWhere(TEST_USERS.technician.id),
    ]);
  });

  it("does not reach a lead-less estimate by who created it through the scope; only the creator rule's own arm does", async () => {
    mockAuthAs('technician');

    await request(app).get('/api/estimates').set(authHeader('technician'));

    const [scopeArm] = listWhere().OR as Record<string, unknown>[];
    expect(JSON.stringify(scopeArm)).not.toContain('created_by');
  });
});

describe('GET /api/estimates/:id - TECHNICIAN Attached scope', () => {
  it('TECHNICIAN gets 403 on an estimate it created on a job it is not on: creating it attaches nobody', async () => {
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
    mockTech.estimate.findFirst.mockResolvedValue(null); // outside the scope

    const res = await request(app).get('/api/estimates/est-tech-1').set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  it('TECHNICIAN gets 200 on an estimate on a lead or job they are attached to', async () => {
    mockAuthAs('technician');
    mockTech.estimate.findUnique.mockResolvedValue({
      id: 'est-tech-2',
      estimate_number: 'E00101',
      status: 'DRAFT',
      total_amount: 250,
      lead: null,
      created_by: TEST_USERS.sales.id,
      line_items: [],
      scopes: [],
      scope_photos: [],
    });
    mockTech.estimate.findFirst.mockResolvedValue({ id: 'est-tech-2' }); // inside the scope

    const res = await request(app).get('/api/estimates/est-tech-2').set(authHeader('technician'));

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
    mockTech.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/estimates/est-other-1').set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});
