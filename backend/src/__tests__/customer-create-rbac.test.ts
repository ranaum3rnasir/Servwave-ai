/**
 * customer-create-rbac.test.ts — behavioral proof for #1472 slice 2 (SALES gains `create Customer`
 * directly). Modelled on customer-export-rbac.test.ts, the same test written for the mirror case
 * (a role LOSING a Customer verb).
 *
 * These are REQUESTS, not ability assertions: supertest drives the real route through
 * authenticate -> attachAbility -> canDo('create','Customer') -> customerController.create, with
 * the principal built from DEFAULT_GRANTS by mockAuthAs. That is what makes AC1 meaningful (a
 * unit-level `ability.can` check would pass even if the route guard were removed) and what proves
 * AC2's negatives are the controller never being reached, not merely a status code.
 *
 * Both caches are cleared per test: the grant cache and the token cache are module-scoped and
 * keyed by org+role, so an ability built in one test would otherwise be served to the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  note: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

const validBody = {
  first_name: 'qa-1472',
  last_name: `sales-create-${Date.now()}`,
  email: `qa-1472-${Date.now()}@example.test`,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // Duplicate-customer guard runs prisma.customer.findMany before the create transaction.
  mockPrisma.customer.findMany.mockResolvedValue([]);
});

describe('POST /api/customers — SALES gains create Customer (#1472)', () => {
  it('AC1: returns 201 and reaches customer.create — this must FAIL (403, create never called) on base', async () => {
    mockAuthAs('sales');
    const created = { id: 'qa-1472-new-id', ...validBody, service_locations: [] };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue(created) } };
      return fn(txMock);
    });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('sales'))
      .send(validBody);

    expect(res.status).toBe(201);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

describe('POST /api/customers — the adjacent negatives are pinned (AC2)', () => {
  it('DELETE /api/customers/:id still 403s for SALES, and the controller is never reached', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('GET /api/customers/export still 403s for SALES (018) — export is the load-bearing negative', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('POST /api/customers/:id/archive still 403s for SALES', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/archive`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('PATCH /api/customers/:id/number still 403s for SALES (renumber)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}/number`)
      .set(authHeader('sales'))
      .send({ customer_number: 'C-9999' });

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it('POST /api/customers/:id/purge still 403s for SALES', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/purge`)
      .set(authHeader('sales'))
      .send({ confirm: 'qa-1472-does-not-matter' });

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('POST /api/customers/:id/anonymize still 403s for SALES', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/anonymize`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('read and update remain 2xx for SALES — they were already granted, unaffected by this slice', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });
});

describe('POST /api/customers -> GET /api/customers/:id — the round trip slice 1 relies on (AC7)', () => {
  it('a SALES caller can create a customer and immediately read it back by the returned id', async () => {
    mockAuthAs('sales');
    const created = { id: 'qa-1472-roundtrip-id', ...validBody, service_locations: [] };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = { customer: { create: vi.fn().mockResolvedValue(created) } };
      return fn(txMock);
    });
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const createRes = await request(app)
      .post('/api/customers')
      .set(authHeader('sales'))
      .send(validBody);

    expect(createRes.status).toBe(201);
    const newId = createRes.body.customer.id;
    expect(newId).toBe(created.id);

    // GET /:id bundles a financial summary — zero-value mocks, same idiom as customers.test.ts's
    // "GET /api/customers/:id" suite. #2041 — SALES's read Customer is now row-scoped
    // (OWN_CUSTOMER); the customer THEY JUST CREATED is associated via `created_by_id`
    // (`createdByUser(req)` stamps it), which is the real-world guarantee this test pins.
    mockPrisma.customer.findUnique.mockResolvedValue({ ...CUSTOMER_FIXTURE, id: newId, created_by_id: TEST_USERS.sales.id });
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
      .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
      .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);

    const getRes = await request(app)
      .get(`/api/customers/${newId}`)
      .set(authHeader('sales'));

    expect(getRes.status).toBe(200);
    expect(getRes.body.customer.id).toBe(newId);
  });
});
