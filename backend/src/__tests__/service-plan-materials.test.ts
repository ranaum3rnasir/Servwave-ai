/**
 * Service-plan materials template (LO-5, spec §15 / plan §5).
 *
 * Two behaviours under test:
 *   1. scheduleVisit mints ONE DRAFT LogisticOrder from the plan's material template, INSIDE the
 *      same transaction that creates the visit job + PlanVisit — anchored job_id + service_plan_id,
 *      job winning the number, snapshots + qty on the lines, dead catalog refs skipped with a notice.
 *   2. ServicePlan CRUD carries material_lines[] with a full-replace mirroring ServicePlanLineItem.
 *
 * The load-bearing test is "mints INSIDE the same tx": the LogisticOrder create must land on the
 * transaction client (so a scheduleVisit failure rolls the LO back too), never on the global client
 * (the P2024 connection-pool hazard). The distinct-tx-spy harness — a tx client whose delegates are
 * DIFFERENT functions from the global mock — is what makes "which client was used" assertable at all
 * (see inventory-tx-connection-isolation.test.ts for the original).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  TEST_USERS,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  TRACKED_ITEM_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Numbering: keep pickAnchor / ANCHORS / ANCHOR_PRECEDENCE REAL (job-wins precedence is under test),
// stub only the two allocators. allocateAnchoredNumber returns the anchored LO-J number so we can
// assert the minted number without touching the DB.
vi.mock('../lib/numbering', async (orig) => {
  const actual = await orig<typeof import('../lib/numbering')>();
  return {
    ...actual,
    allocateNumber: vi.fn().mockImplementation((_tx: unknown, entity: string) =>
      Promise.resolve(`${entity[0].toUpperCase()}00001`),
    ),
    allocateAnchoredNumber: vi.fn().mockResolvedValue({ number: 'LO-J00001-1', seq: 1 }),
  };
});
import { allocateAnchoredNumber } from '../lib/numbering';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const PLAN_ID = 'sp000000-0000-0000-0000-000000000001';
const JOB_ID = 'ba000000-0000-0000-0000-000000000001';
const LIVE_ITEM = TRACKED_ITEM_FIXTURE.id; // aaaaaaa2-…002, sku WIRE-12, track_inventory: true
const DEAD_ITEM_ID = 'aaaaaaa2-0000-0000-0000-0000000000ff'; // an id that no longer resolves

/**
 * A transaction-client spy: a DISTINCT function from the global mock, resolving whatever the global
 * mock currently returns. Reading the impl at call time keeps per-test mockResolvedValue working.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txSpy(globalFn: any) {
  return vi.fn((...args: unknown[]) => {
    const impl = globalFn.getMockImplementation();
    return impl ? impl(...args) : Promise.resolve(null);
  });
}

/** A live tracked-item row as instantiatePlanMaterials' liveness query hands it back. */
const liveItemRow = (over: Record<string, unknown> = {}) => ({
  id: LIVE_ITEM,
  sku: 'WIRE-12',
  name: '12ga Wire (ft)',
  track_inventory: true,
  organization_id: ALPHA_ORG_ID,
  ...over,
});

/** A material-template line as stored on service_plan_material_lines. */
const matLine = (over: Record<string, unknown> = {}) => ({
  item_id: LIVE_ITEM,
  item_sku: 'WIRE-12',
  item_name: '12ga Wire (ft)',
  qty: '2.00',
  position: 0,
  ...over,
});

/** A full ACTIVE plan row (schedule path loads material_lines via the widened include). */
const planRow = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  service_plan_number: 'SP00001',
  organization_id: ALPHA_ORG_ID,
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: LOCATION_FIXTURE.id,
  name: 'MONITORING — Annual',
  status: 'ACTIVE',
  visit_cadence: 'MONTHLY',
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  end_date: new Date('2026-12-31T00:00:00.000Z'),
  contract_price: '1200.00',
  sold_by: null,
  renewals_count: 0,
  template_id: null,
  line_items: [{ name: 'Annual monitoring', quantity: 1, unit_price: '1200.00', position: 0 }],
  material_lines: [matLine()],
  visits: [],
  customer: { tax_exempt: false },
  service_location: { state: 'CA' },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// scheduleVisit → mint LO from materials
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/service-plans/:id/schedule-visit — materials → DRAFT LO', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tx: Record<string, any>;

  /** Build the tx client with DISTINCT spies for the schedule-visit + instantiate path. */
  function makeScheduleTx() {
    tx = {
      job: { create: vi.fn().mockResolvedValue({ id: 'job1', job_number: 'J00001' }) },
      planVisit: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'pv1', visit_number: 1 }),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // S8 (D6): scheduleVisit books a real job VISIT and lands the plan's technician on it, so
      // this tx client needs those delegates - a write to one a hand-listed fake omits throws
      // inside the transaction and the route 500s with no useful message.
      visit: {
        create: vi.fn().mockResolvedValue({ id: 'jv1', job_id: 'job1', visit_seq: 1 }),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // instantiatePlanMaterials runs on the tx client: liveness read + LO create.
      priceBookItem: { findMany: txSpy(mockPrisma.priceBookItem.findMany) },
      logisticOrder: { create: vi.fn().mockResolvedValue({ id: 'lo1', number: 'LO-J00001-1' }) },
    };
    mockPrisma.$transaction.mockImplementation((fn: (c: unknown) => unknown) => {
      if (typeof fn === 'function') return fn(tx);
      return Promise.all(fn as unknown as Promise<unknown>[]);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    makeScheduleTx();
    // Liveness query default: the WIRE-12 item is a live tracked item.
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
  });

  it('mints exactly one DRAFT LO with job+service_plan anchors, the LO-J number, snapshots+qty, actor', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow());

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/schedule-visit`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(201);

    // Number minted off the JOB anchor (job wins even though service_plan is also anchored).
    expect(asMock(allocateAnchoredNumber)).toHaveBeenCalledTimes(1);
    expect(asMock(allocateAnchoredNumber).mock.calls[0][1]).toMatchObject({
      anchorTable: 'jobs',
      anchorColumn: 'job_id',
      anchorId: 'job1',
      organizationId: ALPHA_ORG_ID,
    });

    // Exactly one LO minted, on the tx client.
    expect(tx.logisticOrder.create).toHaveBeenCalledTimes(1);
    const data = tx.logisticOrder.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      number: 'LO-J00001-1',
      seq: 1,
      status: 'DRAFT',
      job_id: 'job1',
      service_plan_id: PLAN_ID,
      created_by: TEST_USERS.admin.id,
      organization_id: ALPHA_ORG_ID,
    });
    expect(data.notes).toContain('SP00001');
    expect(data.lines.create).toHaveLength(1);
    expect(data.lines.create[0]).toMatchObject({
      item_id: LIVE_ITEM,
      item_sku: 'WIRE-12',
      item_name: '12ga Wire (ft)',
      qty: 2,
      from_location_id: null,
      sequence: 0,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('mints the LO INSIDE the schedule transaction — never on the global client (P2024 fence)', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow());

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/schedule-visit`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(201);
    // The LO create + its liveness read land on the tx client…
    expect(tx.logisticOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.priceBookItem.findMany).toHaveBeenCalled();
    // …and NEVER on the global client (a global write here would survive the tx's rollback).
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
    // allocateAnchoredNumber received the SAME tx client (minted inside the tx, lock held to commit).
    expect(asMock(allocateAnchoredNumber).mock.calls[0][0]).toBe(tx);
  });

  it('rolls the LO back with the rest of the visit when the transaction fails', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow());
    // The timeline write (last statement in the tx, after the mint) throws → whole tx aborts.
    tx.timelineEvent.create.mockRejectedValue(new Error('timeline boom'));

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/schedule-visit`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(500);
    // The LO create DID run — inside the failing tx, so in prod it rolls back atomically with the
    // job + visit. The proof it is atomic is that it ran on the tx client, not the global one: had
    // it been sequenced after the tx (or issued on the global client), the tx throw would abort the
    // request BEFORE the LO create ever ran, and this assertion would go red.
    expect(tx.logisticOrder.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('mints NO LO when the plan has no material lines', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ material_lines: [] }));

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/schedule-visit`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(tx.logisticOrder.create).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
    // No template lines → the allocator is never reached either.
    expect(asMock(allocateAnchoredNumber)).not.toHaveBeenCalled();
  });

  it('skips dead catalog refs (SetNull or no-longer-tracked), notices them, and still mints live lines', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(
      planRow({
        material_lines: [
          matLine(), // live WIRE-12
          matLine({ item_id: null, item_sku: 'GONE-1', item_name: 'Removed Widget', qty: '1.00', position: 1 }), // SetNull'd
          matLine({ item_id: DEAD_ITEM_ID, item_sku: 'OLD-9', item_name: 'Old Part', qty: '3.00', position: 2 }), // no longer resolves
        ],
      }),
    );
    // Only WIRE-12 comes back from the catalog (the OLD-9 id + the null one are dead).
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/schedule-visit`)
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(tx.logisticOrder.create).toHaveBeenCalledTimes(1);
    const data = tx.logisticOrder.create.mock.calls[0][0].data;
    // Only the one live line makes it onto the LO…
    expect(data.lines.create).toHaveLength(1);
    expect(data.lines.create[0]).toMatchObject({ item_sku: 'WIRE-12', qty: 2, sequence: 0 });
    // …and BOTH dead snapshots are named in the notes.
    expect(data.notes).toContain('GONE-1');
    expect(data.notes).toContain('OLD-9');
    expect(data.notes).toContain('SP00001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skipVisit → no job, no materials
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/service-plans/:id/skip-visit — mints nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
  });

  it('a skipped visit (job_id null) never mints an LO', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'ACTIVE', visits: [] }));
    mockPrisma.planVisit.count.mockResolvedValue(0);
    mockPrisma.planVisit.create.mockResolvedValue({ id: 'pv-skip', status: 'SKIPPED' });

    const res = await request(app)
      .post(`/api/service-plans/${PLAN_ID}/skip-visit`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
    expect(asMock(allocateAnchoredNumber)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template edit never retro-mutates a minted LO
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/service-plans/:id — template edit does not touch minted LOs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
  });

  it('replacing material_lines on a DRAFT plan updates the template only, never a LogisticOrder', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue({
      id: PLAN_ID, status: 'DRAFT',
      visit_cadence: 'MONTHLY', interval_unit: null, interval_count: null, byweekday: [], occurrence_count: null,
    });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
    const matDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const matCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        servicePlan: { update: vi.fn().mockResolvedValue(planRow({ status: 'DRAFT' })) },
        servicePlanLineItem: { deleteMany: vi.fn(), createMany: vi.fn() },
        servicePlanMaterialLine: { deleteMany: matDeleteMany, createMany: matCreateMany },
      }),
    );

    const res = await request(app)
      .patch(`/api/service-plans/${PLAN_ID}`)
      .set(authHeader('admin'))
      .send({ material_lines: [{ item_id: LIVE_ITEM, qty: 4 }] });

    expect(res.status).toBe(200);
    // Template rows are full-replaced…
    expect(matDeleteMany).toHaveBeenCalled();
    expect(matCreateMany).toHaveBeenCalled();
    // …and nothing on the LogisticOrder surface is touched (documents never retro-change).
    expect(mockPrisma.logisticOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });

  it('replacing material_lines on an ACTIVE plan updates the template only, never a LogisticOrder', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
    const matDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const matCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        servicePlan: { update: vi.fn().mockResolvedValue(planRow({ status: 'ACTIVE' })) },
        servicePlanMaterialLine: { deleteMany: matDeleteMany, createMany: matCreateMany },
      }),
    );

    const res = await request(app)
      .patch(`/api/service-plans/${PLAN_ID}`)
      .set(authHeader('admin'))
      .send({ material_lines: [{ item_id: LIVE_ITEM, qty: 7 }] });

    expect(res.status).toBe(200);
    expect(matDeleteMany).toHaveBeenCalled();
    expect(matCreateMany).toHaveBeenCalled();
    // A revised template affects FUTURE visits only — a previously-minted LO is a document
    // and must never retro-change. instantiatePlanMaterials only ever runs inside
    // scheduleVisit; this endpoint touches the LogisticOrder model nowhere.
    expect(mockPrisma.logisticOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ServicePlan CRUD material_lines round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('ServicePlan CRUD — material_lines round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
  });

  it('createPlan persists material_lines with snapshots resolved from the catalog', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
    const createSpy = vi.fn().mockResolvedValue(planRow({ status: 'DRAFT' }));
    mockPrisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ servicePlan: { create: createSpy } }),
    );

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      name: 'MONITORING — Annual',
      visit_cadence: 'MONTHLY',
      start_date: '2026-01-01T00:00:00.000Z',
      end_date: '2026-12-31T00:00:00.000Z',
      contract_price: 1200,
      line_items: [{ name: 'Annual monitoring', quantity: 1, unit_price: 1200 }],
      material_lines: [{ item_id: LIVE_ITEM, qty: 2 }],
    });

    expect(res.status).toBe(201);
    const createData = createSpy.mock.calls[0][0].data;
    expect(createData.material_lines.create).toEqual([
      expect.objectContaining({
        item_id: LIVE_ITEM,
        item_sku: 'WIRE-12',
        item_name: '12ga Wire (ft)',
        qty: 2,
        position: 0,
        organization_id: ALPHA_ORG_ID,
      }),
    ]);
    // Round-trip: the response echoes the stored material_lines.
    expect(res.body.servicePlan.material_lines).toEqual([expect.objectContaining({ item_sku: 'WIRE-12' })]);
  });

  it('createPlan rejects a material item that is not a tracked in-org item (400)', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
    // Catalog returns nothing → the requested material item is not a tracked in-org item.
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);

    const res = await request(app).post('/api/service-plans').set(authHeader('admin')).send({
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      name: 'X',
      visit_cadence: 'MONTHLY',
      start_date: '2026-01-01T00:00:00.000Z',
      end_date: '2026-12-31T00:00:00.000Z',
      contract_price: 100,
      line_items: [],
      material_lines: [{ item_id: DEAD_ITEM_ID, qty: 1 }],
    });

    expect(res.status).toBe(400);
    // Harden against a placebo: this must be the tracked-item rejection, NOT `.strict()` bouncing an
    // unknown `material_lines` key (which would also 400, but with 'Validation failed').
    expect(res.body.error).not.toBe('Validation failed');
    expect(String(res.body.error)).toMatch(/track/i);
  });

  it('getPlan reads material_lines back', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue(planRow({ status: 'DRAFT' }));

    const res = await request(app).get(`/api/service-plans/${PLAN_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.servicePlan.material_lines).toEqual([expect.objectContaining({ item_sku: 'WIRE-12' })]);
    // The read include asks for material_lines.
    expect(mockPrisma.servicePlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ material_lines: expect.anything() }) }),
    );
  });

  it('updatePlan full-replaces material_lines on a DRAFT plan (deleteMany + createMany)', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue({
      id: PLAN_ID, status: 'DRAFT',
      visit_cadence: 'MONTHLY', interval_unit: null, interval_count: null, byweekday: [], occurrence_count: null,
    });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
    const matDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const matCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        servicePlan: { update: vi.fn().mockResolvedValue(planRow({ status: 'DRAFT' })) },
        servicePlanLineItem: { deleteMany: vi.fn(), createMany: vi.fn() },
        servicePlanMaterialLine: { deleteMany: matDeleteMany, createMany: matCreateMany },
      }),
    );

    const res = await request(app)
      .patch(`/api/service-plans/${PLAN_ID}`)
      .set(authHeader('admin'))
      .send({ material_lines: [{ item_id: LIVE_ITEM, qty: 5 }] });

    expect(res.status).toBe(200);
    expect(matDeleteMany).toHaveBeenCalledWith({ where: { service_plan_id: PLAN_ID } });
    expect(matCreateMany).toHaveBeenCalledTimes(1);
    expect(matCreateMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ item_id: LIVE_ITEM, item_sku: 'WIRE-12', item_name: '12ga Wire (ft)', qty: 5, position: 0, service_plan_id: PLAN_ID, organization_id: ALPHA_ORG_ID }),
    ]);
  });

  it('allows a material_lines edit on an ACTIVE plan (unlike line_items — materials never touch billing)', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([liveItemRow()]);
    const matDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const matCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        servicePlan: { update: vi.fn().mockResolvedValue(planRow({ status: 'ACTIVE' })) },
        servicePlanMaterialLine: { deleteMany: matDeleteMany, createMany: matCreateMany },
      }),
    );

    const res = await request(app)
      .patch(`/api/service-plans/${PLAN_ID}`)
      .set(authHeader('admin'))
      .send({ material_lines: [{ item_id: LIVE_ITEM, qty: 3 }] });

    expect(res.status).toBe(200);
    expect(matDeleteMany).toHaveBeenCalledWith({ where: { service_plan_id: PLAN_ID } });
    expect(matCreateMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ item_id: LIVE_ITEM, item_sku: 'WIRE-12', item_name: '12ga Wire (ft)', qty: 3, position: 0, service_plan_id: PLAN_ID, organization_id: ALPHA_ORG_ID }),
    ]);
  });

  it('still blocks billing-affecting fields on an ACTIVE plan even in a request that also carries material_lines', async () => {
    mockPrisma.servicePlan.findFirst.mockResolvedValue({ id: PLAN_ID, status: 'ACTIVE' });

    const res = await request(app)
      .patch(`/api/service-plans/${PLAN_ID}`)
      .set(authHeader('admin'))
      .send({ material_lines: [{ item_id: LIVE_ITEM, qty: 1 }], contract_price: 999 });

    // The carve-out is materials-only: a disallowed field anywhere in the payload still 400s,
    // and nothing is written (fail before the tx opens).
    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
