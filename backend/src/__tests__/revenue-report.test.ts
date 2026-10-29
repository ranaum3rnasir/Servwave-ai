import { describe, it, expect } from 'vitest';
import { buildRevenueReport, type RevenueInputs } from '../services/revenue-report';

function inputs(over: Partial<RevenueInputs>): RevenueInputs {
  return { completed: [], invoiced: [], collected: [], ...over };
}

const d = (iso: string) => new Date(iso);

describe('buildRevenueReport', () => {
  it('returns an empty series and zeroed totals with no events', () => {
    const r = buildRevenueReport(inputs({}));
    expect(r.series).toEqual([]);
    expect(r.totals).toEqual({
      completed: 0,
      invoiced: 0,
      collected: 0,
      collectionRate: 0,
      outstanding: 0,
    });
  });

  it('buckets each stream into its own month independently', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [{ date: d('2026-04-10T00:00:00Z'), amount: 1000 }],
        invoiced: [{ date: d('2026-04-20T00:00:00Z'), amount: 800 }],
        collected: [{ date: d('2026-04-25T00:00:00Z'), amount: 600 }],
      }),
    );
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({ month: '2026-04', label: 'Apr 26', completed: 1000, invoiced: 800, collected: 600 });
  });

  it('sums multiple events that fall in the same month', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [
          { date: d('2026-05-01T00:00:00Z'), amount: 100 },
          { date: d('2026-05-15T00:00:00Z'), amount: 250 },
        ],
      }),
    );
    expect(r.series[0]?.completed).toBe(350);
  });

  it('fills gap months at zero so the axis is contiguous', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [
          { date: d('2026-01-10T00:00:00Z'), amount: 500 },
          { date: d('2026-03-10T00:00:00Z'), amount: 700 },
        ],
      }),
    );
    expect(r.series.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.series[1]).toMatchObject({ month: '2026-02', completed: 0, invoiced: 0, collected: 0 });
  });

  it('spans the earliest-to-latest month across all three streams', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [{ date: d('2026-02-10T00:00:00Z'), amount: 1 }],
        invoiced: [{ date: d('2026-01-10T00:00:00Z'), amount: 1 }],
        collected: [{ date: d('2026-04-10T00:00:00Z'), amount: 1 }],
      }),
    );
    expect(r.series.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('crosses a year boundary in order', () => {
    const r = buildRevenueReport(
      inputs({
        invoiced: [
          { date: d('2025-12-10T00:00:00Z'), amount: 1 },
          { date: d('2026-01-10T00:00:00Z'), amount: 1 },
        ],
      }),
    );
    expect(r.series.map((p) => p.month)).toEqual(['2025-12', '2026-01']);
    expect(r.series.map((p) => p.label)).toEqual(['Dec 25', 'Jan 26']);
  });

  it('drops null-dated events', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [
          { date: null, amount: 9999 },
          { date: d('2026-06-10T00:00:00Z'), amount: 100 },
        ],
      }),
    );
    expect(r.series).toHaveLength(1);
    expect(r.series[0]?.completed).toBe(100);
  });

  it('computes totals, collection rate, and outstanding', () => {
    const r = buildRevenueReport(
      inputs({
        completed: [{ date: d('2026-05-01T00:00:00Z'), amount: 1000 }],
        invoiced: [{ date: d('2026-05-01T00:00:00Z'), amount: 800 }],
        collected: [{ date: d('2026-05-01T00:00:00Z'), amount: 600 }],
      }),
    );
    expect(r.totals.completed).toBe(1000);
    expect(r.totals.invoiced).toBe(800);
    expect(r.totals.collected).toBe(600);
    expect(r.totals.collectionRate).toBeCloseTo(75);
    expect(r.totals.outstanding).toBe(200);
  });

  it('collection rate is 0 when nothing was invoiced', () => {
    const r = buildRevenueReport(
      inputs({ collected: [{ date: d('2026-05-01T00:00:00Z'), amount: 500 }] }),
    );
    expect(r.totals.collectionRate).toBe(0);
    expect(r.totals.outstanding).toBe(-500);
  });
});
