/**
 * customer-export-rbac.test.ts — behavioral proof for the 018 SALES `export Customer` revocation.
 *
 * GET /api/customers/export is an unpaginated download of the whole customer book. SALES lost the
 * grant (defaultGrants.ts + 20260828140000_drop_sales_customer_export_grant); DISPATCHER and ADMIN
 * kept it.
 *
 * These are REQUESTS, not ability assertions: supertest drives the real route through
 * authenticate -> attachAbility -> canDo('export','Customer') -> exportAll, with the principal
 * built from DEFAULT_GRANTS by mockAuthAs. That is what makes the refusal case meaningful (a
 * unit-level `ability.can` check would pass even if the route guard were removed) and what makes
 * the DISPATCHER case a real blast-radius pin: it asserts the retained role still gets its rows,
 * the 50,000 row cap, the org scope, and the audit record — the endpoint itself did not change.
 *
 * Both caches are cleared per test: the grant cache is module-scoped and keyed by org+role, so a
 * SALES ability built in one test would otherwise be served to the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: { findMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/customers/export — SALES is refused (018)', () => {
  it('403s a SALES caller and never reaches the query or the audit write', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'customer.exported' }) }),
    );
  });

  it('refuses SALES even with query filters that would narrow the download', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/export?state=TX&search=doe')
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('leaves the SALES customer read path working — the revocation is export-only', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });
});

describe('GET /api/customers/export — DISPATCHER still succeeds (018 blast radius)', () => {
  it('200s a DISPATCHER caller and returns the rows under the {customers} envelope', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.pagination).toBeUndefined();
  });

  it('keeps the DISPATCHER export unchanged: org scope, filters, 50,000 row cap, no skip', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/export?state=CA&search=acme')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const args = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.where.OR).toBeDefined();                 // search filter still applied
    expect(JSON.stringify(args.where)).toContain('CA');  // state filter still applied
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(50_000);
    expect(args.select.customer_number).toBe(true);
    expect(args.select.service_locations).toBeDefined();
  });

  it('still writes the customer.exported audit record for DISPATCHER', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'customer.exported', resource_type: 'Customer' }),
      }),
    );
  });

  it('still succeeds for ADMIN, who holds the capability through manage-all', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
  });
});
