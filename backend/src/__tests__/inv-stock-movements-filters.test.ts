/**
 * inv-stock-movements-filters.test.ts — P5 §2.1: enriched movements ledger (Action log)
 *
 * Contract change: GET /movements returns {data,meta} (was {movements}); adds
 * type/item_id/location_id/job_id/actor_user_id/occurred_from+to filters,
 * occurred_at-desc default sort, server-joined display names
 * (fromLocationName/toLocationName/jobNumber/invoiceNumber), and a
 * canSeePricing-gated unitCost (strip-by-omission, mirroring
 * job-lines-pricing-leak.test.ts / stripMappedItemCost).
 *
 * Harness: supertest against app, prisma fully mocked (setup.ts), grants via
 * setCachedGrants for the leak test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, PRICE_BOOK_ITEM_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { setCachedGrants, clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  stockMovement: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

const MOVEMENT_ID = 'dddddddd-0000-0000-0000-000000000001';
const JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000021';
const INVOICE_ID = 'a1b2c3d4-0000-0000-0000-000000000031';
const LOCATION_2_ID = 'aaaaaaa1-0000-0000-0000-000000000002';
// §14 H2 / E26 — LO drill-through fixtures.
const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000001';
const LO_LINE_ID = 'bbbbbbb2-0000-0000-0000-000000000001';
const LO_INVOICE_ID = 'cccccccc-0000-0000-0000-000000000009';

function movementRow(over: Record<string, unknown> = {}) {
  return {
    id: MOVEMENT_ID,
    occurred_at: new Date('2026-07-01T10:00:00Z'),
    item_sku: 'LOCK-100',
    item_name: 'Deadbolt Lock',
    type: 'consume',
    qty: '2.50',
    from_location_id: INVENTORY_LOCATION_FIXTURE.id,
    to_location_id: null,
    reference: 'J00001',
    actor: 'Test Admin',
    item_id: PRICE_BOOK_ITEM_FIXTURE.id,
    job_id: JOB_ID,
    job_line_item_id: null,
    invoice_line_item_id: null,
    unit_cost: '12.50',
    actor_user_id: TEST_USERS.admin.id,
    organization_id: ALPHA_ORG_ID,
    from_location: { id: INVENTORY_LOCATION_FIXTURE.id, name: 'Main Warehouse' },
    to_location: null,
    job: { id: JOB_ID, job_number: 'J00001' },
    invoice_line_item: { invoice: { id: INVOICE_ID, invoice_number: 'I00042' } },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.stockMovement.findMany.mockResolvedValue([]);
  mockPrisma.stockMovement.count.mockResolvedValue(0);
});

const lastWhere = () => mockPrisma.stockMovement.findMany.mock.calls.at(-1)![0].where;

describe('GET /api/inventory/movements — {data,meta} + filters', () => {
  it('returns the {data,meta} envelope with occurred_at desc default sort and tenant scoping', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([movementRow()]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 });
    const args = mockPrisma.stockMovement.findMany.mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    // SRVW-89 - parseSortParams now always returns an orderBy array.
    expect(args.orderBy).toEqual([{ occurred_at: 'desc' }]);
    expect(args.skip).toBe(0);
    expect(args.take).toBe(25);
  });

  it('keeps every pre-P5 mapper key (back-compat for the item panel)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([movementRow()]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    const m = res.body.data[0];
    expect(m).toMatchObject({
      id: MOVEMENT_ID,
      occurredAt: '2026-07-01T10:00:00.000Z',
      itemSku: 'LOCK-100',
      itemName: 'Deadbolt Lock',
      type: 'consume',
      qty: 2.5,
      fromLocationId: INVENTORY_LOCATION_FIXTURE.id,
      reference: 'J00001',
      actor: 'Test Admin',
    });
  });

  it('joins display names + ids server-side (fromLocationName/jobNumber/invoiceNumber/actorUserId)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([
      movementRow({
        type: 'transfer',
        to_location_id: LOCATION_2_ID,
        to_location: { id: LOCATION_2_ID, name: 'Van 2' },
      }),
    ]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    const m = res.body.data[0];
    expect(m.itemId).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
    expect(m.jobId).toBe(JOB_ID);
    expect(m.jobNumber).toBe('J00001');
    expect(m.invoiceId).toBe(INVOICE_ID);
    expect(m.invoiceNumber).toBe('I00042');
    expect(m.fromLocationName).toBe('Main Warehouse');
    expect(m.toLocationName).toBe('Van 2');
    expect(m.actorUserId).toBe(TEST_USERS.admin.id);
  });

  it('narrows by type / item_id / job_id / actor_user_id', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/inventory/movements?type=consume').set(authHeader('admin'));
    expect(lastWhere().type).toBe('consume');

    await request(app).get(`/api/inventory/movements?item_id=${PRICE_BOOK_ITEM_FIXTURE.id}`).set(authHeader('admin'));
    expect(lastWhere().item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);

    await request(app).get(`/api/inventory/movements?job_id=${JOB_ID}`).set(authHeader('admin'));
    expect(lastWhere().job_id).toBe(JOB_ID);

    await request(app).get(`/api/inventory/movements?actor_user_id=${TEST_USERS.admin.id}`).set(authHeader('admin'));
    expect(lastWhere().actor_user_id).toBe(TEST_USERS.admin.id);
  });

  it('location_id matches EITHER side of the movement (from OR to)', async () => {
    mockAuthAs('admin');
    await request(app).get(`/api/inventory/movements?location_id=${INVENTORY_LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(lastWhere().OR).toEqual([
      { from_location_id: INVENTORY_LOCATION_FIXTURE.id },
      { to_location_id: INVENTORY_LOCATION_FIXTURE.id },
    ]);
  });

  it('applies occurred_from/occurred_to as an occurred_at gte/lte range', async () => {
    mockAuthAs('admin');
    await request(app)
      .get('/api/inventory/movements?occurred_from=2026-07-01&occurred_to=2026-07-15')
      .set(authHeader('admin'));
    const where = lastWhere();
    expect(where.occurred_at.gte).toEqual(new Date('2026-07-01'));
    // A date-only `occurred_to` names a WHOLE day, so the upper bound runs to its
    // end (inclusiveEndOfDay). The lower bound stays at midnight — already inclusive.
    expect(where.occurred_at.lte).toEqual(new Date('2026-07-15T23:59:59.999Z'));
  });

  it('a date-only `occurred_to` includes that whole day', async () => {
    mockAuthAs('admin');
    await request(app)
      .get('/api/inventory/movements?occurred_to=2026-07-21')
      .set(authHeader('admin'));

    const { lte } = mockPrisma.stockMovement.findMany.mock.calls[0][0].where.occurred_at;
    expect(lte.toISOString()).toBe('2026-07-21T23:59:59.999Z');
  });

  it('rejects invalid query params with 400 (bad uuid, unknown type, garbage date)', async () => {
    mockAuthAs('admin');
    expect((await request(app).get('/api/inventory/movements?item_id=nope').set(authHeader('admin'))).status).toBe(400);
    expect((await request(app).get('/api/inventory/movements?type=teleport').set(authHeader('admin'))).status).toBe(400);
    expect((await request(app).get('/api/inventory/movements?occurred_from=garbage').set(authHeader('admin'))).status).toBe(400);
    expect(mockPrisma.stockMovement.findMany).not.toHaveBeenCalled();
  });

  // ── Cost leak (pattern: job-lines-pricing-leak.test.ts) ────────────────────
  it('includes unitCost for a requester who can read Invoice (admin)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([movementRow()]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    expect(res.body.data[0].unitCost).toBe(12.5);
  });

  it('OMITS the unitCost key entirely for read-Inventory-without-read-Invoice (strip-by-omission)', async () => {
    mockAuthAs('technician');
    // read Inventory grant WITHOUT read Invoice — can list movements, must not see cost.
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Inventory' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockPrisma.stockMovement.findMany.mockResolvedValue([movementRow()]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect('unitCost' in res.body.data[0]).toBe(false);
    // Non-cost enrichment still present
    expect(res.body.data[0].fromLocationName).toBe('Main Warehouse');
  });
});

describe('GET /api/inventory/movements/:id — same enrichment + cost gate, {movement} envelope kept', () => {
  it('returns {movement} with joined names and unitCost for admin', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findFirst.mockResolvedValue(movementRow());

    const res = await request(app).get(`/api/inventory/movements/${MOVEMENT_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.movement.jobNumber).toBe('J00001');
    expect(res.body.movement.unitCost).toBe(12.5);
  });

  it('strips unitCost for a non-pricing requester', async () => {
    mockAuthAs('technician');
    setCachedGrants(ALPHA_ORG_ID, 'TECHNICIAN', [
      { action: 'read', subject: 'Inventory' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockPrisma.stockMovement.findFirst.mockResolvedValue(movementRow());

    const res = await request(app).get(`/api/inventory/movements/${MOVEMENT_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect('unitCost' in res.body.movement).toBe(false);
  });
});

// ── E26 / §14 H2: LO drill-through (mapMovement + movementInclude) ────────────
//
// A PROCESSED LO's consume movement carries NO invoice_line_item — its invoice attribution rides
// the LO's OWN invoice anchor (H2). The mock harness returns the row verbatim (Prisma does not
// execute the `include` against a DB here), so these tests pin two distinct things:
//   1. the MAPPER surfaces logisticOrderId/Number/LineId + the LO-anchored invoice, and
//   2. the read route REQUESTS the logistic_order join (movementInclude wiring, with invoice nested).
// The include→DB join itself is only exercisable in an integration/e2e DB test — documented for QA.
describe('GET /api/inventory/movements — E26 LO drill-through (H2)', () => {
  function loIssuedRow(over: Record<string, unknown> = {}) {
    return movementRow({
      reference: 'LO-J00001-1',
      invoice_line_item: null, // LO-issued: no invoice LINE
      logistic_order_id: LO_ID,
      logistic_order_line_id: LO_LINE_ID,
      logistic_order: {
        id: LO_ID,
        number: 'LO-J00001-1',
        invoice: { id: LO_INVOICE_ID, invoice_number: 'I00099' },
      },
      ...over,
    });
  }

  it('surfaces logisticOrderId/Number/LineId and the LO-anchored invoice attribution', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([loIssuedRow()]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    const m = res.body.data[0];
    expect(m.logisticOrderId).toBe(LO_ID);
    expect(m.logisticOrderNumber).toBe('LO-J00001-1');
    expect(m.logisticOrderLineId).toBe(LO_LINE_ID);
    // H2: an LO-issued movement has no invoice LINE, so invoice attribution rides the LO's anchor.
    expect(m.invoiceId).toBe(LO_INVOICE_ID);
    expect(m.invoiceNumber).toBe('I00099');
  });

  it('requests the logistic_order join with the nested invoice (movementInclude wiring)', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findMany.mockResolvedValue([]);
    mockPrisma.stockMovement.count.mockResolvedValue(0);

    await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    const include = mockPrisma.stockMovement.findMany.mock.calls[0][0].include;
    expect(include.logistic_order).toBeDefined();
    expect(include.logistic_order.select.number).toBe(true);
    // The nested invoice is what keeps INVOICE attribution alive for LO-issued movements (H2).
    expect(include.logistic_order.select.invoice).toBeDefined();
  });

  it('a LINE-born invoice ref outranks the LO anchor (precedence)', async () => {
    mockAuthAs('admin');
    // Both present → the invoice_line_item ref wins (line-born movements keep the higher-precedence ref).
    mockPrisma.stockMovement.findMany.mockResolvedValue([
      loIssuedRow({ invoice_line_item: { invoice: { id: INVOICE_ID, invoice_number: 'I00042' } } }),
    ]);
    mockPrisma.stockMovement.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/movements').set(authHeader('admin'));
    expect(res.body.data[0].invoiceId).toBe(INVOICE_ID);
    expect(res.body.data[0].invoiceNumber).toBe('I00042');
  });

  it('surfaces the LO drill-through on the single-movement read too', async () => {
    mockAuthAs('admin');
    mockPrisma.stockMovement.findFirst.mockResolvedValue(loIssuedRow());

    const res = await request(app).get(`/api/inventory/movements/${MOVEMENT_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.movement.logisticOrderNumber).toBe('LO-J00001-1');
    expect(res.body.movement.logisticOrderLineId).toBe(LO_LINE_ID);
    expect(res.body.movement.invoiceId).toBe(LO_INVOICE_ID);
    expect(res.body.movement.invoiceNumber).toBe('I00099');
    // getMovement passes the same include.
    expect(mockPrisma.stockMovement.findFirst.mock.calls[0][0].include.logistic_order).toBeDefined();
  });
});
