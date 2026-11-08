import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS, CUSTOMER_FIXTURE, JOB_STAGE_FIXTURE, INVENTORY_LOCATION_FIXTURE, PRICE_BOOK_ITEM_FIXTURE, PURCHASE_ORDER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { sendStagePickupEmail } from '../lib/email';

const mockPrisma = prisma as unknown as {
  jobStage: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  jobStageLine: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  stageAuditEntry: { create: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: { upsert: ReturnType<typeof vi.fn> };
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  purchaseOrderLine: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('POST /api/inventory/job-stages — FK population (V4/P1)', () => {
  // JOB_FIXTURE.id ('j...') is not a hex-valid UUID, which the uuid()-validated
  // jobId field correctly rejects; use a valid UUID for the job in these tests.
  const VALID_JOB_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
  const basePayload = {
    jobNumber: 'J00001', customer: 'John Doe', site: '123 Main St',
    trade: 'locksmith', status: 'awaiting_parts',
  };

  it('writes job_id + customer_id when both exist in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue({ id: VALID_JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue({ ...JOB_STAGE_FIXTURE, job_id: VALID_JOB_ID, customer_id: CUSTOMER_FIXTURE.id });
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, jobId: VALID_JOB_ID, customerId: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(201);
    const data = mockPrisma.jobStage.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(VALID_JOB_ID);
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('rejects a job_id from another org (P1 cross-org FK injection)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findFirst.mockResolvedValue(null); // not in requesting org
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, jobId: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/job/i);
    expect(mockPrisma.jobStage.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inventory/job-stages — unitCost capture (DEC2 cost source)', () => {
  const basePayload = {
    jobNumber: 'J00001', customer: 'John Doe', site: '123 Main St',
    trade: 'locksmith', status: 'awaiting_parts',
  };

  it('persists unit_cost on stage line create (DEC2 cost source)', async () => {
    mockAuthAs('admin');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    await request(app).post('/api/inventory/job-stages').set(authHeader('admin')).send({
      ...basePayload,
      items: [{ itemSku: 'LOCK-100', itemName: 'Deadbolt', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, vendor: 'Acme Supply', unitCost: 22.5 }],
    });
    const createdLines = mockPrisma.jobStage.create.mock.calls[0][0].data.items.create;
    expect(createdLines[0].unit_cost).toBe(22.5);
  });
});

describe('POST /api/inventory/job-stages/receive (B2/V5)', () => {
  void PRICE_BOOK_ITEM_FIXTURE;

  it('increments qty_received and emits a StockMovement (stock-only, no billing)', async () => {
    mockAuthAs('admin');
    const stageLine = JOB_STAGE_FIXTURE.items[0];
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(JOB_STAGE_FIXTURE).mockResolvedValueOnce(JOB_STAGE_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id, itemId: stageLine.id });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobStageLine.update).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).toHaveBeenCalled();
  });

  it('404s when the stage is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: '99999999-9999-9999-9999-999999999999', itemId: '88888888-8888-8888-8888-888888888888' });
    expect(res.status).toBe(404);
  });

  it('threads job_id + unit_cost + actor_user_id into the receive movement', async () => {
    mockAuthAs('admin');
    const jobId = 'a1b2c3d4-0000-0000-0000-000000000031';
    // Fixture line unit_cost = 20; stamp a job_id + resolved price_book_item_id on a variant.
    const stage = {
      ...JOB_STAGE_FIXTURE,
      job_id: jobId,
      items: [{ ...JOB_STAGE_FIXTURE.items[0], price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id }],
    };
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id });
    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(jobId);
    expect(data.unit_cost).toBe(20);
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
  });
});

describe('POST /api/inventory/job-stages/notify (B2)', () => {
  it('marks the stage ready_for_pickup', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    const res = await request(app).post('/api/inventory/job-stages/notify').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id });
    expect(res.status).toBe(200);
    expect(mockPrisma.jobStage.updateMany).toHaveBeenCalled();
    expect(mockPrisma.jobStage.updateMany.mock.calls[0][0].data.status).toBe('ready_for_pickup');
  });

  it('404s when the stage is in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post('/api/inventory/job-stages/notify').set(authHeader('admin'))
      .send({ stageId: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/inventory/job-stages/email — pickup ticket real send ──────────
describe('POST /api/inventory/job-stages/email (pickup ticket)', () => {
  const BRAND = { id: ALPHA_ORG_ID, name: 'Northwind Services', logo_url: null, brand_color: '#0C2D3A' };

  it('sends the pickup ticket to the given recipients + records a StageAuditEntry', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(BRAND);

    const res = await request(app).post('/api/inventory/job-stages/email').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id, to: ['jane.tech@alpha.com'], cc: ['dispatch@alpha.com'], subject: 'Pickup Ticket J00001', message: 'Ready for pickup.' });

    expect(res.status).toBe(200);
    expect(vi.mocked(sendStagePickupEmail)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendStagePickupEmail).mock.calls[0][0];
    expect(args.to).toEqual(['jane.tech@alpha.com']);
    expect(args.cc).toEqual(['dispatch@alpha.com']);
    expect(args.subject).toBe('Pickup Ticket J00001');
    expect(args.jobNumber).toBe('J00001');
    expect(args.lines).toHaveLength(1);
    expect(args.lines[0]).toMatchObject({ sku: 'LOCK-100', qtyOrdered: 3, uom: 'EA' });
    expect(mockPrisma.stageAuditEntry.create).toHaveBeenCalledTimes(1);
    const audit = mockPrisma.stageAuditEntry.create.mock.calls[0][0].data;
    expect(audit.job_stage_id).toBe(JOB_STAGE_FIXTURE.id);
    expect(audit.field).toBe('pickup_email');
    expect(audit.new_value).toContain('jane.tech@alpha.com');
  });

  it('404s when the stage is not in the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/job-stages/email').set(authHeader('admin'))
      .send({ stageId: '99999999-9999-9999-9999-999999999999', to: ['x@y.com'], subject: 'Pickup' });
    expect(res.status).toBe(404);
    expect(vi.mocked(sendStagePickupEmail)).not.toHaveBeenCalled();
  });

  it('400s when there are no recipients', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/inventory/job-stages/email').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id, to: [], subject: 'Pickup' });
    expect(res.status).toBe(400);
  });

  it('502s when the mailer does not send', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findFirst.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(BRAND);
    vi.mocked(sendStagePickupEmail).mockResolvedValueOnce({ status: 'failed', error: 'provider down', subject: 's', html: 'h' });
    const res = await request(app).post('/api/inventory/job-stages/email').set(authHeader('admin'))
      .send({ stageId: JOB_STAGE_FIXTURE.id, to: ['x@y.com'], subject: 'Pickup' });
    expect(res.status).toBe(502);
  });
});

// ─── GET /api/inventory/techs — real email exposure (pickup composer) ────────
describe('GET /api/inventory/techs — real email exposure', () => {
  it('maps each active user\'s real email onto the tech shape', async () => {
    mockAuthAs('admin');
    (mockPrisma as unknown as { user: { findMany: ReturnType<typeof vi.fn> } }).user.findMany.mockResolvedValue([
      { id: 'aaaaaad1-0000-0000-0000-000000000001', first_name: 'Jane', last_name: 'Tech', email: 'jane.tech@alpha.com', role: 'TECHNICIAN', department: { name: 'Field' } },
    ]);
    const res = await request(app).get('/api/inventory/techs').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.techs[0].email).toBe('jane.tech@alpha.com');
  });
});

// ─── GET /api/inventory/job-stages?job_id=<uuid> ─────────────────────────────

const VALID_JOB_ID_FOR_LIST = 'b1b2c3d4-0000-0000-0000-000000000002';

// A stage that belongs to the job we are filtering on (same org)
const STAGE_FOR_JOB = {
  ...JOB_STAGE_FIXTURE,
  id: 'aaaaaab1-0000-0000-0000-000000000001',
  job_id: VALID_JOB_ID_FOR_LIST,
  organization_id: ALPHA_ORG_ID,
  items: [
    {
      id: 'aaaaaab2-0000-0000-0000-000000000001',
      item_sku: 'LOCK-200',
      item_name: 'Padlock',
      uom: 'EA',
      qty_ordered: 5,
      qty_received: 2,
      unit_cost: 15,
      vendor: 'BestLocks',
      po_number: 'PO-2001',
      purchase_order_id: null,
      expected_date: new Date('2026-07-01'),
      serialized: false,
      received_serials: null,
      price_book_item_id: null,
      created_at: new Date('2026-02-01'),
    },
  ],
};

// A stage for a DIFFERENT job, same org — should NOT appear in filtered results
const STAGE_OTHER_JOB = {
  ...JOB_STAGE_FIXTURE,
  id: 'aaaaaab3-0000-0000-0000-000000000003',
  job_id: 'ffffffff-0000-0000-0000-000000000099',
  organization_id: ALPHA_ORG_ID,
};

// A stage for the target job_id but in ORG B — must never be returned (tenant isolation)
const STAGE_ORG_B = {
  ...JOB_STAGE_FIXTURE,
  id: 'aaaaaab4-0000-0000-0000-000000000004',
  job_id: VALID_JOB_ID_FOR_LIST,
  organization_id: ORG_B_ID,
};

describe('GET /api/inventory/job-stages?job_id=<uuid> — per-job filter', () => {
  it('(a) returns only stages matching the given job_id', async () => {
    mockAuthAs('admin');
    // Prisma mock returns the filtered set (mimicking the WHERE job_id=... clause)
    mockPrisma.jobStage.findMany.mockResolvedValue([STAGE_FOR_JOB]);

    const res = await request(app)
      .get(`/api/inventory/job-stages?job_id=${VALID_JOB_ID_FOR_LIST}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobStages).toHaveLength(1);
    expect(res.body.jobStages[0].id).toBe(STAGE_FOR_JOB.id);

    // Verify the Prisma where clause included job_id
    const whereArg = mockPrisma.jobStage.findMany.mock.calls[0][0].where;
    expect(whereArg.job_id).toBe(VALID_JOB_ID_FOR_LIST);
  });

  it('(b) results are tenant-scoped — org_b stage with same job_id is not returned', async () => {
    mockAuthAs('admin'); // authenticated as ALPHA_ORG admin
    // Even if Prisma somehow returned the org-B stage, the WHERE includes organization_id
    mockPrisma.jobStage.findMany.mockResolvedValue([STAGE_FOR_JOB]);

    const res = await request(app)
      .get(`/api/inventory/job-stages?job_id=${VALID_JOB_ID_FOR_LIST}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    // The where clause must include organization_id (tenantWhere)
    const whereArg = mockPrisma.jobStage.findMany.mock.calls[0][0].where;
    expect(whereArg.organization_id).toBe(ALPHA_ORG_ID);

    // Org B stage must not appear in the response
    const ids = (res.body.jobStages as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(STAGE_ORG_B.id);
  });

  it('(c) no job_id param → existing org-wide behavior unchanged', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findMany.mockResolvedValue([STAGE_FOR_JOB, STAGE_OTHER_JOB]);

    const res = await request(app)
      .get('/api/inventory/job-stages')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.jobStages).toHaveLength(2);

    // job_id must NOT be injected into the where clause when param is absent
    const whereArg = mockPrisma.jobStage.findMany.mock.calls[0][0].where;
    expect(whereArg.job_id).toBeUndefined();
    // But tenant scoping must still apply
    expect(whereArg.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('(d) returned stage includes lines with fulfillment fields', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findMany.mockResolvedValue([STAGE_FOR_JOB]);

    const res = await request(app)
      .get(`/api/inventory/job-stages?job_id=${VALID_JOB_ID_FOR_LIST}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const stage = res.body.jobStages[0];
    expect(stage.status).toBeDefined();
    expect(Array.isArray(stage.items)).toBe(true);
    expect(stage.items).toHaveLength(1);

    const line = stage.items[0];
    expect(line).toMatchObject({
      itemSku: 'LOCK-200',
      itemName: 'Padlock',
      qtyOrdered: 5,
      qtyReceived: 2,
      vendor: 'BestLocks',
      poNumber: 'PO-2001',
    });
    expect(line.expectedDate).toBeDefined(); // ISO string from the Date field
  });

  it('(e) invalid (non-uuid) job_id returns 400', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/inventory/job-stages?job_id=not-a-uuid')
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });
});

// ─── P2 4c: stage-from-PO linkage (server-side, atomic claim) ────────────────

describe('POST /api/inventory/job-stages — stagedFromPurchaseOrderId (P2 4c)', () => {
  const PO_ID = 'aaaaaaa4-0000-0000-0000-000000000021';
  const basePayload = {
    jobNumber: 'J00001', customer: 'John Doe', site: '123 Main St',
    trade: 'locksmith', status: 'awaiting_parts',
  };
  const STAGEABLE_PO = {
    id: PO_ID, po_number: 'PO-1001', vendor: 'Acme Supply', status: 'ordered',
    job_id: null, customer_id: null, staged_as_job_stage_id: null,
    expected_date: new Date('2026-03-01'), organization_id: ALPHA_ORG_ID,
    lines: [
      { id: 'aaaaaaa5-0000-0000-0000-000000000021', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock', uom: 'EA', qty_ordered: 5, qty_received: 1, unit_cost: 20, price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id, created_at: new Date('2026-02-01') },
      { id: 'aaaaaaa5-0000-0000-0000-000000000022', item_sku: 'WIRE-12', item_name: 'Wire', uom: 'FT', qty_ordered: 10, qty_received: 0, unit_cost: 1, price_book_item_id: null, created_at: new Date('2026-02-01') },
    ],
  };

  it('copies ALL PO lines server-side (ignoring client items) and claims the PO atomically', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(STAGEABLE_PO);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({
        ...basePayload,
        stagedFromPurchaseOrderId: PO_ID,
        // Client items must be IGNORED on the staged path (line set cannot drift).
        items: [{ itemSku: 'JUNK-1', itemName: 'Junk', uom: 'EA', qtyOrdered: 99, qtyReceived: 0, vendor: 'X' }],
      });

    expect(res.status).toBe(201);
    const items = mockPrisma.jobStage.create.mock.calls[0][0].data.items.create;
    expect(items).toHaveLength(2);
    expect(items[0].purchase_order_id).toBe(PO_ID);
    expect(items[0].po_number).toBe('PO-1001');
    expect(items[0].item_sku).toBe('LOCK-100');
    expect(items[0].qty_received).toBe(1); // lockstep from t0 with the PO line
    expect(items[0].price_book_item_id).toBe(PRICE_BOOK_ITEM_FIXTURE.id);
    expect(items.some((i: any) => i.item_sku === 'JUNK-1')).toBe(false);

    // Atomic claim: only an unstaged PO row accepts the stage id.
    const claim = mockPrisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: PO_ID, staged_as_job_stage_id: null });
    expect(claim.data.staged_as_job_stage_id).toBe(JOB_STAGE_FIXTURE.id);
  });

  it('409 PO_ALREADY_STAGED when the PO is already staged', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...STAGEABLE_PO, staged_as_job_stage_id: JOB_STAGE_FIXTURE.id });
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, stagedFromPurchaseOrderId: PO_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_ALREADY_STAGED');
    expect(mockPrisma.jobStage.create).not.toHaveBeenCalled();
  });

  it('409 PO_ALREADY_STAGED when the atomic claim loses the race (count 0)', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(STAGEABLE_PO);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, stagedFromPurchaseOrderId: PO_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PO_ALREADY_STAGED');
  });

  it('409 PO_NOT_STAGEABLE for received/closed POs', async () => {
    mockAuthAs('admin');
    for (const status of ['received', 'closed']) {
      mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ ...STAGEABLE_PO, status });
      const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
        .send({ ...basePayload, stagedFromPurchaseOrderId: PO_ID });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PO_NOT_STAGEABLE');
    }
    expect(mockPrisma.jobStage.create).not.toHaveBeenCalled();
  });

  it('400 on a cross-org purchase order id', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, stagedFromPurchaseOrderId: PO_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purchase_order/i);
  });
});

// ─── P2 4e: staging receive write-through + movement parity ──────────────────

describe('POST /api/inventory/job-stages/receive — PO write-through (P2 4e, §3.6)', () => {
  const PO_ID = 'aaaaaaa4-0000-0000-0000-000000000031';
  const PO_LINE_ID = 'aaaaaaa5-0000-0000-0000-000000000031';
  const STAGED_LOC = 'aaaaaaa1-0000-0000-0000-000000000031';

  const linkedStage = (over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}) => ({
    ...JOB_STAGE_FIXTURE,
    staged_location_id: STAGED_LOC,
    items: [{
      ...JOB_STAGE_FIXTURE.items[0],
      purchase_order_id: PO_ID,
      po_number: 'PO-1001',
      qty_received: 2,
      price_book_item_id: PRICE_BOOK_ITEM_FIXTURE.id,
      ...lineOver,
    }],
    ...over,
  });

  const PO_LINE = {
    id: PO_LINE_ID, purchase_order_id: PO_ID, item_sku: 'LOCK-100',
    qty_ordered: 5, qty_received: 2, unit_cost: 20,
    purchase_order: { id: PO_ID, status: 'ordered', po_number: 'PO-1001', ordered_at: new Date('2026-02-01'), received_at: null },
  };

  // `staged_location_id` has no foreign key behind it, so the receive path
  // re-reads the location inside the tenant before crediting stock to it. These
  // stages are all staged at STAGED_LOC, so it has to resolve.
  beforeEach(() => {
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: STAGED_LOC });
  });

  it('updates the PO line absolute qty_received and recomputes PO status in the same tx', async () => {
    mockAuthAs('admin');
    const stage = linkedStage();
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.purchaseOrderLine.findFirst.mockResolvedValue(PO_LINE);
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ qty_ordered: 5, qty_received: 3 }]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 1 });

    expect(res.status).toBe(200);
    // Absolute write-through: stage 2 + 1 = 3.
    const upd = mockPrisma.purchaseOrderLine.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: PO_LINE_ID });
    expect(upd.data).toEqual({ qty_received: 3 });
    // Shared recompute flips the PO to partial (3 of 5).
    expect(mockPrisma.purchaseOrder.update).toHaveBeenCalled();
    expect(mockPrisma.purchaseOrder.update.mock.calls[0][0].data.status).toBe('partial');
  });

  it('flips the PO to received when the write-through fills the last line', async () => {
    mockAuthAs('admin');
    const stage = linkedStage({}, { qty_received: 4 });
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.purchaseOrderLine.findFirst.mockResolvedValue({ ...PO_LINE, qty_received: 4 });
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ qty_ordered: 5, qty_received: 5 }]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 1 });

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrderLine.update.mock.calls[0][0].data).toEqual({ qty_received: 5 });
    expect(mockPrisma.purchaseOrder.update.mock.calls[0][0].data.status).toBe('received');
  });

  it('400 OVER_RECEIVE against the PO line qty_ordered BEFORE any write', async () => {
    mockAuthAs('admin');
    const stage = linkedStage({}, { qty_received: 4 });
    mockPrisma.jobStage.findFirst.mockResolvedValue(stage);
    mockPrisma.purchaseOrderLine.findFirst.mockResolvedValue({ ...PO_LINE, qty_received: 4 });

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 2 }); // 4 + 2 > 5

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OVER_RECEIVE');
    expect(res.body.qty_ordered).toBe(5);
    expect(res.body.qty_received).toBe(6);
    expect(mockPrisma.jobStageLine.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).not.toHaveBeenCalled();
  });

  it('receives INTO the stage staged_location and references the PO number (movement parity)', async () => {
    mockAuthAs('admin');
    const stage = linkedStage();
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.purchaseOrderLine.findFirst.mockResolvedValue(PO_LINE);
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ qty_ordered: 5, qty_received: 3 }]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 1 });

    expect(res.status).toBe(200);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.to_location_id).toBe(STAGED_LOC);
    expect(data.reference).toBe('PO-1001');
    // No org-default resolution when the stage has its own location.
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to the org default destination when the stage has no staged_location', async () => {
    mockAuthAs('admin');
    const stage = linkedStage({ staged_location_id: null });
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.purchaseOrderLine.findFirst.mockResolvedValue(PO_LINE);
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ qty_ordered: 5, qty_received: 3 }]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 1 });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
  });

  it('unlinked (manual) stage lines get NO PO-side writes and keep the job reference', async () => {
    mockAuthAs('admin');
    const stage = linkedStage({ staged_location_id: null }, { purchase_order_id: null, po_number: null });
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id, qty: 1 });

    expect(res.status).toBe(200);
    expect(mockPrisma.purchaseOrderLine.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    expect(mockPrisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.reference).toBe(stage.job_number);
  });
});

// ─── PO ↔ stage linkage on the client-lines create path ─────────────────────
// The stage dialog prefills its lines from a PO and then lets the operator EDIT
// them, so it cannot use `stagedFromPurchaseOrderId` (that path copies the PO's
// lines verbatim and ignores client items). `linkedPurchaseOrderId` keeps the
// operator's lines and only carries the linkage - which is what arms the 4e
// receive write-through back onto the PO.
describe('POST /api/inventory/job-stages - linkedPurchaseOrderId', () => {
  const basePayload = {
    jobNumber: 'J00001', customer: 'John Doe', site: '123 Main St',
    trade: 'locksmith', status: 'awaiting_parts',
  };
  // LOCK-100 matches the fixture PO's only line; MISC-9 is an operator-added extra.
  const items = [
    { itemSku: 'LOCK-100', itemName: 'Deadbolt Lock', uom: 'EA', qtyOrdered: 3, qtyReceived: 0, vendor: 'Acme Supply' },
    { itemSku: 'MISC-9', itemName: 'Shim kit', uom: 'EA', qtyOrdered: 1, qtyReceived: 0, vendor: 'Acme Supply' },
  ];

  it('stamps purchase_order_id only on lines whose SKU is on the linked PO', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, items, linkedPurchaseOrderId: PURCHASE_ORDER_FIXTURE.id });

    expect(res.status).toBe(201);
    const created = mockPrisma.jobStage.create.mock.calls[0][0].data.items.create;
    expect(created[0].purchase_order_id).toBe(PURCHASE_ORDER_FIXTURE.id);
    expect(created[0].po_number).toBe(PURCHASE_ORDER_FIXTURE.po_number);
    expect(created[1].purchase_order_id).toBeNull();
  });

  it('preserves the operator-edited quantities (never re-copies the PO lines)', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, items, linkedPurchaseOrderId: PURCHASE_ORDER_FIXTURE.id });

    const created = mockPrisma.jobStage.create.mock.calls[0][0].data.items.create;
    // PO line says qty_ordered 5; the operator submitted 3 and both lines survive.
    expect(created).toHaveLength(2);
    expect(created[0].qty_ordered).toBe(3);
  });

  it('claims the PO for the new stage when it is unclaimed', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE_ORDER_FIXTURE);
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);
    mockPrisma.purchaseOrder.updateMany.mockResolvedValue({ count: 1 });

    await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, items, linkedPurchaseOrderId: PURCHASE_ORDER_FIXTURE.id });

    expect(mockPrisma.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.purchaseOrder.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe(PURCHASE_ORDER_FIXTURE.id);
    expect(call.where.staged_as_job_stage_id).toBeNull();
    expect(call.data.staged_as_job_stage_id).toBe(JOB_STAGE_FIXTURE.id);
  });

  it('leaves an already-claimed PO alone but still links the lines', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({
      ...PURCHASE_ORDER_FIXTURE,
      staged_as_job_stage_id: 'aaaaaaa6-0000-0000-0000-000000000099',
    });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
    mockPrisma.jobStage.create.mockResolvedValue(JOB_STAGE_FIXTURE);

    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, items, linkedPurchaseOrderId: PURCHASE_ORDER_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobStage.create.mock.calls[0][0].data.items.create[0].purchase_order_id)
      .toBe(PURCHASE_ORDER_FIXTURE.id);
    expect(mockPrisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a purchase order from another org (400, cross-org FK injection)', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null); // not in requesting org
    const res = await request(app).post('/api/inventory/job-stages').set(authHeader('admin'))
      .send({ ...basePayload, items, linkedPurchaseOrderId: '99999999-9999-9999-9999-999999999999' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purchase order/i);
    expect(mockPrisma.jobStage.create).not.toHaveBeenCalled();
  });
});

// ─── Receive must have somewhere to put the stock ───────────────────────────
// applyStockMovement only touches stock levels when a destination location is
// present (inv-stock.controller §254), so a receive with no resolvable location
// used to log a ledger row and move nothing - silently. Fail loudly instead.
describe('POST /api/inventory/job-stages/receive - destination location required', () => {
  it('400s when neither the stage nor the org resolves a stock location', async () => {
    mockAuthAs('admin');
    const stage = { ...JOB_STAGE_FIXTURE, staged_location_id: null };
    mockPrisma.jobStage.findFirst.mockResolvedValue(stage);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: null });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null); // org has no warehouse either
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_STOCK_LOCATION');
    expect(mockPrisma.jobStageLine.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('still receives when the org default resolves even with no staged location', async () => {
    mockAuthAs('admin');
    const stage = { ...JOB_STAGE_FIXTURE, staged_location_id: null };
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
  });

  // `job_stages.staged_location_id` carries no foreign key (schema.prisma - the
  // JobStage model), so it can outlive the location it names, and nothing
  // validates it as this org's on write either. Crediting stock to it blind
  // either trips the real stock_balances / stock_movements FKs (opaque 500) or
  // books parts into a tenant that is not the caller's.
  it('409s when the stage staged_location no longer resolves, without silently redirecting the stock', async () => {
    mockAuthAs('admin');
    const stage = { ...JOB_STAGE_FIXTURE, staged_location_id: 'aaaaaaa1-0000-0000-0000-0000000000ff' };
    mockPrisma.jobStage.findFirst.mockResolvedValue(stage);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null); // deleted, or another org's
    mockPrisma.organization.findUnique.mockResolvedValue({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STAGED_LOCATION_MISSING');
    expect(res.body.message).toMatch(/no longer exists/i);
    // Nothing moved, and the org default was NOT quietly substituted.
    expect(mockPrisma.jobStageLine.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('scopes the staged_location existence check to the requesting org', async () => {
    mockAuthAs('admin');
    const stage = { ...JOB_STAGE_FIXTURE, staged_location_id: INVENTORY_LOCATION_FIXTURE.id };
    mockPrisma.jobStage.findFirst.mockResolvedValueOnce(stage).mockResolvedValueOnce(stage);
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const res = await request(app).post('/api/inventory/job-stages/receive').set(authHeader('admin'))
      .send({ stageId: stage.id, itemId: stage.items[0].id });

    expect(res.status).toBe(200);
    const where = mockPrisma.inventoryLocation.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe(INVENTORY_LOCATION_FIXTURE.id);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.to_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
  });
});
