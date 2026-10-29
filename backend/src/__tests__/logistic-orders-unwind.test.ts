/**
 * Logistic Orders — the anchored-entity unwind (spec §14 C1 / H1, plan §2.4 / §2.5).
 *
 * Two layers:
 *   1. ENGINE — collectAnchoredLoUnwind + applyAnchoredLoUnwind + returnProcessedLo driven
 *      directly (mock-prisma harness), pinning the unwind semantics every document verb inherits.
 *   2. DOCUMENT VERBS — job cancel/delete + invoice void/DRAFT-delete driven through the real
 *      controllers (supertest), proving the wiring: correct anchors, inside the tx, before deletes.
 *
 * Edge matrix (implementation-plan §6): E7 mixed statuses, E8 multi-anchor returns once (CAS),
 * E9 invoice void the stranded-stock path, E10 job delete + SetNull orphan survives, E11 DRAFT
 * invoice survives job cancel untouched.
 *
 * The compare-and-set is the WHOLE point of returnProcessedLo, so its guard is revert-checked
 * below (see the two "double-return" tests): the stateful updateMany mock simulates the row's real
 * status, so removing `status: 'PROCESSED'` from the CAS makes those tests genuinely go RED rather
 * than pass on an order-based stub.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  ALPHA_ORG_ID,
  TEST_USERS,
  mockAuthAs,
  authHeader,
  JOB_FIXTURE,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import {
  collectAnchoredLoUnwind,
  applyAnchoredLoUnwind,
  returnProcessedLo,
  type LoLineRow,
  type LoUnwindInput,
} from '../lib/logisticOrders';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const LOC_A = INVENTORY_LOCATION_FIXTURE.id;
const ITEM_A = TRACKED_ITEM_FIXTURE.id;
const ADMIN_ID = TEST_USERS.admin.id;

const LO_PROC = 'bbbbbbb1-0000-0000-0000-000000000001';
const LO_DRAFT = 'bbbbbbb1-0000-0000-0000-000000000002';
const LO_APPR = 'bbbbbbb1-0000-0000-0000-000000000003';
const LINE_1 = 'bbbbbbb2-0000-0000-0000-000000000001';
const INV_ID = 'cccccccc-0000-0000-0000-000000000001';

const ITEM_ROW = { id: ITEM_A, sku: 'WIRE-12', name: '12ga Wire (ft)', unit_cost: 20 };

function loLine(over: Partial<LoLineRow> = {}): LoLineRow {
  return {
    id: LINE_1,
    item_id: ITEM_A,
    item_sku: 'WIRE-12',
    item_name: '12ga Wire (ft)',
    qty: 3,
    from_location_id: LOC_A,
    sequence: 0,
    ...over,
  };
}

/** A row shaped like collectAnchoredLoUnwind's findMany select. */
function loFindRow(over: Record<string, unknown> = {}) {
  return {
    id: LO_PROC,
    number: 'LO-J00001-1',
    status: 'PROCESSED',
    job_id: JOB_FIXTURE.id,
    organization_id: ALPHA_ORG_ID,
    lines: [loLine()],
    ...over,
  };
}

function unwindInput(over: Partial<LoUnwindInput> = {}): LoUnwindInput {
  return {
    id: LO_PROC,
    number: 'LO-J00001-1',
    organization_id: ALPHA_ORG_ID,
    job_id: JOB_FIXTURE.id,
    lines: [loLine()],
    actor: 'Ada Admin',
    actorUserId: ADMIN_ID,
    ...over,
  };
}

// A $transaction client wired to the same global spies (assert on mockPrisma.*). Distinct from the
// pool-discipline test below, which uses its OWN spies to prove tx-vs-global.
const txClient = {
  logisticOrder: {
    findMany: mockPrisma.logisticOrder.findMany,
    updateMany: mockPrisma.logisticOrder.updateMany,
    delete: mockPrisma.logisticOrder.delete,
    deleteMany: mockPrisma.logisticOrder.deleteMany,
  },
  logisticOrderLine: { deleteMany: mockPrisma.logisticOrderLine.deleteMany },
  priceBookItem: { findMany: mockPrisma.priceBookItem.findMany, findFirst: mockPrisma.priceBookItem.findFirst },
  inventoryLocation: { findFirst: mockPrisma.inventoryLocation.findFirst, findMany: mockPrisma.inventoryLocation.findMany },
  organization: { findUnique: mockPrisma.organization.findUnique },
  stockMovement: { create: mockPrisma.stockMovement.create },
  stockBalance: {
    upsert: mockPrisma.stockBalance.upsert,
    updateMany: mockPrisma.stockBalance.updateMany,
    findUnique: mockPrisma.stockBalance.findUnique,
  },
};

/**
 * Install a logisticOrder.updateMany mock that simulates the ROW'S REAL STATUS. This is what makes
 * the CAS revert-check honest: a returnProcessedLo CAS filtered on `status: 'PROCESSED'` matches
 * once (flipping the row to RETURNED), and a second call matches 0 — but only because the mock
 * reads the guard. Strip the guard from the source and every call matches → double write → RED.
 */
function installStatefulLoStatus(statuses: Record<string, string>): Record<string, string> {
  const state = { ...statuses };
  mockPrisma.logisticOrder.updateMany.mockImplementation((args: { where?: any; data?: any }) => {
    const where = args.where ?? {};
    const data = args.data ?? {};
    const ids: string[] = Array.isArray(where.id?.in)
      ? where.id.in
      : typeof where.id === 'string'
        ? [where.id]
        : Object.keys(state);
    let count = 0;
    for (const id of ids) {
      const cur = state[id];
      if (cur === undefined) continue;
      let ok = true;
      if (where.status !== undefined) {
        ok =
          typeof where.status === 'string'
            ? cur === where.status
            : Array.isArray(where.status.in) && where.status.in.includes(cur);
      }
      if (ok) {
        if (data.status) state[id] = data.status;
        count++;
      }
    }
    return Promise.resolve({ count });
  });
  return state;
}

const cancelUpdateManyCalls = () =>
  mockPrisma.logisticOrder.updateMany.mock.calls.filter(
    (c: [{ data?: { status?: string } }]) => c[0]?.data?.status === 'CANCELLED',
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // Reset to clean defaults — a mockImplementation set in a prior test survives clearAllMocks.
  mockPrisma.logisticOrder.findMany.mockResolvedValue([]);
  mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.priceBookItem.findMany.mockResolvedValue([ITEM_ROW]);
  mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 10, min: null });
  mockPrisma.inventoryLocation.findFirst.mockResolvedValue({ id: LOC_A });
  mockPrisma.organization.findUnique.mockResolvedValue({
    default_inventory_location_id: LOC_A,
    block_negative_stock: false,
  });
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(txClient) : Promise.all(arg as Promise<unknown>[]),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1 — engine helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('returnProcessedLo — compare-and-set idempotency (H1)', () => {
  it('returns exactly ONE set of movements when called twice in one tx (CAS double-return guard)', async () => {
    // Stateful status: first CAS flips PROCESSED→RETURNED, second finds RETURNED and no-ops.
    installStatefulLoStatus({ [LO_PROC]: 'PROCESSED' });

    const first = await returnProcessedLo(txClient as never, unwindInput());
    const second = await returnProcessedLo(txClient as never, unwindInput());

    expect(first).toBe(1);
    expect(second).toBe(0);
    // The load-bearing assertion — REVERT-CHECK TARGET. Strip `status: 'PROCESSED'` from the CAS
    // and the second call writes a second return movement, so this goes to 2 → RED.
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: 'return', qty: 3, to_location_id: LOC_A, logistic_order_id: LO_PROC });
  });
});

describe('collectAnchoredLoUnwind — resolution (pre-tx, tenancy)', () => {
  it('spreads organization_id into every clause and queries each clause separately', async () => {
    mockPrisma.logisticOrder.findMany.mockResolvedValue([]);

    await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: [{ job_id: JOB_FIXTURE.id }, { invoice_id: { in: [INV_ID] } }],
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });

    expect(mockPrisma.logisticOrder.findMany).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.logisticOrder.findMany.mock.calls) {
      // Tenancy is manual for LOs — organization_id is the ONLY gate (invariant 1).
      expect(call[0].where.organization_id).toBe(ALPHA_ORG_ID);
    }
    expect(mockPrisma.logisticOrder.findMany.mock.calls[0][0].where).toMatchObject({ job_id: JOB_FIXTURE.id });
    expect(mockPrisma.logisticOrder.findMany.mock.calls[1][0].where).toMatchObject({ invoice_id: { in: [INV_ID] } });
  });

  it('partitions PROCESSED (with lines) from open, and keeps per-clause duplicates', async () => {
    // Same LO surfaced by both clauses → enqueued TWICE on purpose (CAS collapses it later).
    mockPrisma.logisticOrder.findMany.mockResolvedValue([loFindRow()]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: [{ job_id: JOB_FIXTURE.id }, { invoice_id: { in: [INV_ID] } }],
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });

    expect(plan.processed).toHaveLength(2);
    expect(plan.processed[0]).toMatchObject({ id: LO_PROC, actor: 'Ada Admin', actorUserId: ADMIN_ID });
    expect(plan.processed[0].lines).toHaveLength(1);
    expect(plan.openLoIds).toEqual([]);
  });
});

describe('applyAnchoredLoUnwind — E8: multi-anchor LO returns exactly once', () => {
  it('collapses a duplicate (job + voided-invoice) return to one movement via the CAS', async () => {
    installStatefulLoStatus({ [LO_PROC]: 'PROCESSED' });
    // Both clauses surface the same PROCESSED LO → processed length 2 (both anchor paths).
    mockPrisma.logisticOrder.findMany.mockResolvedValue([loFindRow()]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: [{ job_id: JOB_FIXTURE.id }, { invoice_id: { in: [INV_ID] } }],
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });
    expect(plan.processed).toHaveLength(2);

    const result = await applyAnchoredLoUnwind(txClient as never, plan, { cancelOpen: true });

    expect(result.movementsWritten).toBe(1);
    expect(result.returnedLoIds).toEqual([LO_PROC]);
    // REVERT-CHECK TARGET — remove the CAS `status: 'PROCESSED'` guard and both enqueued copies
    // write a return movement → 2 → RED. This is the CAS's whole reason for existing.
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
  });
});

describe('applyAnchoredLoUnwind — E7: job-cancel mixed statuses', () => {
  it('returns the PROCESSED LO and CANCELS the open ones', async () => {
    const state = installStatefulLoStatus({
      [LO_PROC]: 'PROCESSED',
      [LO_DRAFT]: 'DRAFT',
      [LO_APPR]: 'APPROVED',
    });
    mockPrisma.logisticOrder.findMany.mockResolvedValue([
      loFindRow({ id: LO_PROC, status: 'PROCESSED' }),
      loFindRow({ id: LO_DRAFT, status: 'DRAFT', lines: [] }),
      loFindRow({ id: LO_APPR, status: 'APPROVED', lines: [] }),
    ]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: { job_id: JOB_FIXTURE.id },
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });
    expect(plan.processed).toHaveLength(1);
    expect(plan.openLoIds).toEqual(expect.arrayContaining([LO_DRAFT, LO_APPR]));

    const result = await applyAnchoredLoUnwind(txClient as never, plan, { cancelOpen: true });

    expect(result.returnedLoIds).toEqual([LO_PROC]);
    expect(result.cancelledLoIds).toEqual(expect.arrayContaining([LO_DRAFT, LO_APPR]));
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    // The PROCESSED one is now RETURNED, the open ones CANCELLED — different terminal states (H1).
    expect(state[LO_PROC]).toBe('RETURNED');
    expect(state[LO_DRAFT]).toBe('CANCELLED');
    expect(state[LO_APPR]).toBe('CANCELLED');
    const cancel = cancelUpdateManyCalls();
    expect(cancel).toHaveLength(1);
    expect(cancel[0][0].where.status).toEqual({ in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] });
    expect(cancel[0][0].data.cancelled_at).toBeInstanceOf(Date);
  });
});

describe('applyAnchoredLoUnwind — E9: invoice verbs leave open LOs alone', () => {
  it('returns PROCESSED but does NOT cancel open LOs when cancelOpen is false', async () => {
    const state = installStatefulLoStatus({ [LO_PROC]: 'PROCESSED', [LO_DRAFT]: 'DRAFT' });
    mockPrisma.logisticOrder.findMany.mockResolvedValue([
      loFindRow({ id: LO_PROC, status: 'PROCESSED' }),
      loFindRow({ id: LO_DRAFT, status: 'DRAFT', lines: [] }),
    ]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: { invoice_id: INV_ID },
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });

    const result = await applyAnchoredLoUnwind(txClient as never, plan, { cancelOpen: false });

    expect(result.returnedLoIds).toEqual([LO_PROC]);
    expect(result.cancelledLoIds).toEqual([]);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    // A void does not invalidate not-yet-processed intent — the DRAFT LO is untouched.
    expect(state[LO_DRAFT]).toBe('DRAFT');
    expect(cancelUpdateManyCalls()).toHaveLength(0);
  });
});

describe('applyAnchoredLoUnwind — E10: unwind never deletes the LO row', () => {
  it('returns the stock but leaves the LO row (it survives job delete via SetNull)', async () => {
    installStatefulLoStatus({ [LO_PROC]: 'PROCESSED' });
    mockPrisma.logisticOrder.findMany.mockResolvedValue([loFindRow()]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: { job_id: JOB_FIXTURE.id },
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });
    const result = await applyAnchoredLoUnwind(txClient as never, plan, { cancelOpen: true });

    expect(result.movementsWritten).toBe(1);
    // The historical document survives — the unwind flips status, it never deletes rows (E10).
    expect(mockPrisma.logisticOrder.delete).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrder.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.logisticOrderLine.deleteMany).not.toHaveBeenCalled();
  });
});

describe('applyAnchoredLoUnwind — empty plan is free', () => {
  it('touches no logistic-order delegate when nothing is anchored', async () => {
    const result = await applyAnchoredLoUnwind(
      txClient as never,
      { orgId: ALPHA_ORG_ID, processed: [], openLoIds: [] },
      { cancelOpen: true },
    );

    expect(result).toEqual({ returnedLoIds: [], cancelledLoIds: [], movementsWritten: 0 });
    expect(mockPrisma.logisticOrder.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe('pool discipline — apply writes through the tx client, never the global', () => {
  it('routes every unwind write to the tx spies, not the global prisma spies', async () => {
    installStatefulLoStatus({ [LO_PROC]: 'PROCESSED' });
    // Distinct tx spies (like inventory-tx-connection-isolation): reading the global impl at call
    // time keeps per-test setup working, but the SPY identity is distinct so we can prove routing.
    const txUpdateMany = vi.fn((...a: unknown[]) => mockPrisma.logisticOrder.updateMany(...a));
    const txMovementCreate = vi.fn((...a: unknown[]) => mockPrisma.stockMovement.create(...a));
    const txSpyClient = {
      ...txClient,
      logisticOrder: { ...txClient.logisticOrder, updateMany: txUpdateMany },
      stockMovement: { create: txMovementCreate },
    };
    mockPrisma.logisticOrder.findMany.mockResolvedValue([loFindRow()]);

    const plan = await collectAnchoredLoUnwind(prisma as never, {
      orgId: ALPHA_ORG_ID,
      where: [{ job_id: JOB_FIXTURE.id }, { invoice_id: { in: [INV_ID] } }],
      actor: 'Ada Admin',
      actorUserId: ADMIN_ID,
    });
    // The find is resolution — it runs on the GLOBAL client, before any tx.
    expect(mockPrisma.logisticOrder.findMany).toHaveBeenCalled();

    // Reset the global spies so we can prove apply() does not touch them directly.
    mockPrisma.logisticOrder.updateMany.mockClear();
    mockPrisma.stockMovement.create.mockClear();

    await applyAnchoredLoUnwind(txSpyClient as never, plan, { cancelOpen: true });

    expect(txUpdateMany).toHaveBeenCalled();
    expect(txMovementCreate).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2 — document verbs (real controllers, supertest)
// ═══════════════════════════════════════════════════════════════════════════

/** collect() queries the job clause and the voided-invoice clause separately. */
function loFindByAnchor(jobLos: unknown[], invoiceLos: unknown[] = []) {
  mockPrisma.logisticOrder.findMany.mockImplementation((args: { where?: any }) =>
    Promise.resolve(args.where?.job_id ? jobLos : invoiceLos),
  );
}

describe('POST /api/jobs/:id/cancel — LO unwind wiring (E7 / E11)', () => {
  it('returns the job PROCESSED LO and never queries the surviving DRAFT invoice (E11)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'IN_PROGRESS',
      invoices: [
        { id: 'inv-open-1', status: 'SENT', kind: 'STANDARD', amount_due: 100, total_amount: 100, payments: [], refunds: [] },
        // A DRAFT invoice is NOT voided by cancel — its LO must be left for its own verb (E11).
        { id: 'inv-draft-1', status: 'DRAFT', kind: 'STANDARD', amount_due: 50, total_amount: 50, payments: [], refunds: [] },
      ],
    });
    loFindByAnchor([loFindRow({ job_id: JOB_FIXTURE.id })], []);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'CANCELLED' }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: mockPrisma.priceBookItem.findMany },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        logisticOrder: { updateMany: mockPrisma.logisticOrder.updateMany },
      }),
    );

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    // The LO returned its stock inside the cancel tx.
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const movement = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement).toMatchObject({ type: 'return', qty: 3, logistic_order_id: LO_PROC, reference: 'LO-J00001-1 returned' });

    // E11: the invoice clause covers ONLY the cascade-voided (SENT) invoice, never the DRAFT one.
    const invoiceClauseCalls = mockPrisma.logisticOrder.findMany.mock.calls.filter(
      (c: [{ where?: { invoice_id?: { in?: string[] } } }]) => c[0].where?.invoice_id,
    );
    expect(invoiceClauseCalls).toHaveLength(1);
    expect(invoiceClauseCalls[0][0].where.invoice_id).toEqual({ in: ['inv-open-1'] });
    const anyClauseTouchesDraft = mockPrisma.logisticOrder.findMany.mock.calls.some((c: [{ where?: any }]) =>
      JSON.stringify(c[0].where ?? {}).includes('inv-draft-1'),
    );
    expect(anyClauseTouchesDraft).toBe(false);
  });
});

describe('DELETE /api/jobs/:id — LO unwind wiring (E10)', () => {
  it('returns the PROCESSED LO BEFORE the job row dies, and never deletes the LO', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED', invoices: [] });
    mockPrisma.job.delete.mockResolvedValue(JOB_FIXTURE);
    loFindByAnchor([loFindRow({ job_id: JOB_FIXTURE.id })]);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]) },
        priceBookItem: { findMany: mockPrisma.priceBookItem.findMany },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        logisticOrder: { updateMany: mockPrisma.logisticOrder.updateMany, delete: mockPrisma.logisticOrder.delete },
        job: { delete: mockPrisma.job.delete },
      }),
    );

    const res = await request(app).delete(`/api/jobs/${JOB_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      type: 'return',
      reference: 'LO-J00001-1 returned',
    });
    // Before-delete ordering: the movement FK must exist at insert; SetNull then keeps the row (E10).
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.job.delete.mock.invocationCallOrder[0],
    );
    // The LO row itself survives unanchored — the verb never deletes it.
    expect(mockPrisma.logisticOrder.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/void — LO unwind wiring (E9)', () => {
  it('returns the PROCESSED LO anchored to the invoice and leaves open LOs alone', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INV_ID,
      status: 'SENT',
      invoice_number: 'I00002',
      kind: 'STANDARD',
      total_amount: 1000,
      job_id: JOB_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      job: { assignees: [{ user_id: TEST_USERS.technician.id }], estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null } } },
    });
    // Invoice-anchored: one PROCESSED (returns), one DRAFT (must be left alone under void).
    mockPrisma.logisticOrder.findMany.mockResolvedValue([
      loFindRow({ id: LO_PROC, status: 'PROCESSED', job_id: null, number: 'LO-I00002-1' }),
      loFindRow({ id: LO_DRAFT, status: 'DRAFT', job_id: null, number: 'LO-I00002-2', lines: [] }),
    ]);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({ id: INV_ID, status: 'VOIDED', invoice_number: 'I00002' }) },
        job: { update: vi.fn().mockResolvedValue({}) },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        depositCreditApplication: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        payment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        priceBookItem: { findMany: mockPrisma.priceBookItem.findMany },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        logisticOrder: { updateMany: mockPrisma.logisticOrder.updateMany },
      }),
    );

    const res = await request(app)
      .post(`/api/invoices/${INV_ID}/void`)
      .set(authHeader('admin'))
      .send({ voided_reason: 'Wrong invoice' });

    expect(res.status).toBe(200);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      type: 'return',
      logistic_order_id: LO_PROC,
      reference: 'LO-I00002-1 returned',
    });
    // cancelOpen: false — the DRAFT LO is never flipped to CANCELLED by a void.
    expect(cancelUpdateManyCalls()).toHaveLength(0);
  });
});

describe('DELETE /api/invoices/:id — DRAFT delete LO unwind wiring', () => {
  it('returns the PROCESSED LO BEFORE the invoice row dies', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INV_ID,
      status: 'DRAFT',
      invoice_number: 'I00001',
      job_id: null,
      job: null,
    });
    mockPrisma.invoice.delete.mockResolvedValue({ id: INV_ID });
    mockPrisma.logisticOrder.findMany.mockResolvedValue([
      loFindRow({ id: LO_PROC, status: 'PROCESSED', job_id: null, number: 'LO-I00001-1' }),
    ]);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]) },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        priceBookItem: { findMany: mockPrisma.priceBookItem.findMany },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: { upsert: mockPrisma.stockBalance.upsert },
        organization: { findUnique: vi.fn().mockResolvedValue({ default_inventory_location_id: null }) },
        logisticOrder: { updateMany: mockPrisma.logisticOrder.updateMany },
        invoice: { delete: mockPrisma.invoice.delete },
      }),
    );

    const res = await request(app).delete(`/api/invoices/${INV_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.reference).toBe('LO-I00001-1 returned');
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.invoice.delete.mock.invocationCallOrder[0],
    );
  });
});
