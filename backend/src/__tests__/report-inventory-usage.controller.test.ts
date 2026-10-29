/**
 * report-inventory-usage.controller.test.ts — P5 §3.1: GET /api/reports/inventory-usage
 *
 * Route gate: `read Report` (Admin + Dispatcher) like every live report.
 * Tenancy via tenantWhere; consume-only fetch; default trailing-12-month window
 * (mirrors resolveFilters); cost + unpricedUnits stripped for a requester
 * without `read Invoice` (canSeePricing — per-user overrides make it mandatory).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, PRICE_BOOK_ITEM_FIXTURE, TEST_USERS } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as unknown as {
  stockMovement: { findMany: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000021';

function consumeRow(over: Record<string, unknown> = {}) {
  return {
    type: 'consume',
    occurred_at: new Date('2026-07-01T10:00:00Z'),
    item_id: PRICE_BOOK_ITEM_FIXTURE.id,
    item_sku: 'LOCK-100',
    item_name: 'Deadbolt Lock',
    qty: '2.00',
    unit_cost: '12.50',
    job_id: JOB_ID,
    job: { id: JOB_ID, job_number: 'J00001' },
    invoice_line_item: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
  mockPrisma.stockMovement.findMany.mockResolvedValue([]);
});

describe('GET /api/reports/inventory-usage', () => {
  it('fetches consume movements tenant-scoped with the default trailing-12-month window', async () => {
    mockAuthAs('admin');
    const before = Date.now();
    const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));
    const after = Date.now();
    expect(res.status).toBe(200);

    const where = mockPrisma.stockMovement.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.type).toBe('consume');
    const { gte, lte } = where.occurred_at;
    expect(lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(lte.getTime()).toBeLessThanOrEqual(after);
    expect(lte.getTime() - gte.getTime()).toBe(365 * 86_400_000);
  });

  it('honors an explicit from/to range and echoes it back', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/reports/inventory-usage?from=2026-06-01&to=2026-06-30')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const where = mockPrisma.stockMovement.findMany.mock.calls[0][0].where;
    expect(where.occurred_at.gte).toEqual(new Date('2026-06-01'));
    // A date-only `to` names a WHOLE day, so the upper bound runs to its end
    // (inclusiveEndOfDay). The lower bound stays at midnight — already inclusive.
    expect(where.occurred_at.lte).toEqual(new Date('2026-06-30T23:59:59.999Z'));
    expect(res.body.from).toBe(new Date('2026-06-01').toISOString());
    expect(res.body.to).toBe('2026-06-30T23:59:59.999Z');
  });

  it('a date-only `to` includes movements from that whole day (QA: today was invisible)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/reports/inventory-usage?from=2026-07-01&to=2026-07-21')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const { lte } = mockPrisma.stockMovement.findMany.mock.calls[0][0].where.occurred_at;
    expect(lte.toISOString()).toBe('2026-07-21T23:59:59.999Z');
    // The exact movement the QA pass lost: an LO consume at 03:36Z on the 21st.
    expect(new Date('2026-07-21T03:36:15.065Z') <= lte).toBe(true);
  });

  it('rejects a garbage date with 400', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/reports/inventory-usage?from=garbage').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });

  it('403s roles without read Report (Technician, Sales)', async () => {
    mockAuthAs('technician');
    expect((await request(app).get('/api/reports/inventory-usage').set(authHeader('technician'))).status).toBe(403);
    clearPermissionCache();
    mockAuthAs('sales');
    expect((await request(app).get('/api/reports/inventory-usage').set(authHeader('sales'))).status).toBe(403);
    expect(mockPrisma.stockMovement.findMany).not.toHaveBeenCalled();
  });

  describe('entitlement gate - inventory', () => {
    it('402s an org whose plan lacks `inventory`, controller never runs', async () => {
      mockAuthAs('realOrgAdmin');
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...TEST_USERS.realOrgAdmin,
        organization: { is_demo: false, plan: 'PRO', trial_ends_at: null, feature_overrides: {} },
      });

      const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('realOrgAdmin'));

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('FEATURE_NOT_IN_PLAN');
      expect(res.body.feature).toBe('inventory');
      expect(res.body.current_plan).toBe('PRO');
      expect(res.body.required_plan).toBe('SCALE');
      expect(mockPrisma.stockMovement.findMany).not.toHaveBeenCalled();
    });

    it('200s a SCALE org that holds `inventory` (the gate must not take away a paid report)', async () => {
      mockAuthAs('admin');

      const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(mockPrisma.stockMovement.findMany).toHaveBeenCalled();
    });

    it('is per-route: a PRO org still reaches the other report endpoints', async () => {
      mockAuthAs('realOrgAdmin');
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...TEST_USERS.realOrgAdmin,
        organization: { is_demo: false, plan: 'PRO', trial_ends_at: null, feature_overrides: {} },
      });
      mockPrisma.estimate.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&model=sent')
        .set(authHeader('realOrgAdmin'));

      expect(res.status).toBe(200);
    });
  });

  it('returns cost + unpricedUnits for a pricing-visible requester (admin), Decimal-normalized', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([
      consumeRow(),
      consumeRow({ unit_cost: null, qty: '1.00' }),
    ]);
    const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.units).toBe(3);
    expect(item.cost).toBe(25);
    expect(item.unpricedUnits).toBe(1);
    expect(item.jobs).toEqual([{ id: JOB_ID, jobNumber: 'J00001' }]);
  });

  it('strips cost AND unpricedUnits from every row when the requester lacks read Invoice', async () => {
    mockAuthAs('dispatcher');
    // read Report without read Invoice — the per-user-override shape that makes the strip mandatory.
    setCachedGrants(ALPHA_ORG_ID, 'DISPATCHER', [
      { action: 'read', subject: 'Report' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockPrisma.stockMovement.findMany.mockResolvedValue([consumeRow(), consumeRow({ unit_cost: null })]);

    const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    for (const item of res.body.items) {
      expect('cost' in item).toBe(false);
      expect('unpricedUnits' in item).toBe(false);
      // units/jobs remain — a units-only report, not an empty one
      expect(item.units).toBe(4);
    }
  });

  // ── E26 / §14 H2: LO-anchored invoice attribution ──────────────────────────
  // An LO-issued consume carries no invoice_line_item — its invoice drill-through rides the LO's
  // own invoice anchor via the `logistic_order → invoice` join in the usage select, or the report
  // would show that consumption as unattributed. (The Prisma join is not executed under the mock
  // harness; these pin the select wiring + the boundary row mapping the service consumes.)
  describe('LO drill-through (H2)', () => {
    const LO_INVOICE_ID = 'cccccccc-0000-0000-0000-000000000009';

    it('attributes an LO-issued consume to its invoice via the LO anchor', async () => {
      mockAuthAs('admin');
      mockPrisma.stockMovement.findMany.mockResolvedValue([
        // LO-issued: invoice_line_item is null (consumeRow default); invoice rides the LO anchor.
        consumeRow({ logistic_order: { invoice: { id: LO_INVOICE_ID, invoice_number: 'I00099' } } }),
      ]);

      const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(res.body.items[0].invoices).toEqual([{ id: LO_INVOICE_ID, invoiceNumber: 'I00099' }]);
    });

    it('requests the logistic_order → invoice join in the usage select (wiring)', async () => {
      mockAuthAs('admin');
      await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));
      const select = mockPrisma.stockMovement.findMany.mock.calls[0][0].select;
      expect(select.logistic_order).toBeDefined();
      expect(select.logistic_order.select.invoice).toBeDefined();
    });

    it('a LINE-born invoice ref outranks the LO anchor (precedence)', async () => {
      mockAuthAs('admin');
      mockPrisma.stockMovement.findMany.mockResolvedValue([
        consumeRow({
          invoice_line_item: { invoice: { id: 'a1b2c3d4-0000-0000-0000-000000000031', invoice_number: 'I00042' } },
          logistic_order: { invoice: { id: LO_INVOICE_ID, invoice_number: 'I00099' } },
        }),
      ]);

      const res = await request(app).get('/api/reports/inventory-usage').set(authHeader('admin'));
      expect(res.body.items[0].invoices).toEqual([
        { id: 'a1b2c3d4-0000-0000-0000-000000000031', invoiceNumber: 'I00042' },
      ]);
    });
  });
});
