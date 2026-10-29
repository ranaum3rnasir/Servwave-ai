// ───────────────────────────────────────────────────────────────────────────
// Payments report — pure aggregation logic (no React, fully testable).
// Resolves date presets, splits current vs prior window, sums KPIs, builds the
// per-category dashboard + weekly trend, and filters the transaction list.
// ───────────────────────────────────────────────────────────────────────────
import {
  BASE_MS,
  DAY,
  PAYMENT_CATEGORIES,
  type PaymentCategory,
  type PaymentTxn,
} from './payments-report-data';

// ── Date presets ─────────────────────────────────────────────────────────────
export type DatePreset =
  | 'this-month'
  | 'today'
  | 'yesterday'
  | '7d'
  | '14d'
  | '30d'
  | 'last-month'
  | 'this-year'
  | 'last-year'
  | '3m'
  | '6m'
  | '12m'
  | 'all'
  | 'custom';

export const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '14d', label: 'Last 14 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
  { key: '3m', label: 'Last 3 months' },
  { key: '6m', label: 'Last six months' },
  { key: '12m', label: 'Last twelve months' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

export interface Range {
  from: number; // inclusive epoch ms (-Infinity = open)
  to: number; // inclusive epoch ms (Infinity = open)
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const endOfDay = (ms: number) => startOfDay(ms) + DAY - 1;

/** Resolve a preset (and custom inputs) into an inclusive [from, to] range. */
export function resolveRange(
  preset: DatePreset,
  customFrom?: string,
  customTo?: string,
  base = BASE_MS,
): Range {
  const d = new Date(base);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();

  switch (preset) {
    case 'today':
      return { from: startOfDay(base), to: endOfDay(base) };
    case 'yesterday':
      return { from: startOfDay(base - DAY), to: endOfDay(base - DAY) };
    case '7d':
      return { from: startOfDay(base - 6 * DAY), to: endOfDay(base) };
    case '14d':
      return { from: startOfDay(base - 13 * DAY), to: endOfDay(base) };
    case '30d':
      return { from: startOfDay(base - 29 * DAY), to: endOfDay(base) };
    case 'this-month':
      return { from: Date.UTC(y, m, 1), to: endOfDay(base) };
    case 'last-month':
      return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) - 1 };
    case 'this-year':
      return { from: Date.UTC(y, 0, 1), to: endOfDay(base) };
    case 'last-year':
      return { from: Date.UTC(y - 1, 0, 1), to: Date.UTC(y, 0, 1) - 1 };
    case '3m':
      return { from: startOfDay(base) - 90 * DAY, to: endOfDay(base) };
    case '6m':
      return { from: startOfDay(base) - 182 * DAY, to: endOfDay(base) };
    case '12m':
      return { from: startOfDay(base) - 365 * DAY, to: endOfDay(base) };
    case 'custom':
      return {
        from: customFrom ? new Date(customFrom + 'T00:00:00Z').getTime() : -Infinity,
        to: customTo ? new Date(customTo + 'T23:59:59.999Z').getTime() : Infinity,
      };
    case 'all':
    default:
      return { from: -Infinity, to: Infinity };
  }
}

/** The equally-sized window immediately before `range` (for Δ vs last period). */
export function priorRange(range: Range): Range | null {
  if (!isFinite(range.from) || !isFinite(range.to)) return null;
  const len = range.to - range.from;
  return { from: range.from - len - 1, to: range.from - 1 };
}

const inRange = (ms: number, r: Range) => ms >= r.from && ms <= r.to;

// ── Filtering ────────────────────────────────────────────────────────────────
export interface PaymentFilters {
  search: string;
  methods: string[];
  technicians: string[];
  categories: string[];
  statuses: string[];
  range: Range;
}

/** Apply every dimension EXCEPT category — so the category KPI cards keep
 *  showing their real totals and stay usable as a category switcher. */
export function filterNoCategory(rows: PaymentTxn[], f: PaymentFilters): PaymentTxn[] {
  const q = f.search.trim().toLowerCase();
  return rows
    .filter((r) => inRange(r.date, f.range))
    .filter((r) => f.methods.length === 0 || f.methods.includes(r.method))
    .filter((r) => f.technicians.length === 0 || f.technicians.includes(r.technician))
    .filter((r) => f.statuses.length === 0 || f.statuses.includes(r.status))
    .filter(
      (r) =>
        q === '' ||
        r.client.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.id.includes(q),
    );
}

/** Full filter (adds the category dimension) — drives the transaction table. */
export function filterPayments(rows: PaymentTxn[], f: PaymentFilters): PaymentTxn[] {
  return filterNoCategory(rows, f).filter(
    (r) => f.categories.length === 0 || f.categories.includes(r.category),
  );
}

// ── KPI + category aggregation ───────────────────────────────────────────────
/**
 * #498 - drop deposit-credit applications before summing. When a paid deposit is credited to the
 * final invoice, the backend writes a synthetic payment row on that invoice for the same dollars
 * already banked on the deposit row. Adding both counts the deposit twice. These rows stay in the
 * transaction table (they show how the balance cleared) and are stripped only from money totals,
 * so every sum in this module funnels through here.
 */
export const countable = (rows: PaymentTxn[]) => rows.filter((r) => !r.isDepositCredit);
const sumAmount = (rows: PaymentTxn[]) => countable(rows).reduce((a, r) => a + r.amount, 0);
const collected = (rows: PaymentTxn[]) => rows.filter((r) => r.status === 'Succeeded');

export interface Kpis {
  revenue: number; // all (Succeeded + Pending)
  collected: number; // Succeeded
  byCategory: Record<PaymentCategory, number>; // Succeeded, per category
}

export function computeKpis(rows: PaymentTxn[]): Kpis {
  const billed = rows.filter((r) => r.status === 'Succeeded' || r.status === 'Pending');
  const ok = collected(rows);
  const byCategory = Object.fromEntries(
    PAYMENT_CATEGORIES.map((c) => [c, sumAmount(ok.filter((r) => r.category === c))]),
  ) as Record<PaymentCategory, number>;
  return { revenue: sumAmount(billed), collected: sumAmount(ok), byCategory };
}

const pctDelta = (cur: number, prev: number): number | null => {
  if (prev <= 0) return cur > 0 ? 100 : null;
  return ((cur - prev) / prev) * 100;
};

export interface CategoryRow {
  category: PaymentCategory;
  revenue: number;
  pct: number; // share of total collected
  delta: number | null; // vs prior window
  trend: number[]; // 8-week sparkline (collected per week)
}

/** Per-category dashboard rows for the current window, with Δ vs prior window
 *  and an 8-week collected-per-week sparkline (from the full dataset). */
export function categoryBreakdown(
  all: PaymentTxn[],
  current: PaymentTxn[],
  prior: PaymentTxn[] | null,
  now = BASE_MS,
): CategoryRow[] {
  const curOk = collected(current);
  const priorOk = prior ? collected(prior) : [];
  const total = sumAmount(curOk) || 1;
  return PAYMENT_CATEGORIES.map((category) => {
    const revenue = sumAmount(curOk.filter((r) => r.category === category));
    const prevRev = sumAmount(priorOk.filter((r) => r.category === category));
    return {
      category,
      revenue,
      pct: (revenue / total) * 100,
      delta: prior ? pctDelta(revenue, prevRev) : null,
      trend: weeklyCollected(all, category, 8, now),
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** Collected $ per week for one category, last `weeks` weeks ending at `now`
 *  (defaults to the demo anchor BASE_MS). */
export function weeklyCollected(all: PaymentTxn[], category: PaymentCategory, weeks: number, now = BASE_MS): number[] {
  const ok = collected(all).filter((r) => r.category === category);
  const out: number[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const to = now - w * 7 * DAY;
    const from = to - 7 * DAY;
    out.push(sumAmount(ok.filter((r) => r.date > from && r.date <= to)));
  }
  return out;
}

/** Weekly trend rows for the multi-line chart: [{ week:'W1', Invoice, Deposit, … }]. */
export function weeklyTrend(all: PaymentTxn[], weeks = 8, now = BASE_MS): Record<string, number | string>[] {
  const series = Object.fromEntries(
    PAYMENT_CATEGORIES.map((c) => [c, weeklyCollected(all, c, weeks, now)]),
  ) as Record<PaymentCategory, number[]>;
  return Array.from({ length: weeks }, (_, i) => {
    const row: Record<string, number | string> = { week: `W${i + 1}` };
    for (const c of PAYMENT_CATEGORIES) row[c] = Math.round(series[c][i] ?? 0);
    return row;
  });
}

export interface FilteredTotals {
  amount: number;
  tips: number;
}
export function filteredTotals(rows: PaymentTxn[]): FilteredTotals {
  // countable(): the footer is a money total, so a deposit-credit row shown in the table above
  // must not be added into it (#498).
  return countable(rows).reduce(
    (acc, r) => {
      acc.amount += r.amount;
      acc.tips += r.tip;
      return acc;
    },
    { amount: 0, tips: 0 },
  );
}
