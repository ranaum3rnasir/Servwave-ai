/**
 * inventory-usage-report.test.ts — P5 §3.1 pure service (activity-report doctrine:
 * no Prisma/Express, fixture-testable, honest zeros — cost is NEVER fabricated
 * for unpriced rows).
 *
 * buildInventoryUsageReport groups consume movements by item over a date range:
 * units (Σ qty, 2-dp), cost (Σ qty×unit_cost over PRICED rows only),
 * unpricedUnits (Σ qty of null-cost rows), movementCount, distinct jobs/invoices.
 */
import { describe, it, expect } from 'vitest';
import { buildInventoryUsageReport, type UsageMovementRow } from '../services/inventory-usage-report';

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-12-31T23:59:59Z');
const RANGE = { from: FROM, to: TO };

const ITEM_A = 'aaaaaaa2-0000-0000-0000-000000000001';
const ITEM_B = 'aaaaaaa2-0000-0000-0000-000000000002';
const JOB_1 = 'a1b2c3d4-0000-0000-0000-000000000001';
const JOB_2 = 'a1b2c3d4-0000-0000-0000-000000000002';
const INV_1 = 'a1b2c3d4-0000-0000-0000-000000000011';

function row(over: Partial<UsageMovementRow> = {}): UsageMovementRow {
  return {
    type: 'consume',
    occurredAt: new Date('2026-06-15T12:00:00Z'),
    itemId: ITEM_A,
    itemSku: 'LOCK-100',
    itemName: 'Deadbolt Lock',
    qty: 1,
    unitCost: 20,
    jobId: null,
    jobNumber: null,
    invoiceId: null,
    invoiceNumber: null,
    ...over,
  };
}

describe('buildInventoryUsageReport', () => {
  it('groups by item_id, with a sku: fallback key for orphaned/legacy rows (null item_id)', () => {
    const report = buildInventoryUsageReport(
      [
        row(),
        row(),
        row({ itemId: null, itemSku: 'GHOST-1', itemName: 'Deleted Widget' }),
        row({ itemId: null, itemSku: 'GHOST-1', itemName: 'Deleted Widget' }),
      ],
      RANGE,
    );
    expect(report.items).toHaveLength(2);
    const ghost = report.items.find((i) => i.sku === 'GHOST-1')!;
    expect(ghost.itemId).toBeNull();
    expect(ghost.name).toBe('Deleted Widget');
    expect(ghost.units).toBe(2);
    const lock = report.items.find((i) => i.sku === 'LOCK-100')!;
    expect(lock.itemId).toBe(ITEM_A);
    expect(lock.units).toBe(2);
  });

  it('sums fractional qtys Decimal-safely with 2-dp rounding at the end (0.1×3 → 0.3, not 0.30000000000000004)', () => {
    const report = buildInventoryUsageReport(
      [row({ qty: 0.1 }), row({ qty: 0.1 }), row({ qty: 0.1 }), row({ qty: 2.5 })],
      RANGE,
    );
    expect(report.items[0].units).toBe(2.8);
  });

  it('computes cost from movement snapshots over PRICED rows only; unpriced qty lands in unpricedUnits', () => {
    const report = buildInventoryUsageReport(
      [
        row({ qty: 2, unitCost: 12.5 }),   // 25.00
        row({ qty: 1.5, unitCost: 10 }),   // 15.00
        row({ qty: 3, unitCost: null }),   // honest: NOT costed
      ],
      RANGE,
    );
    const item = report.items[0];
    expect(item.cost).toBe(40);
    expect(item.unpricedUnits).toBe(3);
    expect(item.units).toBe(6.5);
    expect(item.movementCount).toBe(3);
  });

  it('dedups jobs and invoices per item (drill-through refs)', () => {
    const report = buildInventoryUsageReport(
      [
        row({ jobId: JOB_1, jobNumber: 'J00001' }),
        row({ jobId: JOB_1, jobNumber: 'J00001' }),
        row({ jobId: JOB_2, jobNumber: 'J00002', invoiceId: INV_1, invoiceNumber: 'I00001' }),
        row({ invoiceId: INV_1, invoiceNumber: 'I00001' }),
      ],
      RANGE,
    );
    const item = report.items[0];
    expect(item.jobs).toEqual([
      { id: JOB_1, jobNumber: 'J00001' },
      { id: JOB_2, jobNumber: 'J00002' },
    ]);
    expect(item.invoices).toEqual([{ id: INV_1, invoiceNumber: 'I00001' }]);
  });

  it('counts CONSUME movements only — receive/return/adjust rows are ignored (returns stay in the Action log)', () => {
    const report = buildInventoryUsageReport(
      [
        row({ qty: 4 }),
        row({ type: 'receive', qty: 100 }),
        row({ type: 'return', qty: 2 }),
        row({ type: 'adjust', qty: -3 }),
        row({ type: 'transfer', qty: 7 }),
      ],
      RANGE,
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0].units).toBe(4);
    expect(report.items[0].movementCount).toBe(1);
  });

  it('clips rows outside the [from,to] range', () => {
    const report = buildInventoryUsageReport(
      [
        row({ occurredAt: new Date('2025-12-31T23:59:59Z'), qty: 50 }), // before
        row({ occurredAt: new Date('2026-06-15T12:00:00Z'), qty: 2 }),  // inside
        row({ occurredAt: new Date('2027-01-01T00:00:00Z'), qty: 50 }), // after
      ],
      RANGE,
    );
    expect(report.items[0].units).toBe(2);
    expect(report.from).toBe(FROM.toISOString());
    expect(report.to).toBe(TO.toISOString());
  });

  it('sorts items by units desc', () => {
    const report = buildInventoryUsageReport(
      [
        row({ qty: 1 }),
        row({ itemId: ITEM_B, itemSku: 'WIRE-12', itemName: '12ga Wire (ft)', qty: 9 }),
      ],
      RANGE,
    );
    expect(report.items.map((i) => i.sku)).toEqual(['WIRE-12', 'LOCK-100']);
  });

  it('returns honest empties for a movement-less window', () => {
    const report = buildInventoryUsageReport([], RANGE);
    expect(report.items).toEqual([]);
  });
});
