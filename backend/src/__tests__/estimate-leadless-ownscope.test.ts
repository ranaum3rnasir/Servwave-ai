import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// SERV10X-61 §8 - a customer-anchored (lead-less) estimate has `lead: null`. canAccessEstimate's
// getById gate already grants a SALES/row-scoped user own-scope on their lead-less estimate via
// `created_by === self`. Before §8 the LIST scope (the CASL condition compiled by scopeWhereForReq)
// still only matched own-via-lead, so a SALES user could NOT list their own lead-less estimate.
// §8 widens the SALES `read Estimate` grant to the OR of both arms so LIST and detail agree:
//   { OR: [ own-via-lead, { AND: [ lead_id: null, created_by: self ] } ] }
// These tests inspect the generated Prisma `where` (the file's existing idiom - scopeWhereForReq
// returns a `where` fragment, never CASL-evaluated in-memory), proving the lead-less arm is present
// and pinned to the requester's own id, and that the lead-anchored arm is unchanged.

const mockLeadless = prisma as unknown as {
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

// Every list() Prisma read stubbed so the handler completes with a clean 200 and we can inspect the
// captured `where` - mirrors the list-scope setup in estimates.test.ts.
beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockLeadless.estimate.findMany.mockResolvedValue([]);
  mockLeadless.estimate.count.mockResolvedValue(0);
  mockLeadless.estimate.groupBy.mockResolvedValue([]);
  mockLeadless.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockLeadless.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });
  mockLeadless.appSetting.findUnique.mockResolvedValue(null);
});

const listWhere = () =>
  mockLeadless.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;

describe('GET /api/estimates (LIST) - SERV10X-61 §8 lead-less own-scope', () => {
  it("INCLUDES a SALES user's own lead-less estimate: the scope OR carries the lead_id:null + created_by-self arm", async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/estimates').set(authHeader('sales'));

    expect(res.status).toBe(200);
    // The full substituted OR - NOT weakened: the own-via-lead arm is byte-for-byte the old scope,
    // and the second (lead-less) arm carries the SALES user's real id.
    expect(listWhere().OR).toEqual([
      { lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } },
      { AND: [{ lead_id: null }, { created_by: TEST_USERS.sales.id }] },
    ]);
  });

  it("EXCLUDES another rep's lead-less estimate: the lead-less arm pins created_by to the requester, not another user", async () => {
    mockAuthAs('sales');

    await request(app).get('/api/estimates').set(authHeader('sales'));

    const or = listWhere().OR as Array<Record<string, unknown>>;
    const leadlessArm = or.find((b) => Array.isArray(b.AND));
    expect(leadlessArm).toBeDefined();
    // created_by is pinned to the SALES user's OWN id - a lead-less estimate created by another rep
    // (e.g. the dispatcher) can never satisfy this scope, so the list can never leak it.
    expect(leadlessArm!.AND).toContainEqual({ created_by: TEST_USERS.sales.id });
    expect(leadlessArm!.AND).not.toContainEqual({ created_by: TEST_USERS.dispatcher.id });
  });

  it('still scopes lead-anchored estimates to leads the SALES user owns (own-via-lead arm unchanged)', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/estimates').set(authHeader('sales'));

    const or = listWhere().OR as Array<Record<string, unknown>>;
    const leadArm = or.find((b) => 'lead' in b);
    expect(leadArm).toEqual({ lead: { lead_assignees: { some: { user_id: TEST_USERS.sales.id } } } });
  });
});

describe('GET /api/estimates/:id - SERV10X-61 §8 lead-less parity (canAccessEstimate)', () => {
  it("SALES gets 200 on their own lead-less estimate (created_by = self, lead = null) - LIST and detail agree", async () => {
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

    const res = await request(app).get('/api/estimates/est-leadless-1').set(authHeader('sales'));

    expect(res.status).toBe(200);
  });
});
