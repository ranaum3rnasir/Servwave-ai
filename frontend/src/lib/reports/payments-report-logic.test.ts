import { describe, it, expect } from 'vitest';
import { buildPayments, BASE_MS, DAY, type PaymentTxn } from './payments-report-data';
import {
  resolveRange, priorRange, filterPayments, filterNoCategory,
  computeKpis, categoryBreakdown, weeklyTrend, filteredTotals,
} from './payments-report-logic';

const ALL = buildPayments();
const allRange = resolveRange('all');
const baseFilters = { search: '', methods: [], technicians: [], categories: [], statuses: [], range: allRange };

describe('payments-report-data', () => {
  it('is deterministic across builds', () => {
    expect(buildPayments()).toEqual(buildPayments());
  });
  it('produces a non-trivial dataset', () => {
    expect(ALL.length).toBeGreaterThan(40);
  });
});

describe('resolveRange', () => {
  it('today covers only the current day', () => {
    const r = resolveRange('today');
    expect(r.to - r.from).toBe(DAY - 1);
  });
  it('this-month starts on the 1st', () => {
    const r = resolveRange('this-month');
    expect(new Date(r.from).getUTCDate()).toBe(1);
  });
  it('all time is unbounded', () => {
    expect(resolveRange('all')).toEqual({ from: -Infinity, to: Infinity });
  });
});

describe('priorRange', () => {
  it('is the equally-sized window just before the range', () => {
    const r = resolveRange('30d');
    const p = priorRange(r)!;
    expect(p.to).toBe(r.from - 1);
    expect(r.to - r.from).toBe(p.to - p.from);
  });
  it('is null for unbounded ranges', () => {
    expect(priorRange(resolveRange('all'))).toBeNull();
  });
});

describe('filtering', () => {
  it('category filter only affects the full filter, not the base', () => {
    const f = { ...baseFilters, categories: ['Recurring'] };
    expect(filterNoCategory(ALL, f).length).toBe(ALL.length);
    expect(filterPayments(ALL, f).every((r) => r.category === 'Recurring')).toBe(true);
  });
  it('search matches id / client / email', () => {
    const one = ALL[0]!;
    const f = { ...baseFilters, search: one.id };
    expect(filterPayments(ALL, f).some((r) => r.id === one.id)).toBe(true);
  });
});

describe('computeKpis', () => {
  it('category buckets sum to total collected', () => {
    const k = computeKpis(ALL);
    const sum = Object.values(k.byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(k.collected, 2);
  });
  it('revenue (succeeded+pending) is at least collected (succeeded)', () => {
    const k = computeKpis(ALL);
    expect(k.revenue).toBeGreaterThanOrEqual(k.collected);
  });
});

describe('dashboard aggregation', () => {
  it('breakdown percentages sum to ~100 when there is revenue', () => {
    const rows = categoryBreakdown(ALL, ALL, null);
    const total = rows.reduce((a, r) => a + r.pct, 0);
    expect(total).toBeCloseTo(100, 0);
  });
  it('weekly trend has one row per week with all categories', () => {
    const t = weeklyTrend(ALL, 8);
    expect(t).toHaveLength(8);
    expect(t[0]).toHaveProperty('Invoice');
    expect(t[0]).toHaveProperty('Recurring');
  });
  it('totals sum amount and tips over the set', () => {
    const t = filteredTotals(ALL);
    expect(t.amount).toBeGreaterThan(0);
    expect(t.tips).toBeGreaterThanOrEqual(0);
  });
});

// #498 - when a paid deposit is applied as credit to the final invoice, the backend writes a
// synthetic payment row on the STANDARD invoice. It is the SAME money as the deposit payment, so
// it stays visible in the transaction table (it explains how the balance cleared) but must never
// be added to a total, or the deposit is counted twice.
describe('deposit-credit exclusion', () => {
  const txn = (over: Partial<PaymentTxn>): PaymentTxn => ({
    id: 'p', date: BASE_MS - DAY, amount: 150, tip: 0, method: 'Credit card',
    category: 'Deposit', status: 'Succeeded', client: 'Acme', email: '', card: '',
    technician: 'Dispatch', txnKind: 'Keyed', confirmation: '', isDepositCredit: false,
    ...over,
  });
  // $150 deposit, later credited against the final invoice. Real money collected: $150.
  const rows = [
    txn({ id: 'deposit', category: 'Deposit' }),
    txn({ id: 'credit', category: 'Invoice', isDepositCredit: true }),
  ];

  it('counts the deposit exactly once across every KPI', () => {
    const k = computeKpis(rows);
    expect(k.collected).toBe(150);
    expect(k.revenue).toBe(150);
    expect(k.byCategory.Deposit).toBe(150);
    expect(k.byCategory.Invoice).toBe(0);
  });

  it('keeps the credit out of the category breakdown', () => {
    const out = categoryBreakdown(rows, rows, null);
    expect(out.find((r) => r.category === 'Deposit')!.revenue).toBe(150);
    expect(out.find((r) => r.category === 'Invoice')!.revenue).toBe(0);
  });

  it('keeps the credit out of the weekly trend', () => {
    const week = weeklyTrend(rows, 8).at(-1)!;
    expect(week.Deposit).toBe(150);
    expect(week.Invoice).toBe(0);
  });

  it('keeps the credit out of the table footer total', () => {
    expect(filteredTotals(rows).amount).toBe(150);
  });

  it('still lists the credit row in the transaction table', () => {
    expect(filterPayments(rows, baseFilters).map((r) => r.id)).toContain('credit');
  });
});

describe('BASE_MS sanity', () => {
  it('matches app today (2026-06-07)', () => {
    expect(new Date(BASE_MS).toISOString().slice(0, 10)).toBe('2026-06-07');
  });
});

// #1222 - weeklyCollected/categoryBreakdown/weeklyTrend hardcoded BASE_MS as the window
// anchor with no override, so a real org's recent payments (anything after 2026-06-07)
// never land in any computed 8-week window. resolveRange already takes a `base` override
// for this exact reason (#1220/#1221) - these three needed the same treatment.
describe('weekly aggregation against a real-org "now"', () => {
  const txn = (over: Partial<PaymentTxn>): PaymentTxn => ({
    id: 'p', date: BASE_MS, amount: 500, tip: 0, method: 'Credit card',
    category: 'Invoice', status: 'Succeeded', client: 'Acme', email: '', card: '',
    technician: 'Dispatch', txnKind: 'Keyed', confirmation: '', isDepositCredit: false,
    ...over,
  });
  // A real org's "today", months past the fixed demo anchor.
  const now = BASE_MS + 90 * DAY;
  const rows = [txn({ id: 'recent', date: now - DAY })];

  it('weeklyTrend surfaces a payment dated near a non-BASE_MS now', () => {
    const week = weeklyTrend(rows, 8, now).at(-1)!;
    expect(week.Invoice).toBe(500);
  });

  it('categoryBreakdown sparkline surfaces a payment dated near a non-BASE_MS now', () => {
    const out = categoryBreakdown(rows, rows, null, now);
    expect(out.find((r) => r.category === 'Invoice')!.trend.at(-1)).toBe(500);
  });

  it('defaults to BASE_MS so the demo path is unaffected', () => {
    const week = weeklyTrend(rows, 8).at(-1)!;
    expect(week.Invoice).toBe(0);
  });
});
