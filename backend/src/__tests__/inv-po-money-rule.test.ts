// Purchasing Audit Verdict PR 3 (S3.2) — one money rule.
//
// The client prices a line as `unitCost ?? catalogUnitCost ?? 0`, the same rule
// getJobMaterialCost already applies server-side. For that the PO read contract
// must carry the linked catalog item's unit cost on every line, so no client
// ever joins PO lines to the catalog by SKU again (vendor spend used to).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, PURCHASE_ORDER_FIXTURE, PRICE_BOOK_ITEM_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  purchaseOrder: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

const BASE_LINE = PURCHASE_ORDER_FIXTURE.lines[0]!;

describe('PO line DTO — catalogUnitCost (S3.2 one money rule)', () => {
  it('exposes the linked catalog item unit cost next to the line unit cost', async () => {
    mockAuthAs('admin');
    const po = {
      ...PURCHASE_ORDER_FIXTURE,
      lines: [{
        ...BASE_LINE,
        unit_cost: null,
        price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id,
        price_book_item: { unit_cost: 17.25 },
      }],
    };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const line = res.body.purchaseOrder.lines[0];
    expect(line.unitCost).toBeUndefined();
    expect(line.catalogUnitCost).toBe(17.25);
  });

  it('is null for a line with no linked catalog item', async () => {
    mockAuthAs('admin');
    const po = {
      ...PURCHASE_ORDER_FIXTURE,
      lines: [{ ...BASE_LINE, unit_cost: 20, price_book_item_id: null, price_book_item: null }],
    };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.body.purchaseOrder.lines[0].unitCost).toBe(20);
    expect(res.body.purchaseOrder.lines[0].catalogUnitCost).toBeNull();
  });

  it('is null when the catalog item itself has no unit cost', async () => {
    mockAuthAs('admin');
    const po = {
      ...PURCHASE_ORDER_FIXTURE,
      lines: [{ ...BASE_LINE, unit_cost: null, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, price_book_item: { unit_cost: null } }],
    };
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(po);
    const res = await request(app).get(`/api/inventory/purchase-orders/${po.id}`).set(authHeader('admin'));
    expect(res.body.purchaseOrder.lines[0].catalogUnitCost).toBeNull();
  });

  it('the list and detail queries both ask Prisma for the catalog unit cost', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);

    await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));
    await request(app).get(`/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`).set(authHeader('admin'));

    const listInclude = mockPrisma.purchaseOrder.findMany.mock.calls[0][0].include;
    const detailInclude = mockPrisma.purchaseOrder.findFirst.mock.calls[0][0].include;
    for (const include of [listInclude, detailInclude]) {
      expect(include.lines.include.price_book_item.select.unit_cost).toBe(true);
    }
  });

  it('a list row whose lines were fetched without the relation still serializes (null, never a crash)', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([
      { ...PURCHASE_ORDER_FIXTURE, lines: [{ ...BASE_LINE }] },
    ]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders[0].lines[0].catalogUnitCost).toBeNull();
  });
});
