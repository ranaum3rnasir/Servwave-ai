import { describe, it, expect } from 'vitest';
import { calculateCostSummary, resolveOverhead } from './costModel';

describe('calculateCostSummary', () => {
  it('sums item cost across line items and priced scopes, applies labor hours × rate, and a percentage overhead on revenue', () => {
    const summary = calculateCostSummary(
      [
        { quantity: 2, unit_cost: 50 }, // 100
        { quantity: 1, unit_cost: 30 }, // 30
      ],
      [
        { flat_price: 500, internal_cost: 200 }, // priced scope: 200 cost
        { flat_price: null, internal_cost: 999 }, // no flat_price -> excluded entirely
      ],
      10, // labor hours
      25, // $/hr
      { mode: 'PERCENTAGE', value: 10 },
      1000, // revenue excl tax
    );

    expect(summary.itemCost).toBe(330); // 100 + 30 + 200
    expect(summary.laborCost).toBe(250); // 10 * 25
    expect(summary.overheadAmount).toBe(100); // 10% of 1000
    expect(summary.totalCost).toBe(680); // 330 + 250 + 100
    expect(summary.profitAmount).toBe(320); // 1000 - 680
    expect(summary.profitPercent).toBe(32); // 320 / 1000 * 100
  });

  it('uses a FIXED overhead amount instead of a percentage of revenue', () => {
    const summary = calculateCostSummary(
      [{ quantity: 1, unit_cost: 100 }],
      [],
      0,
      0,
      { mode: 'FIXED', value: 75 },
      500,
    );
    expect(summary.overheadAmount).toBe(75);
    expect(summary.totalCost).toBe(175); // 100 item + 0 labor + 75 overhead
  });

  it('treats a null/undefined unit_cost or internal_cost as $0, not excluded from the ratio', () => {
    const summary = calculateCostSummary(
      [{ quantity: 5, unit_cost: null }],
      [{ flat_price: 200, internal_cost: null }],
      0,
      0,
      { mode: 'FIXED', value: 0 },
      1000,
    );
    expect(summary.itemCost).toBe(0);
    expect(summary.profitAmount).toBe(1000);
    expect(summary.profitPercent).toBe(100);
  });

  it('reports profitPercent as null (never 100%) when revenue is 0', () => {
    const summary = calculateCostSummary([], [], 0, 0, { mode: 'FIXED', value: 0 }, 0);
    expect(summary.profitPercent).toBeNull();
    expect(summary.profitAmount).toBe(0);
  });

  it('labor cost is hours × rate, independent of any line item_type — no MATERIAL/SERVICE split', () => {
    const summary = calculateCostSummary(
      [{ quantity: 1, unit_cost: 0 }],
      [],
      8,
      45,
      { mode: 'FIXED', value: 0 },
      1000,
    );
    expect(summary.laborCost).toBe(360);
  });
});

describe('resolveOverhead', () => {
  it('uses the estimate-level override when BOTH overhead_mode and overhead_value are set', () => {
    const cfg = resolveOverhead(
      { overhead_mode: 'FIXED', overhead_value: 150 },
      { overhead_mode: 'PERCENTAGE', overhead_value: 10 },
    );
    expect(cfg).toEqual({ mode: 'FIXED', value: 150 });
  });

  it('falls back to the org default when the estimate has no override', () => {
    const cfg = resolveOverhead(
      { overhead_mode: null, overhead_value: null },
      { overhead_mode: 'PERCENTAGE', overhead_value: 12 },
    );
    expect(cfg).toEqual({ mode: 'PERCENTAGE', value: 12 });
  });

  it('falls back to the org default when only ONE of mode/value is set on the estimate (partial override does not count)', () => {
    const cfg = resolveOverhead(
      { overhead_mode: 'FIXED', overhead_value: null },
      { overhead_mode: 'PERCENTAGE', overhead_value: 20 },
    );
    expect(cfg).toEqual({ mode: 'PERCENTAGE', value: 20 });
  });

  it('defaults to PERCENTAGE/0 when neither the estimate nor the org has anything set', () => {
    const cfg = resolveOverhead({}, undefined);
    expect(cfg).toEqual({ mode: 'PERCENTAGE', value: 0 });
  });
});
