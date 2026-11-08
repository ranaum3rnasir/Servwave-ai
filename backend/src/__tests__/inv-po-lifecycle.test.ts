import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { logAudit } from '../lib/audit';
import { mockAuthAs, authHeader, TEST_USERS, PURCHASE_ORDER_FIXTURE, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Purchasing Audit Verdict PR 2, slice S2.1 — the PO lifecycle API.
//
//   draft → ordered (by hand, dated, attributed) → partial / received (computed or hand-picked)
//         → closed, plus cancelled; free hand movement between statuses; lines frozen outside
//   draft; delete only while nothing has been received; `sent` is gone.

vi.mock('../lib/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

const mockPrisma = prisma as unknown as {
  purchaseOrder: {
    findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn>;
  };
  purchaseOrderLine: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const PO_URL = `/api/inventory/purchase-orders/${PURCHASE_ORDER_FIXTURE.id}`;
const ONE_LINE = [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 5 }];

const DRAFT = { ...PURCHASE_ORDER_FIXTURE, status: 'draft', ordered_at: null, ordered_by_id: null, received_at: null };
const ORDERED = { ...PURCHASE_ORDER_FIXTURE, status: 'ordered', ordered_at: new Date('2026-02-01T00:00:00Z'), ordered_by_id: TEST_USERS.admin.id, received_at: null };
const RECEIVED = { ...ORDERED, status: 'received', received_at: new Date('2026-02-06T00:00:00Z') };

function updateData() {
  return mockPrisma.purchaseOrder.update.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
  // Default echo: the row the handler wrote comes back as-is (mappers only need shape).
  mockPrisma.purchaseOrder.update.mockImplementation(async ({ data }: any) => ({ ...ORDERED, ...data }));
});

// ─── Status vocabulary ───────────────────────────────────────────────────────

describe('status vocabulary — sent is gone, ordered/cancelled are in', () => {
  it('PATCH { status: "sent" } → 400', async () => {
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'sent' });
    expect(res.status).toBe(400);
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('POST create with status "sent" → 400', async () => {
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', status: 'sent', lines: ONE_LINE });
    expect(res.status).toBe(400);
  });

  it.each(['ordered', 'cancelled', 'closed', 'partial', 'received', 'draft'])('PATCH { status: "%s" } is accepted', async (status) => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(status === 'draft' ? ORDERED : DRAFT);
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ status });
    expect(res.status).toBe(200);
    expect(updateData().status).toBe(status);
  });
});

// ─── Creation: "Ordered" never means "created" ────────────────────────────────

describe('POST /purchase-orders — no order date at creation', () => {
  it('a new draft carries ordered_at null and ordered_by_id null, even when the client sends orderedAt', async () => {
    mockPrisma.purchaseOrder.create.mockResolvedValue(DRAFT);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', status: 'draft', orderedAt: '2026-05-01T00:00:00.000Z', lines: ONE_LINE });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.ordered_at).toBeNull();
    expect(data.ordered_by_id).toBeNull();
    expect(res.body.purchaseOrder.orderedAt).toBeNull();
    expect(res.body.purchaseOrder.orderedBy).toBeNull();
  });

  it('an import that says status ordered keeps its orderedAt and is attributed to the importer', async () => {
    mockPrisma.purchaseOrder.create.mockResolvedValue(ORDERED);
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', status: 'ordered', orderedAt: '2026-02-01T00:00:00.000Z', lines: ONE_LINE });
    expect(res.status).toBe(201);
    const data = mockPrisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.ordered_at).toEqual(new Date('2026-02-01T00:00:00.000Z'));
    expect(data.ordered_by_id).toBe(TEST_USERS.admin.id);
  });

  it('persists notes on create', async () => {
    mockPrisma.purchaseOrder.create.mockResolvedValue({ ...DRAFT, notes: 'Deliver to the back dock' });
    const res = await request(app).post('/api/inventory/purchase-orders').set(authHeader('admin'))
      .send({ vendor: 'Acme', notes: 'Deliver to the back dock', lines: ONE_LINE });
    expect(res.status).toBe(201);
    expect(mockPrisma.purchaseOrder.create.mock.calls[0][0].data.notes).toBe('Deliver to the back dock');
    expect(res.body.purchaseOrder.notes).toBe('Deliver to the back dock');
  });

  it('list sorts by created_at desc (drafts have no ordered_at to sort on)', async () => {
    mockPrisma.purchaseOrder.findMany.mockResolvedValue([]);
    await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));
    expect(mockPrisma.purchaseOrder.findMany.mock.calls[0][0].orderBy).toEqual({ created_at: 'desc' });
  });
});

// ─── DTO ─────────────────────────────────────────────────────────────────────

describe('PO read contract — lifecycle fields', () => {
  it('emits orderedAt/orderedBy/receivedAt/leadTimeDays/notes/signature*/createdAt', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({
      ...RECEIVED,
      ordered_by: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin', email: 'admin@test.com' },
      notes: 'Gate code 4321',
      signature_data: 'data:image/png;base64,AAA', signature_name: 'Test Admin', signature_at: new Date('2026-02-02T09:00:00Z'),
      created_at: new Date('2026-01-31T00:00:00Z'),
    });
    const res = await request(app).get(PO_URL).set(authHeader('admin'));
    expect(res.status).toBe(200);
    const po = res.body.purchaseOrder;
    expect(po.orderedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(po.orderedBy).toEqual({ id: TEST_USERS.admin.id, name: 'Test Admin' });
    expect(po.receivedAt).toBe('2026-02-06T00:00:00.000Z');
    expect(po.leadTimeDays).toBe(5);
    expect(po.notes).toBe('Gate code 4321');
    expect(po.signatureData).toBe('data:image/png;base64,AAA');
    expect(po.signatureName).toBe('Test Admin');
    expect(po.signatureAt).toBe('2026-02-02T09:00:00.000Z');
    expect(po.createdAt).toBe('2026-01-31T00:00:00.000Z');
  });

  it('leadTimeDays is null when either date is missing; orderedBy null when unattributed', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...ORDERED, ordered_by: null });
    const res = await request(app).get(PO_URL).set(authHeader('admin'));
    expect(res.body.purchaseOrder.leadTimeDays).toBeNull();
    expect(res.body.purchaseOrder.receivedAt).toBeNull();
    expect(res.body.purchaseOrder.orderedBy).toBeNull();
    expect(res.body.purchaseOrder.signatureAt).toBeNull();
  });
});

// ─── Mark as ordered ─────────────────────────────────────────────────────────

describe('POST /purchase-orders/:id/mark-ordered', () => {
  it('sets status ordered, ordered_at (default now), ordered_by_id = actor, clears received_at; audits inventory.po_ordered', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(DRAFT);
    const before = Date.now();
    const res = await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    const data = updateData();
    expect(data.status).toBe('ordered');
    expect(data.ordered_by_id).toBe(TEST_USERS.admin.id);
    expect(data.received_at).toBeNull();
    expect(data.ordered_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(res.body.purchaseOrder.status).toBe('ordered');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.po_ordered', resourceType: 'PurchaseOrder', resourceId: PURCHASE_ORDER_FIXTURE.id,
      metadata: expect.objectContaining({ status_from: 'draft' }),
    }));
  });

  it('honours a client-supplied (back-dated) orderedAt', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(DRAFT);
    const res = await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('admin'))
      .send({ orderedAt: '2026-01-15T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(updateData().ordered_at).toEqual(new Date('2026-01-15T00:00:00.000Z'));
  });

  it('409 PO_ALREADY_ORDERED when the PO is already ordered', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('admin')).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_ALREADY_ORDERED');
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('is allowed from any other status (e.g. cancelled back to ordered)', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...DRAFT, status: 'cancelled' });
    const res = await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
  });

  it('404 for a PO outside the org and 404 for a malformed id', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    expect((await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('admin')).send({})).status).toBe(404);
    expect((await request(app).post('/api/inventory/purchase-orders/not-a-uuid/mark-ordered').set(authHeader('admin')).send({})).status).toBe(404);
  });

  it('SALES is refused at the gate (update PurchaseOrder)', async () => {
    mockAuthAs('sales');
    const res = await request(app).post(`${PO_URL}/mark-ordered`).set(authHeader('sales')).send({});
    expect(res.status).toBe(403);
  });
});

// ─── PATCH: free movement with side effects ──────────────────────────────────

describe('PATCH /purchase-orders/:id — status side effects', () => {
  it('entering received stamps received_at once', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'received' });
    expect(res.status).toBe(200);
    expect(updateData().received_at).toBeInstanceOf(Date);
    expect(res.body.purchaseOrder.receivedAt).toEqual(expect.any(String));
  });

  it('does not re-stamp received_at when it is already set (closed → received keeps the original date)', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...RECEIVED, status: 'closed' });
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'received' });
    expect(updateData()).not.toHaveProperty('received_at');
  });

  it.each(['ordered', 'partial', 'draft'])('moving a received PO back to %s clears received_at', async (status) => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(RECEIVED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ status });
    expect(res.status).toBe(200);
    expect(updateData().received_at).toBeNull();
    expect(res.body.purchaseOrder.receivedAt).toBeNull();
  });

  it('closing or cancelling a received PO keeps its received_at', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(RECEIVED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'closed' });
    expect(updateData()).not.toHaveProperty('received_at');
    vi.clearAllMocks();
    mockPrisma.purchaseOrder.update.mockImplementation(async ({ data }: any) => ({ ...RECEIVED, ...data }));
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(RECEIVED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'cancelled' });
    expect(updateData()).not.toHaveProperty('received_at');
  });

  it('hand-picking ordered on a never-ordered draft stamps ordered_at + actor', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(DRAFT);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'ordered' });
    const data = updateData();
    expect(data.ordered_at).toBeInstanceOf(Date);
    expect(data.ordered_by_id).toBe(TEST_USERS.admin.id);
  });

  it('hand-picking ordered on a PO that already has an order date leaves it alone', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(RECEIVED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'ordered' });
    expect(updateData()).not.toHaveProperty('ordered_at');
  });

  it('moving back to draft clears ordered_at and ordered_by_id (a draft is not ordered)', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'draft' });
    expect(updateData().ordered_at).toBeNull();
    expect(updateData().ordered_by_id).toBeNull();
  });

  it('a status change is audited with status_from / status_to; a same-status PATCH is not a change', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'cancelled' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'inventory.po_updated',
      metadata: expect.objectContaining({ status_from: 'ordered', status_to: 'cancelled' }),
    }));
    vi.clearAllMocks();
    mockPrisma.purchaseOrder.update.mockImplementation(async ({ data }: any) => ({ ...ORDERED, ...data }));
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'ordered', notes: 'x' });
    expect(updateData()).not.toHaveProperty('status');
    const meta = (logAudit as any).mock.calls[0][0].metadata;
    expect(meta).not.toHaveProperty('status_from');
  });

  it('writes the job timeline PO_RECEIVED event only on an actual move into received', async () => {
    const JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...ORDERED, job_id: JOB_ID });
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'received' });
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    mockPrisma.purchaseOrder.update.mockImplementation(async ({ data }: any) => ({ ...RECEIVED, ...data }));
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...RECEIVED, job_id: JOB_ID });
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'received', notes: 'no change' });
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /purchase-orders/:id — lines are frozen outside draft', () => {
  it('409 PO_LINES_FROZEN on an ordered PO, before any write', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ lines: ONE_LINE });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_LINES_FROZEN');
    expect(mockPrisma.purchaseOrderLine.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('is judged on the STORED status: sending status draft alongside lines does not unfreeze', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ status: 'draft', lines: ONE_LINE });
    expect(res.status).toBe(409);
  });

  it('a draft still accepts line edits', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(DRAFT);
    mockPrisma.purchaseOrder.update.mockResolvedValue(DRAFT); // the nested-create payload is not a row
    const res = await request(app).patch(PO_URL).set(authHeader('admin')).send({ lines: ONE_LINE });
    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrderLine.deleteMany).toHaveBeenCalled();
    expect(updateData().lines.create).toHaveLength(1);
  });

  it('header fields (expectedDate, notes) stay editable on an ordered PO', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin'))
      .send({ expectedDate: '2026-03-01T00:00:00.000Z', notes: 'Call before delivery' });
    expect(res.status).toBe(200);
    expect(updateData().expected_date).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(updateData().notes).toBe('Call before delivery');
  });
});

describe('PATCH /purchase-orders/:id — buyer signature', () => {
  it('signing stores data + name and the SERVER stamps signature_at', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    const res = await request(app).patch(PO_URL).set(authHeader('admin'))
      .send({ signatureData: 'data:image/png;base64,AAA', signatureName: 'Dana Buyer' });
    expect(res.status).toBe(200);
    const data = updateData();
    expect(data.signature_data).toBe('data:image/png;base64,AAA');
    expect(data.signature_name).toBe('Dana Buyer');
    expect(data.signature_at).toBeInstanceOf(Date);
    expect(res.body.purchaseOrder.signatureAt).toEqual(expect.any(String));
  });

  it('defaults the name to the actor when omitted', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(ORDERED);
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ signatureData: 'data:image/png;base64,AAA' });
    expect(updateData().signature_name).toBe('Test Admin');
  });

  it('clearing signatureData clears all three', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...ORDERED, signature_data: 'x', signature_name: 'y', signature_at: new Date() });
    await request(app).patch(PO_URL).set(authHeader('admin')).send({ signatureData: null });
    const data = updateData();
    expect(data.signature_data).toBeNull();
    expect(data.signature_name).toBeNull();
    expect(data.signature_at).toBeNull();
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /purchase-orders/:id', () => {
  const NO_RECEIPT_LINES = [{ qty_received: 0 }, { qty_received: 0 }];

  it.each(['draft', 'ordered', 'cancelled'])('204 for a %s PO with nothing received; audits inventory.po_deleted', async (status) => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...DRAFT, status, lines: NO_RECEIPT_LINES });
    mockPrisma.purchaseOrder.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(PO_URL).set(authHeader('admin'));
    expect(res.status).toBe(204);
    expect(mockPrisma.purchaseOrder.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: PURCHASE_ORDER_FIXTURE.id }) }),
    );
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory.po_deleted', resourceId: PURCHASE_ORDER_FIXTURE.id }));
  });

  it.each(['partial', 'received', 'closed'])('409 PO_HAS_RECEIPTS for a %s PO', async (status) => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...ORDERED, status, lines: [{ qty_received: 2 }] });
    const res = await request(app).delete(PO_URL).set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_HAS_RECEIPTS');
    expect(mockPrisma.purchaseOrder.deleteMany).not.toHaveBeenCalled();
  });

  it('409 PO_HAS_RECEIPTS when the status says ordered but a line has qty_received > 0', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...ORDERED, lines: [{ qty_received: 0 }, { qty_received: 1 }] });
    const res = await request(app).delete(PO_URL).set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_HAS_RECEIPTS');
  });

  it('404 outside the org; 404 malformed id; SALES 403 (delete PurchaseOrder gate)', async () => {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    expect((await request(app).delete(PO_URL).set(authHeader('admin'))).status).toBe(404);
    expect((await request(app).delete('/api/inventory/purchase-orders/nope').set(authHeader('admin'))).status).toBe(404);
    mockAuthAs('sales');
    expect((await request(app).delete(PO_URL).set(authHeader('sales'))).status).toBe(403);
    expect(mockPrisma.purchaseOrder.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── recomputePoStatus through the receive path ──────────────────────────────

describe('receive → recompute: a receipt corrected back to zero is never "partial"', () => {
  function mockReceive(po: any, linesAfter: any[]) {
    mockPrisma.purchaseOrder.findFirst.mockResolvedValueOnce(po).mockResolvedValueOnce({ ...po, lines: linesAfter });
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue(linesAfter);
  }
  const LINE = PURCHASE_ORDER_FIXTURE.lines[0];

  it('all lines back to 0 on a PO that was ordered → status ordered, received_at cleared', async () => {
    const po = { ...RECEIVED, status: 'partial', lines: [{ ...LINE, qty_received: 2 }] };
    mockReceive(po, [{ ...LINE, qty_received: 0 }]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 0 }] });
    expect(res.status).toBe(200);
    const upd = mockPrisma.purchaseOrder.update.mock.calls.find((c) => c[0].where.id === po.id)![0];
    expect(upd.data).toEqual({ status: 'ordered', received_at: null });
  });

  it('all lines back to 0 on a PO that was never ordered → status draft', async () => {
    const po = { ...DRAFT, status: 'partial', lines: [{ ...LINE, qty_received: 2 }] };
    mockReceive(po, [{ ...LINE, qty_received: 0 }]);
    const res = await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 0 }] });
    expect(res.status).toBe(200);
    const upd = mockPrisma.purchaseOrder.update.mock.calls.find((c) => c[0].where.id === po.id)![0];
    expect(upd.data.status).toBe('draft');
  });

  it('receiving everything stamps received_at (once)', async () => {
    const po = { ...ORDERED, lines: [{ ...LINE, qty_received: 0 }] };
    mockReceive(po, [{ ...LINE, qty_received: 5 }]);
    await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 5 }] });
    const upd = mockPrisma.purchaseOrder.update.mock.calls.find((c) => c[0].where.id === po.id)![0];
    expect(upd.data.status).toBe('received');
    expect(upd.data.received_at).toBeInstanceOf(Date);
  });

  it('a partial receipt on an already-received PO clears received_at', async () => {
    const po = { ...RECEIVED, lines: [{ ...LINE, qty_received: 5 }] };
    mockReceive(po, [{ ...LINE, qty_received: 3 }]);
    await request(app).post('/api/inventory/purchase-orders/receive').set(authHeader('admin'))
      .send({ poId: po.id, lines: [{ lineId: LINE.id, qtyReceived: 3 }] });
    const upd = mockPrisma.purchaseOrder.update.mock.calls.find((c) => c[0].where.id === po.id)![0];
    expect(upd.data).toEqual({ status: 'partial', received_at: null });
  });
});

// ─── Reservations are gone (R10) ─────────────────────────────────────────────

describe('estimate reservations — removed', () => {
  it.each([
    ['get', '/api/inventory/estimate-reservations'],
    ['post', '/api/inventory/estimate-reservations'],
    ['get', '/api/inventory/estimate-reservations/aaaaaac1-0000-0000-0000-000000000001'],
    ['post', '/api/inventory/estimate-reservations/aaaaaac1-0000-0000-0000-000000000001/convert'],
    ['post', '/api/inventory/estimate-reservations/aaaaaac1-0000-0000-0000-000000000001/dismiss'],
  ])('%s %s → 404', async (method, url) => {
    const res = await (request(app) as any)[method](url).set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});
