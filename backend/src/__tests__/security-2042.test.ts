/**
 * #2042 — security fix round 1 (F1).
 *
 * `update`/`delete LogisticOrder` were granted to SALES job-scoped (#2042 slice 2), but the
 * per-row guard (`canActOnRow(..., 'update' | 'delete')`) only bounds WHICH LO, never WHETHER a
 * PROCESSED edit/delete is allowed to move stock. A PROCESSED update runs
 * `applyProcessedLineDiff` and a PROCESSED delete runs `returnProcessedLo` — both post real
 * `stockMovement` rows — so a rep could deduct or unwind stock on their own job's LO with no
 * approval step. Security round 1 finding #1 (HIGH, handoffs/security-1.md).
 *
 * Adapted from the verifier's adversarial probe (handoffs/security-1-raw.txt,
 * scratchpad/x/exploit-2042.test.ts / baseline-2042.test.ts) into this suite's conventions: real
 * `enforce.ts` (no `scopeWhereForReq` mock), a faithful `logisticOrder.findFirst` that only
 * answers the ownership probe (`where.AND`) truthfully, never a permissive stub.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, matchesScopeWhere, mockRoleGrantsWithout, PURCHASE_ORDER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000001';
const LINE_1 = 'bbbbbbb2-0000-0000-0000-000000000001';
const OWN_JOB = 'ba000000-0000-0000-0000-000000000001';

// The rep's OWN line: a cheap widget out of the van.
const ITEM_OWN = 'cccccccc-0000-0000-0000-000000000001';
const LOC_VAN = 'dddddddd-0000-0000-0000-000000000001';
// An item + a location the rep has nothing to do with: the org's main warehouse.
const ITEM_FAR = 'cccccccc-0000-0000-0000-0000000000ff';
const LOC_WH = 'dddddddd-0000-0000-0000-0000000000ff';

const SALES_ID = TEST_USERS.sales.id;

const items = [
  { id: ITEM_OWN, sku: 'WIDGET', name: 'Widget', track_inventory: true, unit_cost: 20 },
  { id: ITEM_FAR, sku: 'GARAGE-OPENER', name: 'Garage Opener', track_inventory: true, unit_cost: 900 },
];

function loLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_1, item_id: ITEM_OWN, item_sku: 'WIDGET', item_name: 'Widget',
    qty: 3, from_location_id: LOC_VAN, sequence: 0,
    from_location: { id: LOC_VAN, name: 'Van 1' }, ...over,
  };
}

function loRow(over: Record<string, unknown> = {}) {
  return {
    id: LO_ID, number: 'LO-J00001-1', seq: 1, status: 'PROCESSED',
    job_id: OWN_JOB, invoice_id: null, estimate_id: null, lead_id: null,
    customer_id: null, service_plan_id: null, notes: null,
    submitted_at: new Date('2026-09-01'), submitted_by: SALES_ID,
    approved_at: new Date('2026-09-01'), approved_by: TEST_USERS.dispatcher.id,
    processed_at: new Date('2026-09-01'), processed_by: TEST_USERS.dispatcher.id,
    cancelled_at: null, cancelled_reason: null,
    created_by: SALES_ID, created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-01'),
    organization_id: ALPHA_ORG_ID,
    job: { id: OWN_JOB, job_number: 'J00001', status: 'SCHEDULED' },
    invoice: null, estimate: null, lead: null, customer: null, service_plan: null,
    creator: { id: SALES_ID, first_name: 'Test', last_name: 'Sales' },
    submitter: null, approver: null, processor: null,
    lines: [loLine()], ...over,
  };
}

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        logisticOrder: {
          create: mockPrisma.logisticOrder.create, update: mockPrisma.logisticOrder.update,
          updateMany: mockPrisma.logisticOrder.updateMany, delete: mockPrisma.logisticOrder.delete,
          findFirst: mockPrisma.logisticOrder.findFirst,
        },
        logisticOrderLine: {
          create: mockPrisma.logisticOrderLine.create, createMany: mockPrisma.logisticOrderLine.createMany,
          update: mockPrisma.logisticOrderLine.update, deleteMany: mockPrisma.logisticOrderLine.deleteMany,
          findMany: mockPrisma.logisticOrderLine.findMany,
        },
        priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst, findMany: mockPrisma.priceBookItem.findMany },
        inventoryLocation: { findFirst: mockPrisma.inventoryLocation.findFirst, findMany: mockPrisma.inventoryLocation.findMany },
        organization: { findUnique: mockPrisma.organization.findUnique },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: {
          findMany: mockPrisma.stockBalance.findMany, upsert: mockPrisma.stockBalance.upsert,
          updateMany: mockPrisma.stockBalance.updateMany, findUnique: mockPrisma.stockBalance.findUnique,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

/**
 * A FAITHFUL `logisticOrder.findFirst`: the LO row exists in-org, hanging off `OWN_JOB` (owned by
 * the SALES fixture user). `canActOnRow`'s ownership probe arrives with `where.AND` (one fragment
 * per grant it intersects, e.g. the row's own read scope AND the verb's authority scope, which for
 * `process` is MATCH_NOTHING for SALES) — genuinely evaluated against the probe row via
 * `matchesScopeWhere`, exactly as `logistic-orders.test.ts`'s `wireLoFindFirst` does, so a fragment
 * SALES cannot satisfy (MATCH_NOTHING) correctly fails even though the read fragment alone would
 * pass. The controller's own tenancy read arrives without an `AND` — only the probe consults
 * ownership, so a permissive mock cannot manufacture a pass. `ownedByRep=false` simulates the LO
 * belonging to someone else's job, for the negative control.
 */
function installLoFindFirst(ownedByRep: boolean, status: string = 'PROCESSED') {
  const probeRow = {
    id: LO_ID,
    job: {
      estimate: {
        lead: {
          lead_assignees: [{ user_id: ownedByRep ? SALES_ID : TEST_USERS.admin.id }],
        },
      },
    },
  };
  mockPrisma.logisticOrder.findFirst.mockImplementation((args: { where: Record<string, unknown> }) => {
    const where = args.where ?? {};
    const and = where.AND as Record<string, unknown>[] | undefined;
    if (and && and.length > 0) {
      return Promise.resolve(matchesScopeWhere({ AND: and }, probeRow) ? { id: LO_ID } : null);
    }
    return Promise.resolve(loRow({ status }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  clearTokenCache();
  setupTransaction();

  mockPrisma.priceBookItem.findMany.mockResolvedValue(items);
  mockPrisma.inventoryLocation.findMany.mockResolvedValue([
    { id: LOC_VAN, name: 'Van 1' }, { id: LOC_WH, name: 'Main Warehouse' },
  ]);
  mockPrisma.job.findFirst.mockResolvedValue({ id: OWN_JOB });
  mockPrisma.job.count.mockResolvedValue(1);
  mockPrisma.logisticOrderLine.findMany.mockResolvedValue([loLine()]);
  mockPrisma.logisticOrderLine.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.create.mockResolvedValue({ id: 'new-line' });
  mockPrisma.logisticOrderLine.update.mockResolvedValue({ id: LINE_1 });
  mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrder.update.mockResolvedValue(loRow());
  mockPrisma.logisticOrder.delete.mockResolvedValue({ id: LO_ID });
  mockPrisma.organization.findUnique.mockResolvedValue({
    block_negative_stock: false, default_inventory_location_id: LOC_VAN,
  });
  mockPrisma.stockBalance.findMany.mockResolvedValue([]);
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });
});

const movements = () =>
  mockPrisma.stockMovement.create.mock.calls.map((c: [{ data: Record<string, unknown> }]) => c[0].data);

describe('#2042 F1 — a PROCESSED update/delete additionally requires `process LogisticOrder`', () => {
  describe('SALES — own job, PROCESSED', () => {
    beforeEach(() => mockAuthAs('sales'));

    it('PATCH with a new line is refused (403) and posts NO stock movement', async () => {
      installLoFindFirst(true, 'PROCESSED');

      const res = await request(app)
        .patch(`/api/logistic-orders/${LO_ID}`)
        .set(authHeader('sales'))
        .send({
          lines: [
            { id: LINE_1, item_id: ITEM_OWN, qty: 3, from_location_id: LOC_VAN },
            { item_id: ITEM_FAR, qty: 250, from_location_id: LOC_WH },
          ],
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/process/i);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
      expect(mockPrisma.logisticOrder.update).not.toHaveBeenCalled();
    });

    it('DELETE is refused (403) and never runs the processed-return unwind', async () => {
      installLoFindFirst(true, 'PROCESSED');

      const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('sales'));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/process/i);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
      expect(mockPrisma.logisticOrder.delete).not.toHaveBeenCalled();
    });

    it('PATCH on a DRAFT LO (no stock touched) still 200s — ownership guard only', async () => {
      installLoFindFirst(true, 'DRAFT');

      const res = await request(app)
        .patch(`/api/logistic-orders/${LO_ID}`)
        .set(authHeader('sales'))
        .send({ lines: [{ item_id: ITEM_OWN, qty: 1, from_location_id: LOC_VAN }] });

      expect(res.status).toBe(200);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    });

    // An APPROVED lines PATCH is NO LONGER the ownership-guard-only case this block asserted in
    // round 1 — security round 2 finding C (below) freezes it. The DRAFT case above is what now
    // carries "a non-PROCESSED edit needs nothing but ownership"; the APPROVED cases live in the
    // finding C block.
    it('PATCH on an APPROVED LO carrying NO lines (notes only) still 200s — ownership guard only', async () => {
      installLoFindFirst(true, 'APPROVED');

      const res = await request(app)
        .patch(`/api/logistic-orders/${LO_ID}`)
        .set(authHeader('sales'))
        .send({ notes: 'Left the gate code with the customer' });

      expect(res.status).toBe(200);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it('DELETE on a DRAFT LO still 200s — ownership guard only', async () => {
      installLoFindFirst(true, 'DRAFT');

      const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
      expect(mockPrisma.logisticOrder.delete).toHaveBeenCalled();
    });

    it('DELETE on an APPROVED LO still 200s — ownership guard only', async () => {
      installLoFindFirst(true, 'APPROVED');

      const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
      expect(mockPrisma.logisticOrder.delete).toHaveBeenCalled();
    });
  });

  // DISPATCHER holds no `delete LogisticOrder` grant at all today (only ADMIN and, pre-fix,
  // SALES do) — same fact the pre-existing DELETE suite in logistic-orders.test.ts documents, so
  // the DELETE control below is ADMIN, and PATCH is the DISPATCHER control.
  describe('DISPATCHER — unconditional `process`, PROCESSED update unchanged', () => {
    beforeEach(() => mockAuthAs('dispatcher'));

    it('PATCH still 200s and still moves stock', async () => {
      installLoFindFirst(true, 'PROCESSED');

      const res = await request(app)
        .patch(`/api/logistic-orders/${LO_ID}`)
        .set(authHeader('dispatcher'))
        .send({
          lines: [
            { id: LINE_1, item_id: ITEM_OWN, qty: 3, from_location_id: LOC_VAN },
            { item_id: ITEM_FAR, qty: 5, from_location_id: LOC_WH },
          ],
        });

      expect(res.status).toBe(200);
      expect(movements().some((m: Record<string, unknown>) => m.type === 'consume')).toBe(true);
    });
  });

  describe('ADMIN — superuser, PROCESSED edit/delete unchanged', () => {
    beforeEach(() => mockAuthAs('admin'));

    it('PATCH still 200s and still moves stock', async () => {
      installLoFindFirst(true, 'PROCESSED');

      const res = await request(app)
        .patch(`/api/logistic-orders/${LO_ID}`)
        .set(authHeader('admin'))
        .send({
          lines: [
            { id: LINE_1, item_id: ITEM_OWN, qty: 3, from_location_id: LOC_VAN },
            { item_id: ITEM_FAR, qty: 5, from_location_id: LOC_WH },
          ],
        });

      expect(res.status).toBe(200);
      expect(movements().some((m: Record<string, unknown>) => m.type === 'consume')).toBe(true);
    });

    it('DELETE still 200s and still unwinds the deduction', async () => {
      installLoFindFirst(true, 'PROCESSED');

      const res = await request(app).delete(`/api/logistic-orders/${LO_ID}`).set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(movements().some((m: Record<string, unknown>) => m.type === 'return')).toBe(true);
      expect(mockPrisma.logisticOrder.delete).toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SECURITY ROUND 2 (handoffs/security-2.md) — three findings over the round-1 tree (7ac92752d).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A findFirst that evaluates EVERY `where` against the fixture row, not only the ownership probe:
 * finding A is about a read the handler performs WITHOUT an `AND` (the post-write re-read), so the
 * `installLoFindFirst` split above — which answers any `AND`-less where with the row — cannot see
 * it. `matchesScopeWhere` throws on a shape it does not know, so a fragment that silently stopped
 * being applied shows up as a failure rather than a pass.
 */
function installLoFindFirstFaithful(ownedByRep: boolean, status: string, over: Record<string, unknown> = {}) {
  const row = loRow({
    status,
    number: ownedByRep ? 'LO-J00001-1' : 'LO-J00099-1',
    notes: ownedByRep ? null : 'Two openers for the rebuild',
    job: {
      id: OWN_JOB,
      job_number: ownedByRep ? 'J00001' : 'J00099',
      status: 'SCHEDULED',
      estimate: { lead: { lead_assignees: [{ user_id: ownedByRep ? SALES_ID : TEST_USERS.admin.id }] } },
    },
    customer: {
      id: 'ca000000-0000-0000-0000-000000000001',
      customer_number: 'C00042',
      first_name: 'Dana',
      last_name: 'Reyes',
      company_name: 'Reyes Storage',
    },
    lines: [loLine({ item_id: ITEM_FAR, item_sku: 'GARAGE-OPENER', item_name: 'Garage Opener', qty: 250 })],
    ...over,
  });
  mockPrisma.logisticOrder.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
    Promise.resolve(matchesScopeWhere(args.where ?? {}, row) ? row : null),
  );
  // The post-write re-read must see the COMMITTED state, so the claim's status flip lands on the
  // same object the findFirst above answers with — otherwise the body's `status` is the fixture's
  // and every "did the flip reach the caller" assertion is vacuous.
  mockPrisma.logisticOrder.updateMany.mockImplementation((args: { data?: { status?: string } }) => {
    if (args.data?.status) row.status = args.data.status;
    return Promise.resolve({ count: 1 });
  });
}

const APPROVE_OVERRIDE = [{ action: 'approve', subject: 'LogisticOrder', effect: 'allow' }];

/**
 * FINDING A (MEDIUM) — `approveLogisticOrder` answered the FULL `mapLoDetail` of a row the caller
 * provably cannot read (`GET /api/logistic-orders/:id` 404s for the same caller one line earlier).
 * The ids arrive by the `lo.submitted` notification, which is not access-filtered for LOGISTIC_ORDER.
 * The WRITE stays org-wide on purpose (an approver reviews other people's requests); only the BODY
 * is narrowed, to the caller's own read scope, with a slim acknowledgement when that misses.
 */
describe('#2042 security round 2 (A) — the approve 200 body is built through the caller read scope', () => {
  it('SALES approver, ANOTHER rep\'s job: 200 slim ack, no customer / job / line data, flip persisted', async () => {
    mockAuthAs('sales');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue(APPROVE_OVERRIDE);
    installLoFindFirstFaithful(false, 'PENDING_APPROVAL');

    const res = await request(app).post(`/api/logistic-orders/${LO_ID}/approve`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LO_ID, number: 'LO-J00099-1', status: 'APPROVED' });
    for (const leaked of ['lines', 'anchors', 'notes', 'createdBy', 'lineCount']) {
      expect(Object.keys(res.body)).not.toContain(leaked);
    }
    // The payload, not just the key names: no customer name, no customer number, no SKU, no
    // item name, no notes. NOT the job number: an anchored LO number IS `LO-<job number>-<seq>`,
    // and that number is the label the approver's own `lo.submitted` notification carried
    // (`object: { type, id, label: lo.number }`), so echoing it back tells them nothing new.
    const body = JSON.stringify(res.body);
    for (const secret of ['Reyes', 'C00042', 'GARAGE-OPENER', 'Garage Opener', 'rebuild']) {
      expect(body).not.toContain(secret);
    }
    // The approval itself still landed — this is a body narrowing, NOT a new refusal.
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.data.status).toBe('APPROVED');
    expect(claim.data.approved_by).toBe(SALES_ID);
  });

  it('SALES approver, their OWN job: full detail body, unchanged', async () => {
    mockAuthAs('sales');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue(APPROVE_OVERRIDE);
    installLoFindFirstFaithful(true, 'PENDING_APPROVAL');

    const res = await request(app).post(`/api/logistic-orders/${LO_ID}/approve`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.anchors.jobNumber).toBe('J00001');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lineCount).toBe(1);
    expect(res.body.anchors.customerNumber).toBe('C00042');
  });

  it('DISPATCHER approver, the SAME foreign-job LO: full detail body, unchanged (org-wide read)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue(APPROVE_OVERRIDE);
    installLoFindFirstFaithful(false, 'PENDING_APPROVAL');

    const res = await request(app).post(`/api/logistic-orders/${LO_ID}/approve`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.anchors.jobNumber).toBe('J00099');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.status).toBe('APPROVED');
  });
});

/**
 * FINDING C (MEDIUM) — `updateLogisticOrder`'s non-PROCESSED branch full-replaces the lines of an
 * APPROVED LO without touching `status` / `approved_at` / `approved_by`: a rep gets a cheap line
 * approved, swaps in high-value SKUs, and the dispatcher processes an order nobody reviewed. A
 * lines PATCH on an APPROVED LO now needs the authority to approve (or to process) THAT row.
 * Grant-based, never a role name: SALES holds neither, DISPATCHER holds `process LogisticOrder`
 * unconditionally, ADMIN short-circuits as a superuser, and a SALES rep who was handed the
 * "Approve logistic orders" capability passes on their own row.
 */
describe('#2042 security round 2 (C) — an APPROVED LO\'s lines are frozen to approvers/processors', () => {
  const FROZEN_COPY =
    "This order has already been approved and can't be changed. Ask an approver to cancel it and submit a new one.";
  const NEW_LINES = { lines: [{ item_id: ITEM_FAR, qty: 250, from_location_id: LOC_WH }] };

  it('SALES, own job, APPROVED: 409 with the frozen-order copy and NOT ONE line write', async () => {
    mockAuthAs('sales');
    installLoFindFirst(true, 'APPROVED');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('sales'))
      .send(NEW_LINES);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: FROZEN_COPY });
    expect(mockPrisma.logisticOrderLine.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrderLine.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.update).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('SALES, own job, APPROVED, notes only (no `lines` key): still 200 and the notes persist', async () => {
    mockAuthAs('sales');
    installLoFindFirst(true, 'APPROVED');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('sales'))
      .send({ notes: 'Customer will meet the crew at 8' });

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrder.update.mock.calls[0][0].data).toMatchObject({
      notes: 'Customer will meet the crew at 8',
    });
    expect(mockPrisma.logisticOrderLine.deleteMany).not.toHaveBeenCalled();
  });

  it('SALES, own job, DRAFT: lines PATCH still 200s (the order has not been reviewed yet)', async () => {
    mockAuthAs('sales');
    installLoFindFirst(true, 'DRAFT');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('sales'))
      .send(NEW_LINES);

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
  });

  it('SALES, own job, PENDING_APPROVAL: lines PATCH still 200s (nobody has approved it yet)', async () => {
    mockAuthAs('sales');
    installLoFindFirst(true, 'PENDING_APPROVAL');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('sales'))
      .send(NEW_LINES);

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
  });

  it('SALES holding the approve capability, own job, APPROVED: 200 — the gate is the GRANT, not the role', async () => {
    mockAuthAs('sales');
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue(APPROVE_OVERRIDE);
    installLoFindFirst(true, 'APPROVED');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('sales'))
      .send(NEW_LINES);

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
  });

  it('DISPATCHER, APPROVED: 200, unchanged (holds `process LogisticOrder` unconditionally)', async () => {
    mockAuthAs('dispatcher');
    installLoFindFirst(true, 'APPROVED');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('dispatcher'))
      .send(NEW_LINES);

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('ADMIN, APPROVED: 200, unchanged', async () => {
    mockAuthAs('admin');
    installLoFindFirst(true, 'APPROVED');

    const res = await request(app)
      .patch(`/api/logistic-orders/${LO_ID}`)
      .set(authHeader('admin'))
      .send(NEW_LINES);

    expect(res.status).toBe(200);
    expect(mockPrisma.logisticOrderLine.createMany).toHaveBeenCalled();
  });
});

/**
 * FINDING D (MEDIUM) — `read PurchaseOrder` now reaches every SALES-derived role (#2042 R1/R2),
 * but `canSeePricing(req)` (`read Pricing`, the Roles editor's "See financial data" switch) was
 * never wired into the purchasing surface — `mapPOLine` always emitted `unitCost`/
 * `catalogUnitCost`, the low-stock proposal lines always emitted `unitCost`, and
 * `getJobMaterialCost` always emitted the aggregate `materialCost`. `stripMappedItemCost`
 * (inv-catalog.controller.ts) already strips the same two catalog fields behind the same
 * predicate for the identical principal — a cost-blind SALES/DISPATCHER user (an admin has
 * unticked "See financial data" for their role) must get the same treatment on purchasing.
 * Security round 3 finding D (handoffs/security-3.md).
 */
describe('#2042 security round 3 (D) — purchasing cost fields respect the financial-data grant', () => {
  const PO_COST_ID = 'aaaaaaa4-9999-0000-0000-000000000009';
  const LOW_STOCK_ITEM_ID = 'cccccccc-0000-0000-0000-0000000000aa';

  function poCostFixture() {
    return {
      ...PURCHASE_ORDER_FIXTURE,
      id: PO_COST_ID,
      job_id: OWN_JOB,
      job: { job_number: 'J00001', estimate: { lead: { lead_assignees: [{ user_id: SALES_ID }] } } },
      lines: [{
        id: 'aaaaaaa5-9999-0000-0000-000000000009', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock',
        uom: 'EA', qty_ordered: 5, qty_received: 0, unit_cost: 20,
        price_book_item: { unit_cost: 18 }, price_book_item_id: 'bbbbbbb9-0000-0000-0000-000000000001',
        created_at: new Date('2026-02-01'),
      }],
    };
  }

  // Real `scopeWhereForReq('PurchaseOrder')` evaluation, same pattern as the (a)/(b) repro and
  // `installLoFindFirst` above: SALES's `read PurchaseOrder` is job-scoped (#2042), so the fixture
  // must genuinely satisfy the `where` the controller built, not a permissive stub.
  function wireCostPoFindMany(rows: Record<string, unknown>[]) {
    mockPrisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((row) => matchesScopeWhere(where, row))),
    );
  }
  function wireCostPoFindFirst(rows: Record<string, unknown>[]) {
    mockPrisma.purchaseOrder.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const row = rows.find((p) => p.id === (where as { id?: string }).id);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
    });
  }
  function wireLowStockBalance() {
    mockPrisma.stockBalance.findMany.mockResolvedValue([{
      organization_id: ALPHA_ORG_ID, min: 10, on_hand: 1, location_id: LOC_WH,
      item: {
        id: LOW_STOCK_ITEM_ID, sku: 'LOCK-100', name: 'Deadbolt Lock', uom: 'EA',
        unit_cost: 20, vendor_id: null, vendor: null,
      },
      location: { id: LOC_WH, name: 'Main Warehouse' },
    }]);
  }
  function wireMaterialCostLines() {
    mockPrisma.purchaseOrderLine.findMany.mockResolvedValue([{ qty_received: 2, unit_cost: 20, price_book_item: null }]);
    mockPrisma.jobStageLine.findMany.mockResolvedValue([]);
  }

  describe('cost-blind SALES ("See financial data" off)', () => {
    beforeEach(() => {
      mockAuthAs('sales');
      mockRoleGrantsWithout('SALES', ['read', 'Pricing']);
    });

    it('GET /api/inventory/purchase-orders: 200, the line carries no unitCost/catalogUnitCost', async () => {
      wireCostPoFindMany([poCostFixture()]);

      const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(res.body.purchaseOrders).toHaveLength(1);
      const line = res.body.purchaseOrders[0].lines[0];
      expect(line).not.toHaveProperty('unitCost');
      expect(line).not.toHaveProperty('catalogUnitCost');
      // qty/sku/name are NOT cost data — kept for every reader.
      expect(line.itemSku).toBe('LOCK-100');
      expect(line.qtyOrdered).toBe(5);
    });

    it('GET /api/inventory/purchase-orders/:id: 200, no cost fields on the line', async () => {
      wireCostPoFindFirst([poCostFixture()]);

      const res = await request(app).get(`/api/inventory/purchase-orders/${PO_COST_ID}`).set(authHeader('sales'));

      expect(res.status).toBe(200);
      const line = res.body.purchaseOrder.lines[0];
      expect(line).not.toHaveProperty('unitCost');
      expect(line).not.toHaveProperty('catalogUnitCost');
    });

    it('GET /api/inventory/purchase-orders/low-stock-proposals: 200, no unitCost on the proposal line', async () => {
      wireLowStockBalance();

      const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('sales'));

      expect(res.status).toBe(200);
      const line = res.body.proposals[0].lines[0];
      expect(line).not.toHaveProperty('unitCost');
      // The proposal's own shape (never cost) is untouched.
      expect(line.suggestedQty).toBe(9);
    });

    it('GET /api/inventory/jobs/:jobId/material-cost: 200, no materialCost key; jobId/lineCount kept', async () => {
      wireMaterialCostLines();

      const res = await request(app).get(`/api/inventory/jobs/${OWN_JOB}/material-cost`).set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('materialCost');
      expect(res.body.jobId).toBe(OWN_JOB);
      expect(res.body.lineCount).toBe(1);
    });
  });

  describe('SALES with `read Pricing` (the default) — control: cost fields present', () => {
    beforeEach(() => mockAuthAs('sales'));

    it('GET /api/inventory/purchase-orders: unitCost/catalogUnitCost present', async () => {
      wireCostPoFindMany([poCostFixture()]);

      const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('sales'));

      expect(res.status).toBe(200);
      const line = res.body.purchaseOrders[0].lines[0];
      expect(line.unitCost).toBe(20);
      expect(line.catalogUnitCost).toBe(18);
    });

    it('GET /api/inventory/purchase-orders/low-stock-proposals: unitCost present', async () => {
      wireLowStockBalance();

      const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(res.body.proposals[0].lines[0].unitCost).toBe(20);
    });

    it('GET /api/inventory/jobs/:jobId/material-cost: materialCost present', async () => {
      wireMaterialCostLines();

      const res = await request(app).get(`/api/inventory/jobs/${OWN_JOB}/material-cost`).set(authHeader('sales'));

      expect(res.status).toBe(200);
      expect(res.body.materialCost).toBe(40);
    });
  });

  describe('cost-blind DISPATCHER — the strip is grant-based, not a SALES-only rule', () => {
    beforeEach(() => {
      mockAuthAs('dispatcher');
      mockRoleGrantsWithout('DISPATCHER', ['read', 'Pricing']);
    });

    it('GET /api/inventory/purchase-orders: 200, no unitCost/catalogUnitCost', async () => {
      wireCostPoFindMany([poCostFixture()]);

      const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      const line = res.body.purchaseOrders[0].lines[0];
      expect(line).not.toHaveProperty('unitCost');
      expect(line).not.toHaveProperty('catalogUnitCost');
    });

    it('GET /api/inventory/purchase-orders/low-stock-proposals: 200, no unitCost', async () => {
      wireLowStockBalance();

      const res = await request(app).get('/api/inventory/purchase-orders/low-stock-proposals').set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      expect(res.body.proposals[0].lines[0]).not.toHaveProperty('unitCost');
    });

    it('GET /api/inventory/jobs/:jobId/material-cost: 200, no materialCost key', async () => {
      wireMaterialCostLines();

      const res = await request(app).get(`/api/inventory/jobs/${OWN_JOB}/material-cost`).set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('materialCost');
    });
  });

  describe('ADMIN — a superuser always sees cost (manage-all, `canSeePricing` is always true)', () => {
    beforeEach(() => mockAuthAs('admin'));

    it('GET /api/inventory/purchase-orders: unitCost/catalogUnitCost present', async () => {
      wireCostPoFindMany([poCostFixture()]);

      const res = await request(app).get('/api/inventory/purchase-orders').set(authHeader('admin'));

      expect(res.status).toBe(200);
      const line = res.body.purchaseOrders[0].lines[0];
      expect(line.unitCost).toBe(20);
      expect(line.catalogUnitCost).toBe(18);
    });

    it('GET /api/inventory/jobs/:jobId/material-cost: materialCost present', async () => {
      wireMaterialCostLines();

      const res = await request(app).get(`/api/inventory/jobs/${OWN_JOB}/material-cost`).set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.materialCost).toBe(40);
    });
  });
});
