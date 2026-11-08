/**
 * Logistic Orders — processing engine (`lib/logisticOrders.ts`).
 *
 * These tests drive the shared engine DIRECTLY rather than through a route: the engine is
 * the foundation every LO surface builds on, and pinning its contract here keeps the
 * controller suite free to test HTTP shape only.
 *
 * Edge matrix covered (implementation-plan §6): E1 CAS, E2 block-mode aggregate,
 * E3 warn-mode, E4 multi-location, E5 missing location, E6 SetNull'd item, E14 the
 * PROCESSED line-ops table, E27 low-stock alert.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID,
  TEST_USERS,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
  JOB_FIXTURE,
} from './helpers';
import {
  processLogisticOrder,
  returnProcessedLo,
  applyProcessedLineDiff,
  loActorContext,
  AggregateShortageError,
  LoLineValidationError,
  LoStatusError,
  LoNotFoundError,
  LoItemSwapError,
  type LoLineRow,
} from '../lib/logisticOrders';

// emitLowStockIfCrossing is fire-and-forget from inside applyStockMovement; mock the
// module so E27 is assertable without standing up the whole notification pipeline.
vi.mock('../services/notifications/inventoryEmit', () => ({
  emitLowStockIfCrossing: vi.fn(),
  emitStockApprovalRequested: vi.fn(),
}));
import { emitLowStockIfCrossing } from '../services/notifications/inventoryEmit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000001';
const LINE_1 = 'bbbbbbb2-0000-0000-0000-000000000001';
const LINE_2 = 'bbbbbbb2-0000-0000-0000-000000000002';
const LOC_A = INVENTORY_LOCATION_FIXTURE.id;
const LOC_B = 'aaaaaaa1-0000-0000-0000-000000000002';
const ITEM_A = TRACKED_ITEM_FIXTURE.id;
const ITEM_B = 'aaaaaaa2-0000-0000-0000-000000000003';
const LO_NUMBER = 'LO-J00001-1';

const ITEM_B_ROW = {
  ...TRACKED_ITEM_FIXTURE,
  id: ITEM_B,
  sku: 'CONDUIT-1',
  name: '1in Conduit',
  unit_cost: 7,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let txClient: Record<string, any>;

function setupTransaction() {
  txClient = {
    logisticOrder: {
      updateMany: mockPrisma.logisticOrder.updateMany,
      update: mockPrisma.logisticOrder.update,
      findFirst: mockPrisma.logisticOrder.findFirst,
    },
    logisticOrderLine: {
      findMany: mockPrisma.logisticOrderLine.findMany,
      create: mockPrisma.logisticOrderLine.create,
      update: mockPrisma.logisticOrderLine.update,
      deleteMany: mockPrisma.logisticOrderLine.deleteMany,
    },
    priceBookItem: {
      findFirst: mockPrisma.priceBookItem.findFirst,
      findMany: mockPrisma.priceBookItem.findMany,
    },
    inventoryLocation: { findMany: mockPrisma.inventoryLocation.findMany },
    organization: { findUnique: mockPrisma.organization.findUnique },
    stockMovement: { create: mockPrisma.stockMovement.create },
    stockBalance: {
      findMany: mockPrisma.stockBalance.findMany,
      upsert: mockPrisma.stockBalance.upsert,
      updateMany: mockPrisma.stockBalance.updateMany,
      findUnique: mockPrisma.stockBalance.findUnique,
    },
  };

  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(txClient);
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function fakeReq(): Request {
  const u = TEST_USERS.admin;
  return {
    user: {
      id: u.id,
      organization_id: ALPHA_ORG_ID,
      role: 'ADMIN',
      first_name: 'Ada',
      last_name: 'Admin',
    },
  } as unknown as Request;
}

function loLine(over: Partial<LoLineRow> = {}): LoLineRow {
  return {
    id: LINE_1,
    item_id: ITEM_A,
    item_sku: TRACKED_ITEM_FIXTURE.sku,
    item_name: TRACKED_ITEM_FIXTURE.name,
    qty: 3,
    from_location_id: LOC_A,
    sequence: 0,
    ...over,
  };
}

function loRow(over: Record<string, unknown> = {}) {
  return {
    id: LO_ID,
    number: LO_NUMBER,
    status: 'APPROVED',
    job_id: JOB_FIXTURE.id,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    lines: [loLine()],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupTransaction();

  mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow());
  mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.logisticOrderLine.update.mockResolvedValue({});

  // Warn-mode defaults: negatives allowed, item + location resolve, plenty on hand.
  mockPrisma.organization.findUnique.mockResolvedValue({
    block_negative_stock: false,
    default_inventory_location_id: LOC_A,
  });
  mockPrisma.priceBookItem.findMany.mockResolvedValue([TRACKED_ITEM_FIXTURE, ITEM_B_ROW]);
  mockPrisma.inventoryLocation.findMany.mockResolvedValue([
    { id: LOC_A, name: 'Main Warehouse' },
    { id: LOC_B, name: 'Van 2' },
  ]);
  mockPrisma.stockBalance.findMany.mockResolvedValue([]);
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 7, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('processLogisticOrder — happy path', () => {
  it('consumes each line and stamps every LO ref on the movement', async () => {
    const result = await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(result.status).toBe('PROCESSED');
    expect(result.number).toBe(LO_NUMBER);
    expect(result.lines).toHaveLength(1);

    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      type: 'consume',
      qty: 3,
      item_id: ITEM_A,
      item_sku: TRACKED_ITEM_FIXTURE.sku,
      from_location_id: LOC_A,
      // H2: the ledger row carries the LO, the LO LINE, and the LO's job anchor.
      logistic_order_id: LO_ID,
      logistic_order_line_id: LINE_1,
      job_id: JOB_FIXTURE.id,
      reference: LO_NUMBER,
      organization_id: ALPHA_ORG_ID,
    });
    expect(data.actor_user_id).toBe(TEST_USERS.admin.id);
    // occurred_at = processing time (spec §5 — settles the date axis).
    expect(data.occurred_at).toBeInstanceOf(Date);
  });

  it('claims the status atomically, org-scoped, before writing any movement (E1 CAS)', async () => {
    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: LO_ID, organization_id: ALPHA_ORG_ID });
    expect(claim.where.status).toEqual({ in: ['APPROVED'] });
    expect(claim.data.status).toBe('PROCESSED');

    expect(mockPrisma.logisticOrder.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.stockMovement.create.mock.invocationCallOrder[0],
    );
  });

  it('writes the balance BEFORE the movement row (block-mode refusals leave no ledger row)', async () => {
    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(mockPrisma.stockBalance.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.stockMovement.create.mock.invocationCallOrder[0],
    );
  });

  it('resolves items and the org policy on the GLOBAL client, before $transaction opens', async () => {
    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    const txOrder = mockPrisma.$transaction.mock.invocationCallOrder[0];
    expect(mockPrisma.logisticOrder.findFirst.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.organization.findUnique.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.priceBookItem.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
    expect(mockPrisma.inventoryLocation.findMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder);
  });

  it('scopes the pre-tx load to the caller org (canAccessRow is NOT a tenancy gate for LOs)', async () => {
    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(mockPrisma.logisticOrder.findFirst.mock.calls[0][0].where).toMatchObject({
      id: LO_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('404s a cross-org / unknown id instead of processing it', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(null);

    await expect(processLogisticOrder(prisma as never, fakeReq(), LO_ID)).rejects.toBeInstanceOf(
      LoNotFoundError,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('fast-forward stamps submitted/approved/processed in one claim (E20)', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    await processLogisticOrder(prisma as never, fakeReq(), LO_ID, {
      allowedFromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
      fastForward: true,
    });

    const data = mockPrisma.logisticOrder.updateMany.mock.calls[0][0].data;
    expect(data.submitted_at).toBeInstanceOf(Date);
    expect(data.approved_at).toBeInstanceOf(Date);
    expect(data.processed_at).toBeInstanceOf(Date);
    expect(data.submitted_by).toBe(TEST_USERS.admin.id);
    expect(data.approved_by).toBe(TEST_USERS.admin.id);
    expect(data.processed_by).toBe(TEST_USERS.admin.id);
  });

  it('fast-forward never overwrites an existing submitted_at', async () => {
    const submitted = new Date('2026-01-01T00:00:00.000Z');
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ status: 'PENDING_APPROVAL', submitted_at: submitted, submitted_by: 'user-x' }),
    );

    await processLogisticOrder(prisma as never, fakeReq(), LO_ID, {
      allowedFromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
      fastForward: true,
    });

    const data = mockPrisma.logisticOrder.updateMany.mock.calls[0][0].data;
    expect(data.submitted_at).toBe(submitted);
    expect(data.submitted_by).toBe('user-x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E1 — concurrent process (compare-and-set)', () => {
  it('throws LoStatusError and writes nothing when the CAS matches 0 rows', async () => {
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 0 });

    await expect(processLogisticOrder(prisma as never, fakeReq(), LO_ID)).rejects.toBeInstanceOf(
      LoStatusError,
    );
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a pre-tx status that is not in allowedFromStatuses', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ status: 'DRAFT' }));

    await expect(processLogisticOrder(prisma as never, fakeReq(), LO_ID)).rejects.toBeInstanceOf(
      LoStatusError,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E4 — same item, two lines, two locations', () => {
  it('writes one consume movement per line, each against its own location', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [
          loLine({ id: LINE_1, from_location_id: LOC_A, qty: 3, sequence: 0 }),
          loLine({ id: LINE_2, from_location_id: LOC_B, qty: 2, sequence: 1 }),
        ],
      }),
    );

    const result = await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(result.lines).toHaveLength(2);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(2);
    const locs = mockPrisma.stockMovement.create.mock.calls.map(
      (c: [{ data: { from_location_id: string } }]) => c[0].data.from_location_id,
    );
    expect(locs).toEqual([LOC_A, LOC_B]);
    const lineRefs = mockPrisma.stockMovement.create.mock.calls.map(
      (c: [{ data: { logistic_order_line_id: string } }]) => c[0].data.logistic_order_line_id,
    );
    expect(lineRefs).toEqual([LINE_1, LINE_2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E2 — block mode: aggregate pre-check', () => {
  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      block_negative_stock: true,
      default_inventory_location_id: LOC_A,
    });
  });

  it('aggregates two lines pulling the SAME item+location before comparing to on_hand', async () => {
    // 6 + 4 = 10 requested against 8 on hand. Each line ALONE would pass — only the
    // aggregate catches it, which is the whole point of the pre-check.
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [
          loLine({ id: LINE_1, qty: 6, sequence: 0 }),
          loLine({ id: LINE_2, qty: 4, sequence: 1 }),
        ],
      }),
    );
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      { item_id: ITEM_A, location_id: LOC_A, on_hand: 8 },
    ]);

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(AggregateShortageError);
    expect(err.details).toEqual([
      expect.objectContaining({
        itemId: ITEM_A,
        itemSku: TRACKED_ITEM_FIXTURE.sku,
        itemName: TRACKED_ITEM_FIXTURE.name,
        locationId: LOC_A,
        locationName: 'Main Warehouse',
        requested: 10,
        onHand: 8,
      }),
    ]);
    // The contract that makes the aggregate check worth having: NOTHING is written.
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockBalance.updateMany).not.toHaveBeenCalled();
  });

  it('reports EVERY short line, not just the first (the signed per-line contract)', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [
          loLine({ id: LINE_1, item_id: ITEM_A, qty: 9, from_location_id: LOC_A, sequence: 0 }),
          loLine({
            id: LINE_2,
            item_id: ITEM_B,
            item_sku: ITEM_B_ROW.sku,
            item_name: ITEM_B_ROW.name,
            qty: 5,
            from_location_id: LOC_B,
            sequence: 1,
          }),
        ],
      }),
    );
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      { item_id: ITEM_A, location_id: LOC_A, on_hand: 1 },
      { item_id: ITEM_B, location_id: LOC_B, on_hand: 0 },
    ]);

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(AggregateShortageError);
    expect(err.details).toHaveLength(2);
    expect(err.details.map((d: { itemId: string }) => d.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('treats a missing balance row as 0 available', async () => {
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(AggregateShortageError);
    expect(err.details[0]).toMatchObject({ requested: 3, onHand: 0 });
  });

  it('proceeds when the aggregate fits', async () => {
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      { item_id: ITEM_A, location_id: LOC_A, on_hand: 50 },
    ]);

    const result = await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(result.status).toBe('PROCESSED');
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    // Block mode still uses the conditional-atomic decrement as the race backstop.
    expect(mockPrisma.stockBalance.updateMany).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E3 — warn mode', () => {
  it('proceeds negative and reports per-line warnings in the payload', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [
          loLine({ id: LINE_1, qty: 6, sequence: 0 }),
          loLine({ id: LINE_2, from_location_id: LOC_B, qty: 2, sequence: 1 }),
        ],
      }),
    );
    mockPrisma.stockBalance.upsert
      .mockResolvedValueOnce({ on_hand: -2, min: null })
      .mockResolvedValueOnce({ on_hand: 4, min: null });

    const result = await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(result.status).toBe('PROCESSED');
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(2);
    expect(result.lines[0]).toMatchObject({ onHandAfter: -2, shortage: true });
    expect(result.lines[1]).toMatchObject({ onHandAfter: 4, shortage: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].lineId).toBe(LINE_1);
  });

  it('never runs the aggregate balance pre-check in warn mode', async () => {
    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);
    expect(mockPrisma.stockBalance.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E5 / E6 — pre-tx line validation (422)', () => {
  it('rejects a line with no from_location and never opens a transaction (E5)', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({ lines: [loLine({ from_location_id: null })] }),
    );

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(LoLineValidationError);
    expect(err.details).toEqual([
      expect.objectContaining({
        lineId: LINE_1,
        reason: 'MISSING_LOCATION',
        itemSku: TRACKED_ITEM_FIXTURE.sku,
      }),
    ]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a from_location outside the org', async () => {
    mockPrisma.inventoryLocation.findMany.mockResolvedValue([]);

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(LoLineValidationError);
    expect(err.details[0]).toMatchObject({ reason: 'UNKNOWN_LOCATION', lineId: LINE_1 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("names the SNAPSHOT sku when the line's catalog item was SetNull'd (E6)", async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [loLine({ item_id: null, item_sku: 'WIRE-12', item_name: '12ga Wire (ft)' })],
      }),
    );

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(LoLineValidationError);
    expect(err.details[0]).toMatchObject({ reason: 'ITEM_UNAVAILABLE', itemSku: 'WIRE-12' });
    // The whole point: without this guard applyStockMovement writes a ledger row and
    // deducts NOTHING (the `if (input.itemId)` gate), silently under-consuming.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('names the snapshot sku when the item id survives but the row is gone / cross-org', async () => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([]);

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(LoLineValidationError);
    expect(err.details[0]).toMatchObject({
      reason: 'ITEM_UNAVAILABLE',
      itemSku: TRACKED_ITEM_FIXTURE.sku,
    });
  });

  it('reports every bad line at once, not just the first', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(
      loRow({
        lines: [
          loLine({ id: LINE_1, from_location_id: null }),
          loLine({ id: LINE_2, item_id: null, item_sku: 'GONE-1', sequence: 1 }),
        ],
      }),
    );

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err.details).toHaveLength(2);
    expect(err.details.map((d: { reason: string }) => d.reason)).toEqual([
      'MISSING_LOCATION',
      'ITEM_UNAVAILABLE',
    ]);
  });

  it('rejects an LO with no lines', async () => {
    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow({ lines: [] }));

    const err = await processLogisticOrder(prisma as never, fakeReq(), LO_ID).catch((e) => e);

    expect(err).toBeInstanceOf(LoLineValidationError);
    expect(err.details[0]).toMatchObject({ reason: 'NO_LINES', lineId: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E27 — low-stock alert', () => {
  it('fires via applyStockMovement when the consume crosses the min', async () => {
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 2, min: 5 });

    await processLogisticOrder(prisma as never, fakeReq(), LO_ID);

    expect(emitLowStockIfCrossing).toHaveBeenCalledWith(
      ALPHA_ORG_ID,
      ITEM_A,
      TRACKED_ITEM_FIXTURE.name,
      LOC_A,
      2,
      -3,
      5,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('returnProcessedLo — the single unwind (H1)', () => {
  const unwind = (over: Record<string, unknown> = {}) => ({
    id: LO_ID,
    number: LO_NUMBER,
    organization_id: ALPHA_ORG_ID,
    job_id: JOB_FIXTURE.id,
    lines: [loLine()],
    actor: 'Ada Admin',
    actorUserId: TEST_USERS.admin.id,
    ...over,
  });

  it('CASes PROCESSED→RETURNED and writes one return movement per line', async () => {
    const written = await returnProcessedLo(txClient as never, unwind());

    expect(written).toBe(1);
    const claim = mockPrisma.logisticOrder.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({
      id: LO_ID,
      status: 'PROCESSED',
      organization_id: ALPHA_ORG_ID,
    });
    expect(claim.data).toEqual({ status: 'RETURNED' });

    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      type: 'return',
      qty: 3,
      to_location_id: LOC_A,
      logistic_order_id: LO_ID,
      logistic_order_line_id: LINE_1,
      job_id: JOB_FIXTURE.id,
      reference: `${LO_NUMBER} returned`,
    });
  });

  it('is a no-op when the CAS matches 0 rows — E8 multi-anchor double-return', async () => {
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 0 });

    const written = await returnProcessedLo(txClient as never, unwind());

    expect(written).toBe(0);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('returns exactly once when called twice inside one transaction (E8)', async () => {
    // Stateful + status-aware, NOT an order-based stub: the mock simulates the row's real status so
    // the CAS `where: { status: 'PROCESSED' }` is what decides the count. First call finds PROCESSED
    // (flips it to RETURNED, count 1); the second finds RETURNED and matches 0. An order-based
    // `.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0})` passes even with the guard
    // stripped — this does not. REVERT-CHECK TARGET: remove `status: 'PROCESSED'` from
    // returnProcessedLo's CAS where clause and both calls match → 2 movements → RED.
    const status: Record<string, string> = { [LO_ID]: 'PROCESSED' };
    mockPrisma.logisticOrder.updateMany.mockImplementation(
      (args: { where?: { id?: string; status?: string }; data?: { status?: string } }) => {
        const where = args.where ?? {};
        const id = typeof where.id === 'string' ? where.id : undefined;
        const cur = id ? status[id] : undefined;
        if (cur === undefined) return Promise.resolve({ count: 0 });
        // Undefined status in the where clause = the guard was stripped: the CAS no longer constrains
        // status, so it matches unconditionally (the exact mutation the revert-check exercises).
        const statusOk = where.status === undefined || cur === where.status;
        if (!statusOk) return Promise.resolve({ count: 0 });
        if (args.data?.status) status[id!] = args.data.status;
        return Promise.resolve({ count: 1 });
      },
    );

    const first = await returnProcessedLo(txClient as never, unwind());
    const second = await returnProcessedLo(txClient as never, unwind());

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
  });

  it('skips a line whose catalog item was hard-deleted, and still returns the others', async () => {
    const written = await returnProcessedLo(
      txClient as never,
      unwind({
        lines: [
          loLine({ id: LINE_1, item_id: null }),
          loLine({ id: LINE_2, item_id: ITEM_A, sequence: 1 }),
        ],
      }),
    );

    expect(written).toBe(1);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stockMovement.create.mock.calls[0][0].data.logistic_order_line_id).toBe(
      LINE_2,
    );
  });

  it("falls back to the org default when the line's location was deleted", async () => {
    await returnProcessedLo(
      txClient as never,
      unwind({ lines: [loLine({ from_location_id: null })] }),
    );

    const data = mockPrisma.stockMovement.create.mock.calls[0][0].data;
    expect(data.to_location_id).toBe(LOC_A);
    expect(data.reference).toBe(`${LO_NUMBER} returned (original location deleted)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E14 — applyProcessedLineDiff (the PROCESSED line-ops table)', () => {
  const actor = () => loActorContext(fakeReq(), false);
  const lo = (lines: LoLineRow[]) => ({
    id: LO_ID,
    number: LO_NUMBER,
    job_id: JOB_FIXTURE.id,
    lines,
  });

  const movements = () =>
    mockPrisma.stockMovement.create.mock.calls.map(
      (c: [{ data: Record<string, unknown> }]) => c[0].data,
    );

  it('qty increase → consumes the delta', async () => {
    await applyProcessedLineDiff(
      txClient as never,
      lo([loLine({ qty: 3 })]),
      [{ id: LINE_1, item_id: ITEM_A, qty: 5, from_location_id: LOC_A }],
      actor(),
    );

    expect(movements()).toEqual([
      expect.objectContaining({
        type: 'consume',
        qty: 2,
        from_location_id: LOC_A,
        logistic_order_line_id: LINE_1,
        reference: `${LO_NUMBER} edited`,
      }),
    ]);
  });

  it('qty decrease → returns the delta', async () => {
    await applyProcessedLineDiff(
      txClient as never,
      lo([loLine({ qty: 5 })]),
      [{ id: LINE_1, item_id: ITEM_A, qty: 2, from_location_id: LOC_A }],
      actor(),
    );

    expect(movements()).toEqual([
      expect.objectContaining({ type: 'return', qty: 3, to_location_id: LOC_A }),
    ]);
  });

  it('removed line → returns the full qty BEFORE the row is deleted (FK ordering)', async () => {
    await applyProcessedLineDiff(txClient as never, lo([loLine({ qty: 4 })]), [], actor());

    expect(movements()).toEqual([
      expect.objectContaining({ type: 'return', qty: 4, logistic_order_line_id: LINE_1 }),
    ]);
    expect(mockPrisma.logisticOrderLine.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.stockMovement.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.logisticOrderLine.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('added line → creates the row first, then consumes the full qty (FK ordering)', async () => {
    mockPrisma.logisticOrderLine.create.mockResolvedValue({ id: LINE_2 });

    await applyProcessedLineDiff(
      txClient as never,
      lo([]),
      [{ item_id: ITEM_A, qty: 7, from_location_id: LOC_B }],
      actor(),
    );

    expect(mockPrisma.logisticOrderLine.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.logisticOrderLine.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.stockMovement.create.mock.invocationCallOrder[0],
    );
    expect(movements()).toEqual([
      expect.objectContaining({
        type: 'consume',
        qty: 7,
        from_location_id: LOC_B,
        logistic_order_line_id: LINE_2,
      }),
    ]);
  });

  it('location change → returns the old location and consumes the new', async () => {
    await applyProcessedLineDiff(
      txClient as never,
      lo([loLine({ qty: 3, from_location_id: LOC_A })]),
      [{ id: LINE_1, item_id: ITEM_A, qty: 3, from_location_id: LOC_B }],
      actor(),
    );

    expect(movements()).toEqual([
      expect.objectContaining({ type: 'return', qty: 3, to_location_id: LOC_A }),
      expect.objectContaining({ type: 'consume', qty: 3, from_location_id: LOC_B }),
    ]);
  });

  it('item swap on an existing line → rejected (delete + re-add instead)', async () => {
    await expect(
      applyProcessedLineDiff(
        txClient as never,
        lo([loLine({ item_id: ITEM_A })]),
        [{ id: LINE_1, item_id: ITEM_B, qty: 3, from_location_id: LOC_A }],
        actor(),
      ),
    ).rejects.toBeInstanceOf(LoItemSwapError);

    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('an unchanged line moves nothing', async () => {
    await applyProcessedLineDiff(
      txClient as never,
      lo([loLine({ qty: 3, from_location_id: LOC_A })]),
      [{ id: LINE_1, item_id: ITEM_A, qty: 3, from_location_id: LOC_A }],
      actor(),
    );

    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('posts returns BEFORE consumes so a net-neutral edit cannot false-trip block mode', async () => {
    mockPrisma.logisticOrderLine.create.mockResolvedValue({ id: LINE_2 });
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      { item_id: ITEM_A, location_id: LOC_A, on_hand: 4 },
    ]);

    await applyProcessedLineDiff(
      txClient as never,
      lo([loLine({ id: LINE_1, qty: 5, from_location_id: LOC_A })]),
      [
        { id: LINE_1, item_id: ITEM_A, qty: 1, from_location_id: LOC_A },
        { item_id: ITEM_A, qty: 4, from_location_id: LOC_A },
      ],
      { ...actor(), blockNegative: true },
    );

    const types = movements().map((m: { type: string }) => m.type);
    expect(types).toEqual(['return', 'consume']);
    // The block-mode balance read must happen AFTER the return is posted.
    expect(mockPrisma.stockBalance.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockPrisma.stockMovement.create.mock.invocationCallOrder[0],
    );
  });

  it('block mode refuses the consume side with an aggregate 409', async () => {
    mockPrisma.stockBalance.findMany.mockResolvedValue([
      { item_id: ITEM_A, location_id: LOC_A, on_hand: 1 },
    ]);

    await expect(
      applyProcessedLineDiff(
        txClient as never,
        lo([loLine({ qty: 3 })]),
        [{ id: LINE_1, item_id: ITEM_A, qty: 9, from_location_id: LOC_A }],
        { ...actor(), blockNegative: true },
      ),
    ).rejects.toBeInstanceOf(AggregateShortageError);
  });

  it('rejects an incoming line id that does not belong to this LO', async () => {
    await expect(
      applyProcessedLineDiff(
        txClient as never,
        lo([loLine({ id: LINE_1 })]),
        [{ id: LINE_2, item_id: ITEM_A, qty: 1, from_location_id: LOC_A }],
        actor(),
      ),
    ).rejects.toBeInstanceOf(LoLineValidationError);
  });

  it('rejects a new line with no from_location', async () => {
    await expect(
      applyProcessedLineDiff(
        txClient as never,
        lo([]),
        [{ item_id: ITEM_A, qty: 2, from_location_id: null }],
        actor(),
      ),
    ).rejects.toBeInstanceOf(LoLineValidationError);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a payload that lists the same existing line id twice, moving nothing', async () => {
    // A duplicated existing id applies its qty delta once PER occurrence — two consume
    // movements against a row written once — silently desyncing the ledger. The diff must
    // see each existing line at most once, so a repeated id is a 422, not two deductions.
    // REVERT-CHECK TARGET: remove the dedup guard at the top of applyProcessedLineDiff and
    // the two occurrences each post a consume of the same delta → 2 movements → RED.
    await expect(
      applyProcessedLineDiff(
        txClient as never,
        lo([loLine({ id: LINE_1, qty: 3, from_location_id: LOC_A })]),
        [
          { id: LINE_1, item_id: ITEM_A, qty: 5, from_location_id: LOC_A },
          { id: LINE_1, item_id: ITEM_A, qty: 5, from_location_id: LOC_A },
        ],
        actor(),
      ),
    ).rejects.toBeInstanceOf(LoLineValidationError);

    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
