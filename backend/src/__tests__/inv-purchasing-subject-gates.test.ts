import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, authHeader, JOB_FIXTURE, PURCHASE_ORDER_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Purchasing gates (Roles & Permissions S01.9 and S07.19). Everything purchasing-shaped gates on the `PurchaseOrder`
// subject and everything vendor-shaped on `Vendor`, and each subject's four verbs are four switches: View, Create,
// Edit and Delete purchase orders, and View, Create, Edit and Delete vendors. A person gets exactly the verbs their
// switches give them; the role they are based on decides nothing, so every case builds its person from a switch set.
// The real-database proof of the same gates is permission-inventory-db.test.ts (the table of server checks) and
// permission-purchasing-db.test.ts (what each answer carries).

const mockPrisma = prisma as unknown as {
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  purchaseOrder: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  purchaseOrderLine: { findMany: ReturnType<typeof vi.fn> };
  jobStageLine: { findMany: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  stockBalance: { findMany: ReturnType<typeof vi.fn> };
  vendor: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const PO_PAYLOAD = {
  poNumber: 'PO-9001', vendor: 'Acme', status: 'draft',
  lines: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }],
};
const RES_ID = 'ee000000-0000-0000-0000-000000000001';
const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

/** Every purchasing and vendor switch off; a case turns on the ones it names. */
const NONE = {
  view_purchase_orders: false, create_purchase_orders: false, edit_purchase_orders: false, delete_purchase_orders: false,
  view_vendors: false, create_vendors: false, edit_vendors: false, delete_vendors: false,
};

/** A person holding exactly these purchasing switches (and the reads on jobs they need to reach an order). */
function personWith(values: Partial<Record<keyof typeof NONE, boolean>>) {
  mockAuthAs('dispatcher');
  mockRoleSwitches({ ...NONE, ...values });
  return authHeader('dispatcher');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // P0 §A: createPurchaseOrder allocates its number inside a transaction.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('View purchase orders opens the purchase-order reads, and nothing else does', () => {
  const reads: [string, string][] = [
    ['the list', '/api/inventory/purchase-orders'],
    ['the low-stock proposals', '/api/inventory/purchase-orders/low-stock-proposals'],
    ['a job\'s material cost', `/api/inventory/jobs/${JOB_FIXTURE.id}/material-cost`],
  ];

  beforeEach(() => {
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
  });

  it.each(reads)('lets a person with it read %s', async (_name, path) => {
    const res = await request(app).get(path).set(personWith({ view_purchase_orders: true }));
    expect(res.status).toBe(200);
  });

  it.each(reads)('refuses %s to a person without it, whatever else they hold', async (_name, path) => {
    const res = await request(app).get(path).set(personWith({
      view_vendors: true, create_purchase_orders: true, edit_purchase_orders: true, delete_purchase_orders: true,
    }));
    expect(res.status).toBe(403);
  });
});

describe('Create, Edit and Delete purchase orders open one verb each', () => {
  beforeEach(() => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.purchaseOrder.create.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
  });

  it('Create purchase orders opens the create route and nothing that edits or deletes', async () => {
    const asCreator = personWith({ view_purchase_orders: true, create_purchase_orders: true });
    expect((await request(app).post('/api/inventory/purchase-orders').set(asCreator).send(PO_PAYLOAD)).status).toBe(201);
    expect((await request(app).patch(`/api/inventory/purchase-orders/${RES_ID}`).set(asCreator).send({})).status).toBe(403);
    expect((await request(app).delete(`/api/inventory/purchase-orders/${RES_ID}`).set(asCreator)).status).toBe(403);
  });

  it('refuses a create, and the create from a job, without Create purchase orders', async () => {
    const asViewer = personWith({ view_purchase_orders: true, edit_purchase_orders: true, delete_purchase_orders: true });
    expect((await request(app).post('/api/inventory/purchase-orders').set(asViewer).send(PO_PAYLOAD)).status).toBe(403);
    const fromJob = await request(app).post('/api/inventory/purchase-orders/from-job')
      .set(asViewer).send({ jobId: VALID_JOB_ID, lines: [{ priceBookItemId: VALID_JOB_ID, qty: 1 }] });
    expect(fromJob.status).toBe(403);
  });

  it('Edit purchase orders opens the edit, mark-ordered and receive routes', async () => {
    const asEditor = personWith({ view_purchase_orders: true, edit_purchase_orders: true });
    for (const [method, path] of [
      ['patch', `/api/inventory/purchase-orders/${RES_ID}`],
      ['post', `/api/inventory/purchase-orders/${RES_ID}/mark-ordered`],
      ['post', '/api/inventory/purchase-orders/receive'],
    ] as const) {
      expect((await request(app)[method](path).set(asEditor).send({})).status, path).not.toBe(403);
    }
    const asViewer = personWith({ view_purchase_orders: true });
    for (const [method, path] of [
      ['patch', `/api/inventory/purchase-orders/${RES_ID}`],
      ['post', `/api/inventory/purchase-orders/${RES_ID}/mark-ordered`],
      ['post', '/api/inventory/purchase-orders/receive'],
    ] as const) {
      expect((await request(app)[method](path).set(asViewer).send({})).status, path).toBe(403);
    }
  });

  it('Delete purchase orders opens the delete route', async () => {
    const withDelete = personWith({ view_purchase_orders: true, delete_purchase_orders: true });
    expect((await request(app).delete(`/api/inventory/purchase-orders/${RES_ID}`).set(withDelete)).status).not.toBe(403);
    const without = personWith({ view_purchase_orders: true, create_purchase_orders: true, edit_purchase_orders: true });
    expect((await request(app).delete(`/api/inventory/purchase-orders/${RES_ID}`).set(without)).status).toBe(403);
  });
});

describe('View vendors opens the vendor reads', () => {
  beforeEach(() => {
    mockPrisma.vendor.findMany.mockResolvedValue([]);
  });

  it('lets a person with it read the list', async () => {
    const res = await request(app).get('/api/inventory/vendors').set(personWith({ view_vendors: true }));
    expect(res.status).toBe(200);
  });

  it('refuses the list to a person without it, whatever else they hold', async () => {
    const res = await request(app).get('/api/inventory/vendors').set(personWith({ view_purchase_orders: true }));
    expect(res.status).toBe(403);
  });
});

describe('Create, Edit and Delete vendors open one verb each', () => {
  it('Delete vendors opens the delete route (the retired verb-style path answers 410)', async () => {
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.purchaseOrder.count.mockResolvedValue(0);
    const withDelete = personWith({ view_vendors: true, delete_vendors: true });
    const gone = await request(app).post('/api/inventory/vendors/delete').set(withDelete).send({ id: RES_ID });
    expect(gone.status).toBe(410);
    mockPrisma.vendor.deleteMany.mockResolvedValue({ count: 0 });
    const del = await request(app).delete(`/api/inventory/vendors/${RES_ID}`).set(withDelete);
    expect(del.status).toBe(404); // past the gate, into the handler

    const without = personWith({ view_vendors: true, create_vendors: true, edit_vendors: true });
    expect((await request(app).delete(`/api/inventory/vendors/${RES_ID}`).set(without)).status).toBe(403);
    expect((await request(app).post('/api/inventory/vendors/delete').set(without).send({ id: RES_ID })).status).toBe(403);
  });

  it('the vendor upsert needs Create vendors without an id and Edit vendors with one', async () => {
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    const creator = personWith({ view_vendors: true, create_vendors: true });
    expect((await request(app).post('/api/inventory/vendors').set(creator).send({ id: RES_ID, notes: 'x' })).status).toBe(403);
    const editor = personWith({ view_vendors: true, edit_vendors: true });
    expect((await request(app).post('/api/inventory/vendors').set(editor).send({ name: 'New' })).status).toBe(403);
    // Past the gate into the handler: the vendor named by the id does not exist.
    expect((await request(app).post('/api/inventory/vendors').set(editor).send({ id: RES_ID, notes: 'x' })).status).toBe(404);
  });
});

describe('stored role-permission rows decide nothing', () => {
  // The old purchasing grants were rows on the role. Access now comes only from the person's switches, so a row that
  // still says "read PurchaseOrder" opens nothing for a person whose switch is off.
  it('a stale read row does not open the purchase orders to a person with View purchase orders off', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ view_purchase_orders: false });
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      { role: 'SALES', action: 'read', subject: 'PurchaseOrder' },
      { role: 'SALES', action: 'read', subject: 'Vendor' },
    ]);
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});
