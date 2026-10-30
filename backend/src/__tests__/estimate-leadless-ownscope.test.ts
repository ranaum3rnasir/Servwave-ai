import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ownLeadsEstimateWhere, creatorEstimateWhere } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// A customer-anchored (lead-less) estimate has `lead: null`. Sales reaches estimates through the kept
// "Through own leads" value on Estimates scope: estimates whose lead has the person as an assignee. The
// old second arm ("a lead-less estimate I created, for good") is NOT compiled into that scope; the creator
// rule (S01.4) covers those estimates for every role instead, as its own arm of the list. These tests
// inspect the generated Prisma `where` (scopeWhereForReq returns a `where` fragment, never CASL-evaluated
// in-memory), proving the scope itself has no created-by arm, and that the detail route agrees with the list.

const mockLeadless = prisma as unknown as {
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

// Every list() Prisma read stubbed so the handler completes with a clean 200 and we can inspect the
// captured `where` - mirrors the list-scope setup in estimates.test.ts.
beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockLeadless.estimate.findMany.mockResolvedValue([]);
  mockLeadless.estimate.count.mockResolvedValue(0);
  mockLeadless.estimate.groupBy.mockResolvedValue([]);
  mockLeadless.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockLeadless.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });
  mockLeadless.appSetting.findUnique.mockResolvedValue(null);
});

const listWhere = () =>
  mockLeadless.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;

describe('GET /api/estimates (LIST) - Sales scope has no created-by arm of its own', () => {
  it("scopes Sales to the estimates of leads they are an assignee of, and nothing else", async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/estimates').set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(listWhere().OR).toEqual([
      ownLeadsEstimateWhere(TEST_USERS.sales.id),
      creatorEstimateWhere(TEST_USERS.sales.id),
    ]);
  });

  it("does not reach a lead-less estimate by who created it through the scope; only the creator rule's own arm does", async () => {
    mockAuthAs('sales');

    await request(app).get('/api/estimates').set(authHeader('sales'));

    const [scopeArm, creatorArm] = listWhere().OR as Record<string, unknown>[];
    expect(JSON.stringify(scopeArm)).not.toContain('created_by');
    expect(creatorArm).toEqual(creatorEstimateWhere(TEST_USERS.sales.id));
  });
});

describe('GET /api/estimates/:id - lead-less detail agrees with the list', () => {
  it("answers 403 for a lead-less estimate the Sales scope does not reach, even one they created", async () => {
    mockAuthAs('sales');
    mockLeadless.estimate.findUnique.mockResolvedValue({
      id: 'est-leadless-1',
      estimate_number: 'E00042',
      status: 'DRAFT',
      total_amount: 500,
      lead: null,
      created_by: TEST_USERS.sales.id,
      line_items: [],
      scopes: [],
      scope_photos: [],
    });
    mockLeadless.estimate.findFirst.mockResolvedValue(null); // outside the scope: no lead of theirs

    const res = await request(app).get('/api/estimates/est-leadless-1').set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});
